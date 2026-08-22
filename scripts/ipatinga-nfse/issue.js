'use strict';

const { CONFIG, sanitize } = require('./config');
const { readSheetValues, appendSheetValues, updateSheetValues } = require('./google');
const {
  loadLedger,
  findLedgerEntry,
  allocateRpsAtomically,
  markSubmitting,
  markIssued,
  markUnknownAfterTimeout,
  markFailedSafe,
  RPS_STATUS
} = require('./ledger');
const { prepareDemand, demandRows, tomadorRows, patternRows } = require('./prepare');
const { validateXmlAgainstOfficialXsd } = require('./xsd-validator');
const { signXmlNode, verifyXmlSignature } = require('./xmldsig');
const { executeSoapRequest } = require('./soap');
const { buildCabecalho, parseConsultarNfseResposta } = require('./abrasf');
const { getXmlNode, getXmlValue, parseXml } = require('./xml');

/**
 * Monta o payload ConsultarNfsePorRpsEnvio
 */
function buildConsultarNfsePorRpsEnvio({ rpsNumero, rpsSerie = 'A', rpsTipo = '1', cnpj = null, im = null }) {
  const cnpjClean = cnpj || CONFIG.PRESTADOR.CNPJ_DIGITS;
  const imClean = im || CONFIG.PRESTADOR.INSCRICAO_MUNICIPAL;

  return `<ConsultarNfsePorRpsEnvio xmlns="${CONFIG.ABRASF.SCHEMA_NAMESPACE}">` +
    `<IdentificacaoRps>` +
      `<Numero>${rpsNumero}</Numero>` +
      `<Serie>${rpsSerie}</Serie>` +
      `<Tipo>${rpsTipo}</Tipo>` +
    `</IdentificacaoRps>` +
    `<Prestador>` +
      `<CpfCnpj><Cnpj>${cnpjClean}</Cnpj></CpfCnpj>` +
      `<InscricaoMunicipal>${imClean}</InscricaoMunicipal>` +
    `</Prestador>` +
  `</ConsultarNfsePorRpsEnvio>`;
}

/**
 * Parse da resposta oficial de GerarNfseResposta
 */
function parseGerarNfseResposta(xmlString) {
  const parsed = parseXml(xmlString);
  const root = getXmlNode(parsed, ['GerarNfseResposta', 'tc:GerarNfseResposta']) || parsed;

  const listaNfse = getXmlNode(root, ['ListaNfse', 'tc:ListaNfse']);
  const compNfse = getXmlNode(root, ['CompNfse', 'tc:CompNfse']) || (listaNfse && getXmlNode(listaNfse, ['CompNfse', 'tc:CompNfse']));
  const nfse = compNfse ? (getXmlNode(compNfse, ['Nfse', 'tc:Nfse']) || compNfse) : null;
  const infNfse = nfse ? (getXmlNode(nfse, ['InfNfse', 'tc:InfNfse']) || nfse) : null;

  const listaMensagem = getXmlNode(root, ['ListaMensagemRetorno', 'tc:ListaMensagemRetorno', 'ListaMensagensRetorno', 'tc:ListaMensagensRetorno']);

  const numero = infNfse ? getXmlValue(infNfse, ['Numero', 'tc:Numero']) : null;
  const codigoVerificacao = infNfse ? getXmlValue(infNfse, ['CodigoVerificacao', 'tc:CodigoVerificacao']) : null;
  const dataEmissao = infNfse ? getXmlValue(infNfse, ['DataEmissao', 'tc:DataEmissao']) : null;

  const mensagens = [];
  if (listaMensagem) {
    const msgs = Array.isArray(listaMensagem.MensagemRetorno) ? listaMensagem.MensagemRetorno : [listaMensagem.MensagemRetorno];
    for (const m of msgs.filter(Boolean)) {
      mensagens.push({
        codigo: getXmlValue(m, ['Codigo', 'tc:Codigo']),
        mensagem: getXmlValue(m, ['Mensagem', 'tc:Mensagem']),
        correcao: getXmlValue(m, ['Correcao', 'tc:Correcao'])
      });
    }
  }

  return {
    hasNfse: Boolean(numero && codigoVerificacao),
    numero: numero ? String(numero).trim() : null,
    codigoVerificacao: codigoVerificacao ? String(codigoVerificacao).trim() : null,
    dataEmissao: dataEmissao ? String(dataEmissao).trim() : null,
    mensagens
  };
}

/**
 * Executa a operação GerarNfse em Homologação com exatamente-once garantido
 */
async function issueHomologation({ requestId, itemIndex = 1, certData, dryRun = false }, dependencies = {}) {
  // Trava de segurança redundante: JAMAIS em produção
  if (process.env.INPUT_ENVIRONMENT === 'production') {
    throw new Error('PRODUCTION_ISSUE_DISABLED: Emissão de NFS-e em produção está estritamente bloqueada.');
  }

  if (!certData || !certData.loaded || !certData.isValid) {
    throw new Error('CERT_INVALID: Emissão requer certificado A1 válido.');
  }

  const read = dependencies.readSheetValues || readSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;

  // 1. Carrega dados de negócio e prepara a demanda
  const [demandasRaw, tomadoresRaw, patternsRaw, notasRaw] = await Promise.all([
    read(spreadsheetId, `${CONFIG.SHEETS.TABS.DEMANDAS}!A:Z`),
    read(spreadsheetId, `${CONFIG.SHEETS.TABS.TOMADORES}!A:J`),
    read(spreadsheetId, `${CONFIG.SHEETS.TABS.PADROES}!A:T`),
    read(spreadsheetId, `${CONFIG.SHEETS.TABS.NOTAS}!A:X`)
  ]);

  const prepared = prepareDemand({
    requestId,
    demandas: demandRows(demandasRaw),
    tomadores: tomadorRows(tomadoresRaw),
    patterns: patternRows(patternsRaw),
    notas: notasRaw
  });

  if (prepared.validationStatus !== 'READY_TO_ISSUE' || !prepared.candidates.length) {
    throw new Error(`PREPARE_NOT_READY: ${prepared.blockingReasons.join(', ')}`);
  }

  const candidate = prepared.candidates[itemIndex - 1];
  if (!candidate) {
    throw new Error(`CANDIDATE_INDEX_OUT_OF_BOUNDS: index ${itemIndex}`);
  }

  // 2. Consulta Ledger
  let ledgerEntries = await loadLedger(dependencies);
  let ledgerEntry = findLedgerEntry(ledgerEntries, {
    environment: 'homologation',
    requestId,
    itemIndex
  });

  // 3. Verifica estado atual do Ledger
  if (ledgerEntry && ledgerEntry.status === RPS_STATUS.ISSUED) {
    return {
      status: 'ALREADY_ISSUED',
      environment: 'homologation',
      requestId,
      itemIndex,
      rpsNumero: ledgerEntry.rps_numero,
      nfseNumero: ledgerEntry.nfse_numero,
      nfseChave: ledgerEntry.nfse_chave,
      message: 'Nota já emitida anteriormente para este request_id e item_index (idempotente).'
    };
  }

  // 4. Se estava em UNKNOWN_AFTER_TIMEOUT: NÃO chamar GerarNfse; recuperar via ConsultarNfsePorRps
  if (ledgerEntry && ledgerEntry.status === RPS_STATUS.UNKNOWN_AFTER_TIMEOUT) {
    const consultarRpsXml = buildConsultarNfsePorRpsEnvio({
      rpsNumero: ledgerEntry.rps_numero,
      rpsSerie: ledgerEntry.rps_serie,
      rpsTipo: ledgerEntry.rps_tipo
    });

    const cabecalho = buildCabecalho();
    const queryRes = await executeSoapRequest({
      endpointUrl: CONFIG.ENDPOINTS.homologation.url,
      soapAction: 'nfs#ConsultarNfsePorRps',
      operation: 'ConsultarNfsePorRps',
      cabecalhoXml: cabecalho,
      dadosXml: consultarRpsXml,
      certData
    });

    const parsedQuery = parseConsultarNfseResposta(queryRes.rawXml);
    if (parsedQuery.notas && parsedQuery.notas.length > 0) {
      const nota = parsedQuery.notas[0];
      await markIssued(ledgerEntry, { nfseNumero: nota.numero, nfseChave: nota.codigoVerificacao }, dependencies);
      return {
        status: 'ISSUED',
        environment: 'homologation',
        requestId,
        itemIndex,
        rpsNumero: ledgerEntry.rps_numero,
        nfseNumero: nota.numero,
        nfseChave: nota.codigoVerificacao,
        recoveredViaRpsQuery: true
      };
    }

    throw new Error('TIMEOUT_UNCONFIRMED: Nota ainda não confirmada pela prefeitura após consulta por RPS.');
  }

  // 5. Alocação Atômica e Persistência do ALLOCATED
  if (!ledgerEntry) {
    if (!dryRun) {
      ledgerEntry = await allocateRpsAtomically({
        environment: 'homologation',
        requestId,
        itemIndex,
        series: 'A',
        type: '1'
      }, dependencies);
    } else {
      ledgerEntry = {
        environment: 'homologation',
        request_id: requestId,
        item_index: String(itemIndex),
        rps_numero: '1001',
        rps_serie: 'A',
        rps_tipo: '1',
        status: RPS_STATUS.ALLOCATED
      };
    }
  }

  candidate.rpsNumero = ledgerEntry.rps_numero;
  candidate.rpsSerie = ledgerEntry.rps_serie;
  candidate.rpsTipo = ledgerEntry.rps_tipo;
  candidate.xmlId = `RPS${ledgerEntry.rps_numero}${ledgerEntry.rps_serie.replace(/[^A-Za-z0-9]/g, '')}`;

  // 6. Monta XML com elementos e tags oficiais ABRASF 2.04 / Ipatinga
  const itemLista = String(candidate.codigoTribNacional || '').split('.').slice(0, 2).join('.');
  const codMunPrestacao = candidate.codigoMunicipioPrestacao || '3128006';
  
  const unsignedXml = `<GerarNfseEnvio xmlns="http://www.abrasf.org.br/nfse.xsd">` +
    `<Rps>` +
      `<InfDeclaracaoPrestacaoServico Id="${candidate.xmlId}">` +
        `<Rps>` +
          `<IdentificacaoRps>` +
            `<Numero>${candidate.rpsNumero}</Numero>` +
            `<Serie>${candidate.rpsSerie}</Serie>` +
            `<Tipo>${candidate.rpsTipo}</Tipo>` +
          `</IdentificacaoRps>` +
          `<DataEmissao>${candidate.dataEmissao}</DataEmissao>` +
          `<Status>1</Status>` +
        `</Rps>` +
        `<Competencia>${candidate.competenciaData}</Competencia>` +
        `<Servico>` +
          `<Valores>` +
            `<ValorServicos>${candidate.valor.toFixed(2)}</ValorServicos>` +
            `<ValorDeducoes>0</ValorDeducoes>` +
            `<ValorPis>0</ValorPis>` +
            `<ValorCofins>0</ValorCofins>` +
            `<ValorInss>0</ValorInss>` +
            `<ValorIr>0</ValorIr>` +
            `<ValorCsll>0</ValorCsll>` +
            `<OutrasRetencoes>0</OutrasRetencoes>` +
            `<ValTotTributos>0</ValTotTributos>` +
            `<ValorIss>0</ValorIss>` +
            `<Aliquota>0.0000</Aliquota>` +
            `<DescontoIncondicionado>0</DescontoIncondicionado>` +
            `<DescontoCondicionado>0</DescontoCondicionado>` +
          `</Valores>` +
          `<IssRetido>2</IssRetido>` +
          `<ItemListaServico>${itemLista}</ItemListaServico>` +
          `<CodigoCnae>8610701</CodigoCnae>` +
          `<CodigoTributacaoMunicipio>${candidate.codigoTribMunicipal}</CodigoTributacaoMunicipio>` +
          `<Discriminacao>${candidate.descricao}</Discriminacao>` +
          `<CodigoMunicipio>${codMunPrestacao}</CodigoMunicipio>` +
          `<CodigoPais>1058</CodigoPais>` +
          `<ExigibilidadeISS>1</ExigibilidadeISS>` +
          `<MunicipioIncidencia>${codMunPrestacao}</MunicipioIncidencia>` +
        `</Servico>` +
        `<Prestador>` +
          `<CpfCnpj><Cnpj>${CONFIG.PRESTADOR.CNPJ_DIGITS}</Cnpj></CpfCnpj>` +
          `<InscricaoMunicipal>${CONFIG.PRESTADOR.INSCRICAO_MUNICIPAL}</InscricaoMunicipal>` +
        `</Prestador>` +
        `<TomadorServico>` +
          `<IdentificacaoTomador>` +
            `<CpfCnpj><Cnpj>${candidate.cnpjTomador}</Cnpj></CpfCnpj>` +
          `</IdentificacaoTomador>` +
          `<RazaoSocial>${candidate.tomador}</RazaoSocial>` +
        `</TomadorServico>` +
        `<OptanteSimplesNacional>${CONFIG.PRESTADOR.OPTANTE_SIMPLES_NACIONAL}</OptanteSimplesNacional>` +
        `<IncentivoFiscal>2</IncentivoFiscal>` +
      `</InfDeclaracaoPrestacaoServico>` +
    `</Rps>` +
  `</GerarNfseEnvio>`;

  // 7. Assina com XMLDSig real (W3C Canonical XML 1.0)
  const signedXml = signXmlNode({
    xml: unsignedXml,
    targetId: candidate.xmlId,
    pemKey: certData.pemKey,
    pemCert: certData.pemCert
  });

  // 8. Verificação criptográfica independente
  const sigValid = verifyXmlSignature({ signedXml, pemCert: certData.pemCert });
  if (!sigValid) {
    throw new Error('XMLDSIG_VERIFICATION_FAILED: Assinatura XML gerada é criptograficamente inválida.');
  }

  // 9. Validação XSD real contra schema_2.04.xsd oficial
  const xsdValidation = await validateXmlAgainstOfficialXsd(signedXml, 'GerarNfseEnvio');
  if (!xsdValidation.valid) {
    throw new Error(`XSD_VALIDATION_FAILED: ${xsdValidation.errors.join('; ')}`);
  }

  if (dryRun) {
    return {
      status: 'DRY_RUN_SUCCESS',
      environment: 'homologation',
      requestId,
      itemIndex,
      rpsNumero: candidate.rpsNumero,
      rpsSerie: candidate.rpsSerie,
      rpsTipo: candidate.rpsTipo,
      xmlCandidate: signedXml,
      xsdValidation: 'VALIDATED_OFFICIAL_XSD',
      xmlSignature: 'VALIDATED_XMLDSIG_C14N',
      gerarNfseCalls: 0
    };
  }

  // 10. Persiste estado SUBMITTING antes da chamada SOAP
  await markSubmitting(ledgerEntry, dependencies);

  // 11. Chamada SOAP GerarNfse
  const cabecalho = buildCabecalho();
  let responseXml = null;
  let timeoutOccurred = false;

  try {
    const soapRes = await executeSoapRequest({
      endpointUrl: CONFIG.ENDPOINTS.homologation.url,
      soapAction: 'nfs#GerarNfse',
      operation: 'GerarNfse',
      cabecalhoXml: cabecalho,
      dadosXml: signedXml,
      certData
    });
    responseXml = soapRes.rawXml;
  } catch (err) {
    if (String(err.message).includes('TIMEOUT') || String(err.message).includes('ECONNRESET')) {
      timeoutOccurred = true;
    } else {
      await markFailedSafe(ledgerEntry, { error: err.message }, dependencies);
      throw err;
    }
  }

  // 12. Tratamento de timeout / resposta ambígua
  if (timeoutOccurred || !responseXml) {
    await markUnknownAfterTimeout(ledgerEntry, { error: 'TIMEOUT_ON_GERARNFSE' }, dependencies);

    // Tenta recuperação imediata via ConsultarNfsePorRps
    const consultarRpsXml = buildConsultarNfsePorRpsEnvio({
      rpsNumero: candidate.rpsNumero,
      rpsSerie: candidate.rpsSerie,
      rpsTipo: candidate.rpsTipo
    });

    const queryRes = await executeSoapRequest({
      endpointUrl: CONFIG.ENDPOINTS.homologation.url,
      soapAction: 'nfs#ConsultarNfsePorRps',
      operation: 'ConsultarNfsePorRps',
      cabecalhoXml: cabecalho,
      dadosXml: consultarRpsXml,
      certData
    });

    const parsedQuery = parseConsultarNfseResposta(queryRes.rawXml);
    if (parsedQuery.notas && parsedQuery.notas.length > 0) {
      const nota = parsedQuery.notas[0];
      await markIssued(ledgerEntry, { nfseNumero: nota.numero, nfseChave: nota.codigoVerificacao }, dependencies);
      return {
        status: 'ISSUED',
        environment: 'homologation',
        requestId,
        itemIndex,
        rpsNumero: candidate.rpsNumero,
        nfseNumero: nota.numero,
        nfseChave: nota.codigoVerificacao,
        recoveredViaRpsQuery: true
      };
    }

    throw new Error('TIMEOUT_UNCONFIRMED: Emissão em homologação ficou inconclusiva após timeout e consulta por RPS.');
  }

  // 13. Parse oficial da resposta GerarNfseResposta
  const parsedGerar = parseGerarNfseResposta(responseXml);
  if (!parsedGerar.hasNfse) {
    const errorMsg = parsedGerar.mensagens.map(m => `[${m.codigo}] ${m.mensagem}`).join('; ') || 'SEM_DADOS_NFSE';
    await markFailedSafe(ledgerEntry, { error: errorMsg }, dependencies);
    throw new Error(`GERAR_NFSE_REJECTED: ${errorMsg}`);
  }

  await markIssued(ledgerEntry, { nfseNumero: parsedGerar.numero, nfseChave: parsedGerar.codigoVerificacao }, dependencies);

  return {
    status: 'ISSUED',
    environment: 'homologation',
    requestId,
    itemIndex,
    rpsNumero: candidate.rpsNumero,
    rpsSerie: candidate.rpsSerie,
    rpsTipo: candidate.rpsTipo,
    nfseNumero: parsedGerar.numero,
    nfseChave: parsedGerar.codigoVerificacao,
    dataEmissao: parsedGerar.dataEmissao,
    mensagens: parsedGerar.mensagens
  };
}

module.exports = {
  buildConsultarNfsePorRpsEnvio,
  parseGerarNfseResposta,
  issueHomologation
};
