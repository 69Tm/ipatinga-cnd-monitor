'use strict';

const { CONFIG, sanitize } = require('./config');
const { readSheetValues, appendSheetValues, updateSheetValues } = require('./google');
const { loadLedger, findLedgerEntry, allocateNextRpsNumber, RPS_STATUS } = require('./ledger');
const { prepareDemand, demandRows, tomadorRows, patternRows } = require('./prepare');
const { validateXmlAgainstAbrasf204 } = require('./xsd-validator');
const { signXmlNode } = require('./xmldsig');
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
 * Executa a operação GerarNfse em Homologação
 */
async function issueHomologation({ requestId, itemIndex = 1, certData, dryRun = false }, dependencies = {}) {
  if (!certData || !certData.loaded || !certData.isValid) {
    throw new Error('CERT_INVALID: Emissão requer certificado A1 válido.');
  }

  const read = dependencies.readSheetValues || readSheetValues;
  const update = dependencies.updateSheetValues || updateSheetValues;
  const append = dependencies.appendSheetValues || appendSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;

  // 1. Carrega dados de negócio
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

  // 2. Consulta Ledger para verificar se já foi emitido ou alocado
  const ledgerEntries = await loadLedger(dependencies);
  const existingLedger = findLedgerEntry(ledgerEntries, {
    environment: 'homologation',
    requestId,
    itemIndex
  });

  if (existingLedger && existingLedger.status === RPS_STATUS.ISSUED) {
    return {
      status: 'ALREADY_ISSUED',
      environment: 'homologation',
      requestId,
      itemIndex,
      rpsNumero: existingLedger.rps_numero,
      nfseNumero: existingLedger.nfse_numero,
      nfseChave: existingLedger.nfse_chave,
      message: 'Nota já emitida anteriormente para este request_id e item_index.'
    };
  }

  let rpsNumero = existingLedger?.rps_numero;
  let rpsSerie = existingLedger?.rps_serie || 'A';
  let rpsTipo = existingLedger?.rps_tipo || '1';

  if (!rpsNumero) {
    const allocated = allocateNextRpsNumber(ledgerEntries, 'homologation', 'A', '1');
    rpsNumero = allocated.rpsNumero;
    rpsSerie = allocated.rpsSerie;
    rpsTipo = allocated.rpsTipo;
  }

  candidate.rpsNumero = rpsNumero;
  candidate.rpsSerie = rpsSerie;
  candidate.rpsTipo = rpsTipo;
  candidate.xmlId = `RPS${rpsNumero}${rpsSerie.replace(/[^A-Za-z0-9]/g, '')}`;

  // 3. Monta InfDeclaracaoPrestacaoServico e assina via XMLDSig
  const itemLista = String(candidate.codigoTribNacional || '').split('.').slice(0, 2).join('.');
  const infDpsXml = `<InfDeclaracaoPrestacaoServico Id="${candidate.xmlId}">` +
    `<Rps><IdentificacaoRps><Numero>${candidate.rpsNumero}</Numero><Serie>${candidate.rpsSerie}</Serie><Tipo>${candidate.rpsTipo}</Tipo></IdentificacaoRps>` +
    `<DataEmissao>${candidate.dataEmissao}</DataEmissao><Status>1</Status></Rps>` +
    `<Competencia>${candidate.competenciaData}</Competencia>` +
    `<Servico><Valores><ValorServicos>${candidate.valor.toFixed(2)}</ValorServicos></Valores>` +
    `<IssRetido>2</IssRetido><ItemListaServico>${itemLista}</ItemListaServico>` +
    `<CodigoTributacaoMunicipio>${candidate.codigoTribMunicipal}</CodigoTributacaoMunicipio>` +
    `<Discriminacao>${candidate.descricao}</Discriminacao>` +
    `<CodigoMunicipio>${candidate.codigoMunicipioPrestacao}</CodigoMunicipio></Servico>` +
    `<Prestador><CpfCnpj><Cnpj>${CONFIG.PRESTADOR.CNPJ_DIGITS}</Cnpj></CpfCnpj><InscricaoMunicipal>${CONFIG.PRESTADOR.INSCRICAO_MUNICIPAL}</InscricaoMunicipal></Prestador>` +
    `<Tomador><IdentificacaoTomador><CpfCnpj><Cnpj>${candidate.cnpjTomador}</Cnpj></CpfCnpj></IdentificacaoTomador>` +
    `<RazaoSocial>${candidate.tomador}</RazaoSocial></Tomador>` +
    `<OptanteSimplesNacional>${CONFIG.PRESTADOR.OPTANTE_SIMPLES_NACIONAL}</OptanteSimplesNacional><IncentivoFiscal>2</IncentivoFiscal>` +
    `</InfDeclaracaoPrestacaoServico>`;

  const signatureBlock = signXmlNode({
    xmlNode: infDpsXml,
    targetId: candidate.xmlId,
    pemKey: certData.pemKey,
    pemCert: certData.pemCert
  });

  const fullGerarNfseXml = `<GerarNfseEnvio xmlns="${CONFIG.ABRASF.SCHEMA_NAMESPACE}">` +
    `<Rps>` +
      infDpsXml +
      signatureBlock +
    `</Rps>` +
  `</GerarNfseEnvio>`;

  // 4. Validação XSD antes da transmissão
  const xsdValidation = validateXmlAgainstAbrasf204(fullGerarNfseXml, 'GerarNfseEnvio');
  if (!xsdValidation.valid) {
    throw new Error(`XSD_VALIDATION_FAILED: ${xsdValidation.errors.join(', ')}`);
  }

  if (dryRun) {
    return {
      status: 'DRY_RUN_SUCCESS',
      environment: 'homologation',
      requestId,
      itemIndex,
      rpsNumero,
      rpsSerie,
      rpsTipo,
      xmlCandidate: fullGerarNfseXml
    };
  }

  // 5. Transmissão SOAP GerarNfse em Homologação
  const cabecalho = buildCabecalho();
  let responseXml = null;
  let timeoutOccurred = false;

  try {
    const soapRes = await executeSoapRequest({
      endpointUrl: CONFIG.ENDPOINTS.homologation.url,
      soapAction: 'nfs#GerarNfse',
      operation: 'GerarNfse',
      cabecalhoXml: cabecalho,
      dadosXml: fullGerarNfseXml,
      certData
    });
    responseXml = soapRes.rawXml;
  } catch (err) {
    if (String(err.message).includes('TIMEOUT') || String(err.message).includes('ECONNRESET')) {
      timeoutOccurred = true;
    } else {
      throw err;
    }
  }

  // 6. Recuperação pós-timeout via ConsultarNfsePorRps se aplicável
  if (timeoutOccurred || !responseXml) {
    const consultarRpsXml = buildConsultarNfsePorRpsEnvio({
      rpsNumero,
      rpsSerie,
      rpsTipo
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
      return {
        status: 'ISSUED',
        environment: 'homologation',
        requestId,
        itemIndex,
        rpsNumero,
        nfseNumero: nota.numero,
        nfseChave: nota.codigoVerificacao,
        recoveredViaRpsQuery: true
      };
    }

    throw new Error('TIMEOUT_UNCONFIRMED: Emissão ficou inconclusiva após consulta por RPS.');
  }

  // 7. Parse da resposta de sucesso
  const parsedResponse = parseConsultarNfseResposta(responseXml);
  const notaEmitida = parsedResponse.notas?.[0];

  return {
    status: 'ISSUED',
    environment: 'homologation',
    requestId,
    itemIndex,
    rpsNumero,
    rpsSerie,
    rpsTipo,
    nfseNumero: notaEmitida?.numero || 'HOMOLOG_OK',
    nfseChave: notaEmitida?.codigoVerificacao || 'VERIF_HOMOLOG',
    mensagens: parsedResponse.mensagens
  };
}

module.exports = {
  buildConsultarNfsePorRpsEnvio,
  issueHomologation
};
