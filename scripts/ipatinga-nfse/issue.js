'use strict';

const crypto = require('crypto');
const { CONFIG, sanitize } = require('./config');
const { readSheetValues, appendSheetValues, updateSheetValues } = require('./google');
const {
  ensureLedgerSheet,
  loadLedger,
  findLedgerEntry,
  allocateRpsAtomically,
  markSubmitting,
  markIssued,
  markUnknownAfterTimeout,
  markFailedSafe,
  RPS_STATUS
} = require('./ledger');
const { prepareDemand, demandRows, tomadorRows, patternRows, buildHomologationFixture } = require('./prepare');
const { validateXmlAgainstOfficialXsd } = require('./xsd-validator');
const { signXmlNode, verifyXmlSignature } = require('./xmldsig');
const { callSoapOperation } = require('./soap');
const { buildCabecalho, parseConsultarNfseResposta } = require('./abrasf');
const { getXmlNode, getXmlValue, parseXml } = require('./xml');

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildConsultarNfsePorRpsEnvio({ rpsNumero, rpsSerie = 'A', rpsTipo = '1', cnpj = null, im = null }) {
  const cnpjClean = cnpj || CONFIG.PRESTADOR.CNPJ_DIGITS;
  const imClean = im || CONFIG.PRESTADOR.INSCRICAO_MUNICIPAL;

  return `<ConsultarNfsePorRpsEnvio xmlns="${CONFIG.ABRASF.SCHEMA_NAMESPACE}">` +
    `<IdentificacaoRps>` +
      `<Numero>${escapeXml(rpsNumero)}</Numero>` +
      `<Serie>${escapeXml(rpsSerie)}</Serie>` +
      `<Tipo>${escapeXml(rpsTipo)}</Tipo>` +
    `</IdentificacaoRps>` +
    `<Prestador>` +
      `<CpfCnpj><Cnpj>${escapeXml(cnpjClean)}</Cnpj></CpfCnpj>` +
      `<InscricaoMunicipal>${escapeXml(imClean)}</InscricaoMunicipal>` +
    `</Prestador>` +
  `</ConsultarNfsePorRpsEnvio>`;
}

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

async function recoverViaConsultarNfsePorRps({ ledgerEntry, certData }, dependencies = {}) {
  const consultarRpsXml = buildConsultarNfsePorRpsEnvio({
    rpsNumero: ledgerEntry.rps_numero,
    rpsSerie: ledgerEntry.rps_serie,
    rpsTipo: ledgerEntry.rps_tipo
  });

  const soapCall = dependencies.callSoapOperation || callSoapOperation;
  let queryRes = null;
  try {
    queryRes = await soapCall({
      environment: 'homologation',
      operation: 'ConsultarNfsePorRps',
      cabecMsg: buildCabecalho(),
      dadosMsg: consultarRpsXml,
      certData
    });
  } catch (err) {
    return { success: false, error: err.message };
  }

  const parsedQuery = parseConsultarNfseResposta(queryRes.outputXml);
  if (parsedQuery.notas && parsedQuery.notas.length > 0) {
    const nota = parsedQuery.notas[0];
    const updated = await markIssued(ledgerEntry, { nfseNumero: nota.numero, nfseChave: nota.codigoVerificacao }, dependencies);
    return {
      success: true,
      updatedEntry: updated,
      status: 'ISSUED',
      environment: 'homologation',
      requestId: ledgerEntry.request_id,
      itemIndex: ledgerEntry.item_index,
      rpsNumero: ledgerEntry.rps_numero,
      nfseNumero: nota.numero,
      nfseChave: nota.codigoVerificacao,
      recoveredViaRpsQuery: true
    };
  }

  return {
    success: false,
    rawQuery: queryRes.outputXml
  };
}

async function issueHomologation({ requestId, itemIndex = 1, certData, dryRun = false }, dependencies = {}) {
  if (process.env.INPUT_ENVIRONMENT === 'production') {
    throw new Error('PRODUCTION_ISSUE_DISABLED: Emissão de NFS-e em produção está estritamente bloqueada.');
  }

  if (!certData || !certData.loaded || !certData.isValid) {
    throw new Error('CERT_INVALID: Emissão requer certificado A1 válido.');
  }

  const read = dependencies.readSheetValues || readSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;

  // Garante aba RPS quando dry_run=false
  if (!dryRun) {
    await ensureLedgerSheet(dependencies);
  }

  let prepared;
  if (requestId.startsWith('fixture-homologation') || requestId.startsWith('fixture-controlada')) {
    prepared = buildHomologationFixture(requestId);
  } else {
    // 1. Carrega dados e prepara demanda real
    const [demandasRaw, tomadoresRaw, patternsRaw, notasRaw] = await Promise.all([
      read(spreadsheetId, `${CONFIG.SHEETS.TABS.DEMANDAS}!A:Z`),
      read(spreadsheetId, `${CONFIG.SHEETS.TABS.TOMADORES}!A:J`),
      read(spreadsheetId, `${CONFIG.SHEETS.TABS.PADROES}!A:T`),
      read(spreadsheetId, `${CONFIG.SHEETS.TABS.NOTAS}!A:X`)
    ]);

    prepared = prepareDemand({
      requestId,
      demandas: demandRows(demandasRaw),
      tomadores: tomadorRows(tomadoresRaw),
      patterns: patternRows(patternsRaw),
      notas: notasRaw
    });
  }

  if (prepared.validationStatus !== 'READY_TO_ISSUE' || !prepared.candidates.length) {
    throw new Error(`PREPARE_NOT_READY: ${prepared.blockingReasons.join(', ')}`);
  }

  const candidate = prepared.candidates[itemIndex - 1];
  if (!candidate) {
    throw new Error(`CANDIDATE_INDEX_OUT_OF_BOUNDS: index ${itemIndex}`);
  }

  if (!candidate.codigoMunicipioPrestacao) {
    throw new Error('PREPARE_NOT_READY: codigoMunicipioPrestacao indefinido para o tomador/padrão.');
  }

  // 2. Consulta Ledger
  let ledgerEntries = await loadLedger(dependencies);
  let ledgerEntry = findLedgerEntry(ledgerEntries, {
    environment: 'homologation',
    requestId,
    itemIndex
  });

  // 3. Regra de Estados do Ledger
  if (ledgerEntry) {
    if (ledgerEntry.status === RPS_STATUS.ISSUED) {
      return {
        status: 'ALREADY_ISSUED',
        environment: 'homologation',
        requestId,
        itemIndex,
        rpsNumero: ledgerEntry.rps_numero,
        nfseNumero: ledgerEntry.nfse_numero,
        nfseChave: ledgerEntry.nfse_chave,
        gerarNfseCalls: 0,
        message: 'Nota já emitida anteriormente para este request_id e item_index (idempotente).'
      };
    }

    if (ledgerEntry.status === RPS_STATUS.FAILED_SAFE) {
      return {
        status: 'REVISAO_MANUAL',
        environment: 'homologation',
        requestId,
        itemIndex,
        rpsNumero: ledgerEntry.rps_numero,
        error: ledgerEntry.error,
        message: 'Registro em FAILED_SAFE requer intervenção/revisão manual; reemissão automática proibida.'
      };
    }

    if (ledgerEntry.status === RPS_STATUS.UNKNOWN_AFTER_TIMEOUT || ledgerEntry.status === RPS_STATUS.SUBMITTING) {
      const recovery = await recoverViaConsultarNfsePorRps({ ledgerEntry, certData }, dependencies);
      if (recovery.success) {
        return recovery;
      }
      if (ledgerEntry.status === RPS_STATUS.SUBMITTING) {
        ledgerEntry = await markUnknownAfterTimeout(ledgerEntry, { error: 'CRASH_WINDOW_RECOVERY_INCONCLUSIVE' }, dependencies);
      }
      return {
        status: 'SAFE_RETRY_REQUIRED',
        environment: 'homologation',
        requestId,
        itemIndex,
        rpsNumero: ledgerEntry.rps_numero,
        message: 'Envio anterior em estado ambíguo (SUBMITTING/TIMEOUT). Consulta por RPS não localizou nota emitida. Nenhuma reemissão automática executada.'
      };
    }
  }

  // 4. Alocação Atômica do ALLOCATED
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
        status: RPS_STATUS.ALLOCATED,
        allocated_at: new Date().toISOString()
      };
    }
  }

  candidate.rpsNumero = ledgerEntry.rps_numero;
  candidate.rpsSerie = ledgerEntry.rps_serie;
  candidate.rpsTipo = ledgerEntry.rps_tipo;
  candidate.xmlId = `RPS${ledgerEntry.rps_numero}${ledgerEntry.rps_serie.replace(/[^A-Za-z0-9]/g, '')}`;

  // 5. Montagem do XML estrito: SEM defaults artificiais de ISS, alíquota, retenções e CNAE
  const itemLista = String(candidate.codigoTribNacional || '').split('.').slice(0, 2).join('.');
  const codMunPrestacao = candidate.codigoMunicipioPrestacao;
  const nbsTag = candidate.nbs ? `<cNBS>${escapeXml(candidate.nbs.replace(/\D/g, ''))}</cNBS>` : '';
  const cnaeTag = candidate.codigoCnae ? `<CodigoCnae>${escapeXml(candidate.codigoCnae)}</CodigoCnae>` : '';

  let valoresXml = `<ValorServicos>${candidate.valor.toFixed(2)}</ValorServicos>`;
  if (candidate.valorDeducoes !== undefined && candidate.valorDeducoes !== null && candidate.valorDeducoes > 0) {
    valoresXml += `<ValorDeducoes>${Number(candidate.valorDeducoes).toFixed(2)}</ValorDeducoes>`;
  }
  if (candidate.valorPis !== undefined && candidate.valorPis !== null && candidate.valorPis > 0) {
    valoresXml += `<ValorPis>${Number(candidate.valorPis).toFixed(2)}</ValorPis>`;
  }
  if (candidate.valorCofins !== undefined && candidate.valorCofins !== null && candidate.valorCofins > 0) {
    valoresXml += `<ValorCofins>${Number(candidate.valorCofins).toFixed(2)}</ValorCofins>`;
  }
  if (candidate.valorInss !== undefined && candidate.valorInss !== null && candidate.valorInss > 0) {
    valoresXml += `<ValorInss>${Number(candidate.valorInss).toFixed(2)}</ValorInss>`;
  }
  if (candidate.valorIr !== undefined && candidate.valorIr !== null && candidate.valorIr > 0) {
    valoresXml += `<ValorIr>${Number(candidate.valorIr).toFixed(2)}</ValorIr>`;
  }
  if (candidate.valorCsll !== undefined && candidate.valorCsll !== null && candidate.valorCsll > 0) {
    valoresXml += `<ValorCsll>${Number(candidate.valorCsll).toFixed(2)}</ValorCsll>`;
  }
  if (candidate.outrasRetencoes !== undefined && candidate.outrasRetencoes !== null && candidate.outrasRetencoes > 0) {
    valoresXml += `<OutrasRetencoes>${Number(candidate.outrasRetencoes).toFixed(2)}</OutrasRetencoes>`;
  }
  if (candidate.valTotTributos !== undefined && candidate.valTotTributos !== null && candidate.valTotTributos > 0) {
    valoresXml += `<ValTotTributos>${Number(candidate.valTotTributos).toFixed(2)}</ValTotTributos>`;
  }
  if (candidate.valorIss !== undefined && candidate.valorIss !== null && candidate.valorIss > 0) {
    valoresXml += `<ValorIss>${Number(candidate.valorIss).toFixed(2)}</ValorIss>`;
  }
  if (candidate.aliquotaIss !== undefined && candidate.aliquotaIss !== null && candidate.aliquotaIss > 0) {
    valoresXml += `<Aliquota>${Number(candidate.aliquotaIss).toFixed(4)}</Aliquota>`;
  }

  const unsignedXml = `<GerarNfseEnvio xmlns="http://www.abrasf.org.br/nfse.xsd">` +
    `<Rps>` +
      `<InfDeclaracaoPrestacaoServico Id="${escapeXml(candidate.xmlId)}">` +
        `<Rps>` +
          `<IdentificacaoRps>` +
            `<Numero>${escapeXml(candidate.rpsNumero)}</Numero>` +
            `<Serie>${escapeXml(candidate.rpsSerie)}</Serie>` +
            `<Tipo>${escapeXml(candidate.rpsTipo)}</Tipo>` +
          `</IdentificacaoRps>` +
          `<DataEmissao>${escapeXml(candidate.dataEmissao)}</DataEmissao>` +
          `<Status>1</Status>` +
        `</Rps>` +
        `<Competencia>${escapeXml(candidate.competenciaData)}</Competencia>` +
        `<Servico>` +
          `<Valores>` +
            valoresXml +
          `</Valores>` +
          `<IssRetido>2</IssRetido>` +
          `<ItemListaServico>${escapeXml(itemLista)}</ItemListaServico>` +
          cnaeTag +
          `<CodigoTributacaoMunicipio>${escapeXml(candidate.codigoTribMunicipal)}</CodigoTributacaoMunicipio>` +
          `<Discriminacao>${escapeXml(candidate.descricao)}</Discriminacao>` +
          `<CodigoMunicipio>${escapeXml(codMunPrestacao)}</CodigoMunicipio>` +
          `<CodigoPais>1058</CodigoPais>` +
          `<ExigibilidadeISS>1</ExigibilidadeISS>` +
          `<MunicipioIncidencia>${escapeXml(codMunPrestacao)}</MunicipioIncidencia>` +
          nbsTag +
        `</Servico>` +
        `<Prestador>` +
          `<CpfCnpj><Cnpj>${escapeXml(CONFIG.PRESTADOR.CNPJ_DIGITS)}</Cnpj></CpfCnpj>` +
          `<InscricaoMunicipal>${escapeXml(CONFIG.PRESTADOR.INSCRICAO_MUNICIPAL)}</InscricaoMunicipal>` +
        `</Prestador>` +
        `<TomadorServico>` +
          `<IdentificacaoTomador>` +
            `<CpfCnpj><Cnpj>${escapeXml(candidate.cnpjTomador)}</Cnpj></CpfCnpj>` +
          `</IdentificacaoTomador>` +
          `<RazaoSocial>${escapeXml(candidate.tomador)}</RazaoSocial>` +
        `</TomadorServico>` +
        `<OptanteSimplesNacional>${escapeXml(CONFIG.PRESTADOR.OPTANTE_SIMPLES_NACIONAL)}</OptanteSimplesNacional>` +
        `<IncentivoFiscal>2</IncentivoFiscal>` +
      `</InfDeclaracaoPrestacaoServico>` +
    `</Rps>` +
  `</GerarNfseEnvio>`;

  // 6. Assina com XMLDSig W3C C14N
  const signedXml = signXmlNode({
    xml: unsignedXml,
    targetId: candidate.xmlId,
    pemKey: certData.pemKey,
    pemCert: certData.pemCert
  });

  const sigValid = verifyXmlSignature({ signedXml, pemCert: certData.pemCert });
  if (!sigValid) {
    throw new Error('XMLDSIG_VERIFICATION_FAILED: Assinatura XML gerada é criptograficamente inválida.');
  }

  const xsdValidation = await validateXmlAgainstOfficialXsd(signedXml, 'GerarNfseEnvio');
  if (!xsdValidation.valid) {
    throw new Error(`XSD_VALIDATION_FAILED: ${xsdValidation.errors.join('; ')}`);
  }

  const xmlSha256 = crypto.createHash('sha256').update(signedXml).digest('hex');

  if (dryRun) {
    return {
      status: 'DRY_RUN_SUCCESS',
      environment: 'homologation',
      requestId,
      itemIndex,
      rpsNumero: candidate.rpsNumero,
      rpsSerie: candidate.rpsSerie,
      rpsTipo: candidate.rpsTipo,
      xmlSha256,
      xsdValidation: 'VALIDATED_OFFICIAL_XSD',
      xmlSignature: 'VALIDATED_XMLDSIG_C14N',
      gerarNfseCalls: 0,
      externalWrites: 0
    };
  }

  // 7. Persiste SUBMITTING antes da chamada SOAP
  ledgerEntry = await markSubmitting(ledgerEntry, dependencies);

  // 8. Chamada SOAP GerarNfse
  const soapCall = dependencies.callSoapOperation || callSoapOperation;
  let responseXml = null;
  let timeoutOccurred = false;

  try {
    const soapRes = await soapCall({
      environment: 'homologation',
      operation: 'GerarNfse',
      cabecMsg: buildCabecalho(),
      dadosMsg: signedXml,
      certData
    });
    responseXml = soapRes.outputXml;
  } catch (err) {
    if (String(err.message).includes('TIMEOUT') || String(err.message).includes('ECONNRESET')) {
      timeoutOccurred = true;
    } else {
      ledgerEntry = await markFailedSafe(ledgerEntry, { error: err.message }, dependencies);
      throw err;
    }
  }

  // 9. Tratamento de Timeout
  if (timeoutOccurred || !responseXml) {
    ledgerEntry = await markUnknownAfterTimeout(ledgerEntry, { error: 'TIMEOUT_ON_GERARNFSE' }, dependencies);
    const recovery = await recoverViaConsultarNfsePorRps({ ledgerEntry, certData }, dependencies);
    if (recovery.success) {
      return recovery;
    }
    throw new Error('TIMEOUT_UNCONFIRMED: Emissão em homologação ficou inconclusiva após timeout e consulta por RPS.');
  }

  // 10. Parse da Resposta Oficial
  const parsedGerar = parseGerarNfseResposta(responseXml);
  if (!parsedGerar.hasNfse) {
    const errorMsg = parsedGerar.mensagens.map(m => `[${m.codigo}] ${m.mensagem}`).join('; ') || 'SEM_DADOS_NFSE';
    ledgerEntry = await markFailedSafe(ledgerEntry, { error: errorMsg }, dependencies);
    throw new Error(`GERAR_NFSE_REJECTED: ${errorMsg}`);
  }

  ledgerEntry = await markIssued(ledgerEntry, { nfseNumero: parsedGerar.numero, nfseChave: parsedGerar.codigoVerificacao }, dependencies);

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
  escapeXml,
  buildConsultarNfsePorRpsEnvio,
  parseGerarNfseResposta,
  recoverViaConsultarNfsePorRps,
  issueHomologation
};
