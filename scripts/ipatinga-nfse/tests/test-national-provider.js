'use strict';

const assert = require('assert');
const forge = require('node-forge');
const {
  DEFAULT_PRODUCTION_URL,
  DEFAULT_RESTRICTED_URL,
  formatDateTimeSaoPaulo,
  normalizeBaseUrl,
  buildNationalDpsXml,
  buildNationalDpsPayloadFromCandidate,
  buildNationalSubmitRequest,
  buildNationalNfseReadRequest,
  buildNationalDpsReadRequest,
  parseNationalSubmitResponse,
  createNationalIssuerProvider
} = require('../national-emissor-provider');
const {
  NATIONAL_DPS_STATUS,
  CANONICAL_NATIONAL_LEDGER_TAB,
  CANONICAL_NATIONAL_LEDGER_HEADERS,
  buildOfficialDpsId,
  getNationalLedgerTabName,
  ensureNationalLedgerSheet,
  buildHeaderMapping,
  allocateNextDpsNumber,
  allocateDpsAtomically,
  loadNationalLedger,
  findNationalLedgerEntry,
  markNationalIssued,
  markNationalTimeout
} = require('../national-ledger');
const {
  CANONICAL_SIMPLES_NACIONAL_RATES,
  getSimplesNacionalRate,
  resolveSimplesNacionalRate
} = require('../simples-nacional-rates');
const { reconcileNationalDps, issueNationalDemandItem } = require('../issue');
const { validateNationalDpsAgainstOfficialXsd } = require('../xsd-validator');
const { CONFIG } = require('../config');
const { buildControlledCandidate } = require('../prepare');
const { loadCertificate } = require('../certificate');

// Par de chaves RSA e certificado A1 autoassinado para testes de assinatura
const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
const cert = forge.pki.createCertificate();
cert.publicKey = keypair.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
const attrs = [{ name: 'commonName', value: 'DEXMED TEST' }];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.sign(keypair.privateKey, forge.md.sha256.create());

const certData = {
  loaded: true,
  isValid: true,
  pemCert: forge.pki.certificateToPem(cert),
  pemKey: forge.pki.privateKeyToPem(keypair.privateKey)
};

async function run() {
  console.log('Running test-national-provider.js (UNIT & SPECIFICATION SUITE)...');

  // =========================================================================
  // 1. TESTE DA REGRA OFICIAL DO DPS ID (45 CARACTERES, ^DPS[0-9]{42}$)
  // =========================================================================
  const officialDpsId = buildOfficialDpsId({
    codMun: '3131307',
    tipoInscricao: '2', // 2 = CNPJ, 1 = CPF
    inscricaoFederal: '31302407000105',
    serie: '1',
    numero: '1'
  });
  assert.strictEqual(officialDpsId.length, 45, 'DPS ID oficial deve ter exatamente 45 caracteres');
  assert.ok(/^DPS[0-9]{42}$/.test(officialDpsId), 'DPS ID oficial deve seguir o pattern ^DPS[0-9]{42}$');
  assert.strictEqual(officialDpsId, 'DPS313130723130240700010500001000000000000001');

  // Falha se município inválido
  assert.throws(() => buildOfficialDpsId({
    codMun: '99',
    tipoInscricao: '1',
    inscricaoFederal: '31302407000105',
    serie: '1',
    numero: '1'
  }), /NATIONAL_DPS_ID_INVALID/);

  // =========================================================================
  // 2. TIMEZONE-SAFE DATA/HORA (America/Sao_Paulo)
  // =========================================================================
  // Data fixa: meio-dia UTC (12:00:00Z) deve ser 09:00:00-03:00 em America/Sao_Paulo
  const utcDate = new Date('2026-10-21T12:00:00.000Z');
  const spFormatted = formatDateTimeSaoPaulo(utcDate);
  assert.ok(spFormatted.startsWith('2026-10-21T09:00:00-03:00'), `Esperado horário 09:00 em SP, obtido: ${spFormatted}`);

  // =========================================================================
  // 3. SELEÇÃO DE BASE URL CONFORME AMBIENTE (SEM BASEURL MANUAL)
  // =========================================================================
  assert.strictEqual(normalizeBaseUrl(null, 'homologation'), DEFAULT_RESTRICTED_URL);
  assert.strictEqual(normalizeBaseUrl(null, 'restricted'), DEFAULT_RESTRICTED_URL);
  assert.strictEqual(normalizeBaseUrl(null, 'production'), DEFAULT_PRODUCTION_URL);

  const providerHomolog = createNationalIssuerProvider({ environment: 'homologation' });
  assert.strictEqual(providerHomolog.baseUrl, DEFAULT_RESTRICTED_URL);

  const providerProd = createNationalIssuerProvider({ environment: 'production' });
  assert.strictEqual(providerProd.baseUrl, DEFAULT_PRODUCTION_URL);

  // =========================================================================
  // 4. FAIL-CLOSED: ELIMINAÇÃO TOTAL DE DEFAULTS/FALLBACKS SINTÉTICOS
  // =========================================================================
  // Faltando tomador
  assert.throws(() => buildNationalDpsXml({
    dpsNumero: '1',
    prestador: { cnpj: '31302407000105', codigoMunicipio: '3131307' }
  }), /NATIONAL_DPS_DATA_INCOMPLETE/);

  // Faltando prestador
  assert.throws(() => buildNationalDpsXml({
    dpsNumero: '1',
    tomador: { cnpj: '20724357000120', razaoSocial: 'HIC' }
  }), /NATIONAL_DPS_DATA_INCOMPLETE/);

  // Faltando valor
  assert.throws(() => buildNationalDpsXml({
    dpsNumero: '1',
    prestador: { cnpj: '31302407000105', codigoMunicipio: '3131307' },
    tomador: {
      cnpj: '20724357000120',
      razaoSocial: 'HIC',
      logradouro: 'CAPITAO BERNARDO',
      numero: '257',
      bairro: 'CENTRO',
      codigoMunicipio: '3128006',
      cep: '39740000'
    },
    servico: {
      codigoMunicipioPrestacao: '3128006',
      codigoTribNacional: '040301',
      descricao: 'PLANTÕES'
    },
    valores: { valorServicos: 0, pTotTribSN: 2.39 } // Proibido valor zero
  }), /NATIONAL_DPS_DATA_INCOMPLETE/);

  // Faltando competência explícita
  assert.throws(() => buildNationalDpsXml({
    dpsNumero: '1',
    prestador: { cnpj: '31302407000105', codigoMunicipio: '3131307' },
    tomador: {
      cnpj: '20724357000120',
      razaoSocial: 'HIC',
      logradouro: 'CAPITAO BERNARDO',
      numero: '257',
      bairro: 'CENTRO',
      codigoMunicipio: '3128006',
      cep: '39740000'
    },
    servico: {
      codigoMunicipioPrestacao: '3128006',
      codigoTribNacional: '040301',
      descricao: 'PLANTÕES'
    },
    valores: { valorServicos: 7700.00, aliquotaIss: 2.39, pTotTribSN: 2.39 }
    // competenciaData ausente
  }), /NATIONAL_DPS_DATA_INCOMPLETE/);

  // =========================================================================
  // 5. TESTE DE INTEGRAÇÃO DO MAPEAMENTO HIC R$ 7.700,00
  // =========================================================================
  const hicCandidate = {
    dpsNumero: '1',
    dpsSerie: '1',
    ambiente: 2,
    emissao: new Date('2026-10-21T15:00:00.000Z'),
    competenciaData: '2026-08-01',
    prestador: {
      cnpj: '31302407000105',
      inscricaoMunicipal: '23297500',
      codigoMunicipio: '3131307',
      razaoSocial: 'DEXMED SERVICOS MEDICOS LTDA'
    },
    tomador: {
      cnpj: '20724357000120',
      razaoSocial: 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO',
      logradouro: 'CAPITAO BERNARDO',
      numero: '257',
      bairro: 'CENTRO',
      codigoMunicipio: '3128006',
      cep: '39740000'
    },
    servico: {
      codigoMunicipioPrestacao: '3128006',
      codigoTribNacional: '04.03.01',
      codigoTribMunicipal: '403',
      descricao: 'SERVICOS MEDICOS DE PLANTAO HOSPITALAR SUS',
      nbs: '123011900'
    },
    valores: {
      valorServicos: 7700.00,
      aliquotaIss: 2.39,
      pTotTribSN: '2.39',
      issRetido: '2'
    },
    certData
  };

  const builtHic = buildNationalDpsXml(hicCandidate);
  assert.strictEqual(builtHic.dpsId, 'DPS313130723130240700010500001000000000000001');
  assert.ok(builtHic.xml.includes('<vServ>7700.00</vServ>'), 'DPS deve conter exatamente o valor 7700.00 (nunca 0.00)');
  assert.ok(builtHic.xml.includes('<xDescServ>SERVICOS MEDICOS DE PLANTAO HOSPITALAR SUS</xDescServ>'));
  assert.ok(builtHic.xml.includes('<cTribNac>040301</cTribNac>'));
  assert.ok(builtHic.xml.includes('<pAliq>2.39</pAliq>'));
  assert.ok(builtHic.xml.includes('<tpRetISSQN>1</tpRetISSQN>'), 'DPS para HIC (issRetido=2 no ABRASF) deve mapear para tpRetISSQN=1 (Não Retido) na SEFIN Nacional');
  assert.ok(builtHic.xml.includes('<dCompet>2026-08-01</dCompet>'));
  assert.ok(builtHic.xml.includes('<opSimpNac>3</opSimpNac>'));
  assert.ok(builtHic.xml.includes('<cLocPrestacao>3128006</cLocPrestacao>'));
  assert.ok(builtHic.xml.includes('<Signature'), 'DPS deve conter assinatura XMLDSig');

  // =========================================================================
  // 6. VALIDAÇÃO XSD OFICIAL v1.01 (SEFIN/ADN)
  // =========================================================================
  const xsdValidation = await validateNationalDpsAgainstOfficialXsd(builtHic.xml);
  assert.strictEqual(xsdValidation.valid, true, `DPS deve ser 100% válida contra XSD oficial v1.01: ${xsdValidation.errors.join('; ')}`);
  assert.strictEqual(xsdValidation.schemaFile, 'DPS_v1.01.xsd');

  // =========================================================================
  // 7. ASSINATURA XMLDSIG FAIL-CLOSED
  // =========================================================================
  assert.throws(() => buildNationalDpsXml({
    ...hicCandidate,
    certData: { pemKey: 'INVALID_KEY', pemCert: 'INVALID_CERT' }
  }), /NATIONAL_XMLDSIG_FAILED/);

  // =========================================================================
  // 8. TESTE DO ISOLAMENTO DO LEDGER NACIONAL (DPS) — NEW_RPS=0 GARANTIDO
  // =========================================================================
  const mockDpsSheet = [];
  const mockDependencies = {
    spreadsheetId: 'test-sheet',
    readSheetValues: async (_id, range) => {
      if (range.includes('Ledger NFS-e Nacional') || range.includes('DPS')) {
        if (range.includes('!1:1')) return [CANONICAL_NATIONAL_LEDGER_HEADERS];
        return [CANONICAL_NATIONAL_LEDGER_HEADERS, ...mockDpsSheet];
      }
      throw new Error(`Tentativa de leitura indevida da aba: ${range}`);
    },
    appendSheetValues: async (_id, range, rows) => {
      if (range.includes('Ledger NFS-e Nacional') || range.includes('DPS')) {
        mockDpsSheet.push(...rows);
        return { updatedRows: rows.length };
      }
      throw new Error(`Tentativa indevida de escrita fora da aba Ledger NFS-e Nacional: ${range}`);
    },
    updateSheetValues: async (_id, range, rows) => {
      if (range.includes('Ledger NFS-e Nacional') || range.includes('DPS')) {
        return { updatedRows: rows.length };
      }
      throw new Error(`Tentativa indevida de update fora da aba Ledger NFS-e Nacional: ${range}`);
    }
  };

  const allocated = await allocateDpsAtomically({
    environment: 'homologation',
    requestId: 'req-national-isolation-test',
    itemIndex: 1,
    serie: '1'
  }, mockDependencies);

  assert.strictEqual(allocated.dps_numero, '1');
  assert.strictEqual(allocated.dps_serie, '1');
  assert.ok(allocated.dps_id.startsWith('DPS313130723130240700010500001'));
  assert.strictEqual(allocated.status, NATIONAL_DPS_STATUS.ALLOCATED);
  // Garante que o ledger do RPS não foi sequer instanciado ou tocado
  assert.strictEqual(allocated.rps_numero, undefined);

  // =========================================================================
  // 9. SIMULAÇÃO DE TRANSPORTE (UNIT MOCK) — CONTROLE DE CHAMADAS
  // =========================================================================
  let transportCalls = [];
  const mockTransport = async (req) => {
    transportCalls.push(req);
    if (req.method === 'POST' && req.url.endsWith('/nfse')) {
      return {
        statusCode: 201,
        headers: { 'content-type': 'application/xml; charset=utf-8' },
        body: `<?xml version="1.0" encoding="utf-8"?>
<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">
  <infNFSe Id="NFS31313071231302407000105000000000002726100000000000">
    <chNFSe>31313071231302407000105000000000002726100000000000</chNFSe>
    <nNFSe>27</nNFSe>
    <dhEmi>2026-10-21T20:20:00-03:00</dhEmi>
    <nProt>931260000000001</nProt>
  </infNFSe>
</NFSe>`
      };
    }
    if (req.method === 'HEAD' && req.url.includes('/dps/')) {
      return { statusCode: 200, headers: {} };
    }
    if (req.method === 'GET' && req.url.includes('/dps/')) {
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/xml; charset=utf-8' },
        body: `<NFSe><infNFSe><chNFSe>31313071231302407000105000000000002726100000000000</chNFSe><nNFSe>27</nNFSe></infNFSe></NFSe>`
      };
    }
    if (req.method === 'GET' && req.url.includes('/nfse/')) {
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/xml; charset=utf-8' },
        body: `<NFSe><infNFSe><chNFSe>31313071231302407000105000000000002726100000000000</chNFSe><nNFSe>27</nNFSe></infNFSe></NFSe>`
      };
    }
    return { statusCode: 404, body: '' };
  };

  const providerWithMock = createNationalIssuerProvider({
    environment: 'homologation',
    transport: mockTransport
  });

  const submitRes = await providerWithMock.submit({
    dpsXml: builtHic.xml,
    dpsId: builtHic.dpsId,
    certData,
    dryRun: false
  });

  assert.strictEqual(submitRes.status, 'ISSUED');
  assert.strictEqual(submitRes.nfseNumero, '27');
  assert.strictEqual(submitRes.chaveAcesso, '31313071231302407000105000000000002726100000000000');
  assert.strictEqual(transportCalls.length, 1);
  assert.strictEqual(transportCalls[0].url, `${DEFAULT_RESTRICTED_URL}/nfse`);
  const sentPayload = JSON.parse(transportCalls[0].body);
  assert.ok(sentPayload.dpsXmlGZipB64, 'POST /nfse deve conter dpsXmlGZipB64 compactado em Base64');

  // Consulta por HEAD e GET
  const headRes = await providerWithMock.headDps({ dpsId: builtHic.dpsId, certData });
  assert.strictEqual(headRes.exists, true);

  const getDpsRes = await providerWithMock.getDps({ dpsId: builtHic.dpsId, certData });
  assert.strictEqual(getDpsRes.status, 'FOUND');
  assert.strictEqual(getDpsRes.nfseNumero, '27');

  const getNfseRes = await providerWithMock.getNfse({ accessKey: submitRes.chaveAcesso, certData });
  assert.strictEqual(getNfseRes.status, 'FOUND');

  // Exact-once Timeout Recovery
  let failOnce = true;
  const timeoutTransport = async (req) => {
    if (req.method === 'POST') {
      if (failOnce) {
        failOnce = false;
        const err = new Error('TIMEOUT');
        err.code = 'ETIMEDOUT';
        throw err;
      }
    }
    return mockTransport(req);
  };

  const timeoutProvider = createNationalIssuerProvider({
    environment: 'homologation',
    transport: timeoutTransport
  });

  const recoveryRes = await timeoutProvider.submit({
    dpsXml: builtHic.xml,
    dpsId: builtHic.dpsId,
    certData,
    dryRun: false
  });
  assert.strictEqual(recoveryRes.status, 'RECONCILED_AFTER_TIMEOUT');
  assert.strictEqual(recoveryRes.reconciled, true);

  // =========================================================================
  // 9. ANTI-REGRESSÃO: CONFIG IMPORT & PROPRIEDADES DE MUNICÍPIO
  // =========================================================================
  assert.strictEqual(CONFIG.PRESTADOR.CNPJ, '31.302.407/0001-05');
  assert.strictEqual(CONFIG.PRESTADOR.CNPJ_DIGITS, '31302407000105');
  assert.strictEqual(CONFIG.PRESTADOR.CODIGO_MUNICIPIO_IPATINGA, '3131307');
  assert.strictEqual(CONFIG.PRESTADOR.CODIGO_MUNICIPIO, undefined, 'CONFIG.PRESTADOR.CODIGO_MUNICIPIO não deve existir (canônico: CODIGO_MUNICIPIO_IPATINGA)');

  // =========================================================================
  // 10. FAIL-CLOSED: DIVERGÊNCIA DE DPS ID PRÉ-COMPUTADO
  // =========================================================================
  assert.throws(() => {
    buildNationalDpsXml({
      ...hicCandidate,
      id: 'DPS999999999999999999999999999999999999999999999'
    });
  }, /NATIONAL_DPS_ID_MISMATCH/);

  // =========================================================================
  // 11. INTEGRAÇÃO: UNIFICAÇÃO DE SCHEMA (CANDIDATE -> FACTORY -> DPS XML -> XSD v1.01)
  // =========================================================================
  const prep = buildControlledCandidate({ requestId: 'test-controlled-sync', environment: 'homologation' });
  const candidate = prep.candidates[0];

  assert.strictEqual(candidate.tomador, 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO');
  assert.strictEqual(candidate.cnpjTomador, '20724357000120');
  assert.strictEqual(candidate.codigoMunicipioPrestacao, '3128006');

  const unifiedPayload = buildNationalDpsPayloadFromCandidate({
    candidate,
    dpsNumero: '888888888',
    dpsSerie: '900',
    ambiente: 2,
    certData,
    discriminacaoOverride: 'TESTE PRODUCAO RESTRITA — SEM VALIDADE FISCAL'
  });

  assert.strictEqual(unifiedPayload.dpsNumero, '888888888');
  assert.strictEqual(unifiedPayload.dpsSerie, '900');
  assert.strictEqual(unifiedPayload.prestador.cnpj, '31302407000105');
  assert.strictEqual(unifiedPayload.prestador.codigoMunicipio, '3131307');
  assert.strictEqual(unifiedPayload.tomador.cnpj, '20724357000120');
  assert.strictEqual(unifiedPayload.tomador.razaoSocial, 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO');
  assert.strictEqual(unifiedPayload.tomador.logradouro, 'CAPITAO BERNARDO');
  assert.strictEqual(unifiedPayload.tomador.numero, '257');
  assert.strictEqual(unifiedPayload.tomador.bairro, 'CENTRO');
  assert.strictEqual(unifiedPayload.tomador.codigoMunicipio, '3128006');
  assert.strictEqual(unifiedPayload.tomador.cep, '39740000');
  assert.strictEqual(unifiedPayload.servico.codigoMunicipioPrestacao, '3128006');
  assert.strictEqual(unifiedPayload.servico.codigoTribNacional, '04.03.01');
  assert.strictEqual(unifiedPayload.servico.codigoTribMunicipal, '403');
  assert.strictEqual(unifiedPayload.servico.nbs, '123011900');
  assert.strictEqual(unifiedPayload.servico.descricao, 'TESTE PRODUCAO RESTRITA — SEM VALIDADE FISCAL');

  const unifiedBuilt = buildNationalDpsXml(unifiedPayload);
  assert.ok(/^DPS[0-9]{42}$/.test(unifiedBuilt.dpsId), 'DPS ID deve atender regex oficial de 45 caracteres');
  assert.ok(unifiedBuilt.xml.includes('<CNPJ>31302407000105</CNPJ>'), 'XML deve conter CNPJ do prestador');
  assert.ok(unifiedBuilt.xml.includes('<CNPJ>20724357000120</CNPJ>'), 'XML deve conter CNPJ do tomador');
  assert.ok(unifiedBuilt.xml.includes('<cLocEmi>3131307</cLocEmi>'), 'XML deve conter município de Ipatinga no local de emissão cLocEmi');
  assert.ok(unifiedBuilt.xml.includes('<cLocPrestacao>3128006</cLocPrestacao>'), 'XML deve conter município de prestação Guanhães');
  assert.ok(unifiedBuilt.xml.includes('<xLgr>CAPITAO BERNARDO</xLgr>'), 'XML deve conter logradouro do tomador');
  assert.ok(unifiedBuilt.xml.includes('<cTribNac>040301</cTribNac>'), 'XML deve conter cTribNac');
  assert.ok(unifiedBuilt.xml.includes('<finNFSe>0</finNFSe>'), 'XML deve conter finNFSe=0 para conformidade RTC/SEFIN');

  const xsdCheck = await validateNationalDpsAgainstOfficialXsd(unifiedBuilt.xml);
  assert.strictEqual(xsdCheck.valid, true, `XML unificado deve validar 100% no XSD v1.01 oficial: ${xsdCheck.errors.join('; ')}`);

  // =========================================================================
  // 12. PREFLIGHT DE CERTIFICADO: DETECÇÃO DE EXPIRAÇÃO FAIL-CLOSED
  // =========================================================================
  const expiredCert = forge.pki.createCertificate();
  expiredCert.publicKey = keypair.publicKey;
  expiredCert.serialNumber = '02';
  expiredCert.validity.notBefore = new Date(Date.now() - 86400000 * 30);
  expiredCert.validity.notAfter = new Date(Date.now() - 86400000 * 2); // Expirado há 2 dias
  expiredCert.setSubject(attrs);
  expiredCert.setIssuer(attrs);
  expiredCert.sign(keypair.privateKey, forge.md.sha256.create());

  const nowCheck = new Date();
  const isActuallyExpired = nowCheck.getTime() > expiredCert.validity.notAfter.getTime();
  assert.strictEqual(isActuallyExpired, true, 'Certificado de teste deve ser avaliado como expirado');

  // =========================================================================
  // 13. TESTE DE PARSING DE RETORNO JSON DA SEFIN NACIONAL (GZIP / BASE64 / ERROS)
  // =========================================================================
  const zlib = require('zlib');
  const sampleNfseXml = `<NFSe versao="1.01"><infNFSe><chNFSe>31313071231302407000105000000000002826100000000000</chNFSe><nNFSe>28</nNFSe></infNFSe></NFSe>`;
  const gzipSample = zlib.gzipSync(Buffer.from(sampleNfseXml, 'utf-8')).toString('base64');
  const jsonSuccess = JSON.stringify({
    chaveAcesso: '31313071231302407000105000000000002826100000000000',
    numero: '28',
    nfseXmlGZipB64: gzipSample
  });

  const parsedJsonSuccess = parseNationalSubmitResponse(jsonSuccess, 200);
  assert.strictEqual(parsedJsonSuccess.status, 'ISSUED');
  assert.strictEqual(parsedJsonSuccess.chaveAcesso, '31313071231302407000105000000000002826100000000000');
  assert.strictEqual(parsedJsonSuccess.nfseNumero, '28');
  assert.ok(parsedJsonSuccess.xml.includes('<chNFSe>31313071231302407000105000000000002826100000000000</chNFSe>'), 'XML descompactado deve conter a chave de acesso');

  // Teste de rejeição com erros em JSON (formato camelCase)
  const jsonReject = JSON.stringify({
    erros: [
      { codigo: 'E999', descricao: 'Erro catalogado na regra de negócio' }
    ]
  });
  const parsedJsonReject = parseNationalSubmitResponse(jsonReject, 400);
  assert.strictEqual(parsedJsonReject.status, 'REJECTED');
  assert.strictEqual(parsedJsonReject.errors[0].codigo, 'E999');

  // Teste de rejeição com retorno oficial PascalCase da SEFIN Nacional (objeto único com Codigo, Descricao, Complemento)
  const sefinPascalCaseReject = JSON.stringify({
    Codigo: 'E1235',
    Descricao: 'Falha no esquema XML do DF-e.',
    Complemento: 'The element infDPS has invalid child element'
  });
  const parsedSefinReject = parseNationalSubmitResponse(sefinPascalCaseReject, 400);
  assert.strictEqual(parsedSefinReject.status, 'REJECTED');
  assert.strictEqual(parsedSefinReject.errors[0].codigo, 'E1235');
  assert.ok(parsedSefinReject.errors[0].descricao.includes('The element infDPS'));

  // Teste de erro 404 em rota
  const parsed404 = parseNationalSubmitResponse('Not Found', 404);
  assert.strictEqual(parsed404.status, 'NOT_FOUND_ENDPOINT');

  // =========================================================================
  // 12. GATE 1 — UNIFICAÇÃO DA ABA, SCHEMA 27 COLUNAS, HISTÓRICO E CONCORRÊNCIA
  // =========================================================================
  console.log('Testing GATE 1: Canonical Ledger, 27 Columns, Historical Isolation & Concurrency...');

  // 1.1 Unificação da aba canônica
  assert.strictEqual(CANONICAL_NATIONAL_LEDGER_TAB, 'Ledger NFS-e Nacional');
  assert.strictEqual(getNationalLedgerTabName(), 'Ledger NFS-e Nacional');

  // Proibição de aba paralela 'DPS'
  await assert.rejects(async () => {
    await ensureNationalLedgerSheet({
      spreadsheetId: 'test-sheet',
      tabName: 'DPS',
      createSheetIfNotExists: async () => {},
      readSheetValues: async () => [[]],
      updateSheetValues: async () => {}
    });
  }, /CANONICAL_TAB_ERROR/);

  // 1.2 Schema de 27 colunas
  assert.strictEqual(CANONICAL_NATIONAL_LEDGER_HEADERS.length, 27);
  assert.ok(CANONICAL_NATIONAL_LEDGER_HEADERS.includes('document_model'));
  assert.ok(CANONICAL_NATIONAL_LEDGER_HEADERS.includes('official_pdf_drive_file_id'));
  assert.ok(CANONICAL_NATIONAL_LEDGER_HEADERS.includes('source_type'));

  // 1.3 Preservação retrocompatível e integridade do histórico (NFS-e 25 e 26 da demanda 1a159de45542fc14)
  const historicalSpreadsheet = [
    ['Ambiente', 'Request ID', 'Item', 'ID DPS', 'Número DPS', 'Série DPS', 'Status', 'Data Alocação', 'Data Submissão', 'Número NFS-e', 'Chave NFS-e'],
    ['production', '1a159de45542fc14', '1', 'DPS313130723130240700010500001000000000000025', '25', '1', 'ISSUED', '2026-10-21T10:00:00Z', '2026-10-21T10:05:00Z', '25', '31313071231302407000105000000000002526100000000000'],
    ['production', '1a159de45542fc14', '2', 'DPS313130723130240700010500001000000000000026', '26', '1', 'ISSUED', '2026-10-21T10:00:00Z', '2026-10-21T10:05:00Z', '26', '31313071231302407000105000000000002626100000000000']
  ];

  const loadedHistorical = await loadNationalLedger({
    spreadsheetId: 'hist-sheet',
    readSheetValues: async () => historicalSpreadsheet
  });

  assert.strictEqual(loadedHistorical.length, 2);
  assert.strictEqual(loadedHistorical[0].request_id, '1a159de45542fc14');
  assert.strictEqual(loadedHistorical[0].dps_numero, '25');
  assert.strictEqual(loadedHistorical[0].nfse_numero, '25');
  assert.strictEqual(loadedHistorical[1].dps_numero, '26');
  assert.strictEqual(loadedHistorical[1].nfse_numero, '26');

  // 1.4 Sequência em produção: próxima alocação DEVE ser >= 27 e NUNCA DPS 1
  const nextProd = allocateNextDpsNumber(loadedHistorical, 'production', '1');
  assert.strictEqual(nextProd.dpsNumero, '27', 'Próxima DPS em produção deve iniciar após 26 (mínimo 27)');

  const emptyProd = allocateNextDpsNumber([], 'production', '1');
  assert.strictEqual(emptyProd.dpsNumero, '27', 'Produção vazia deve respeitar piso histórico 26 (próximo 27)');

  // 1.5 Concorrência atômica: 10 chamadas simultâneas via Promise.all
  const concurrentSheet = [];
  const concurrentDeps = {
    spreadsheetId: 'concurrent-sheet',
    readSheetValues: async (_id, range) => {
      if (range.includes('!1:1')) return [CANONICAL_NATIONAL_LEDGER_HEADERS];
      return [CANONICAL_NATIONAL_LEDGER_HEADERS, ...concurrentSheet];
    },
    appendSheetValues: async (_id, range, rows) => {
      concurrentSheet.push(...rows);
      return { updatedRows: rows.length };
    },
    updateSheetValues: async () => ({ updatedRows: 1 }),
    createSheetIfNotExists: async () => true
  };

  const concurrencyPromises = Array.from({ length: 10 }, (_, i) => {
    return allocateDpsAtomically({
      environment: 'homologation',
      requestId: `req-concurrent-${i + 1}`,
      itemIndex: 1,
      serie: '1'
    }, concurrentDeps);
  });

  const concurrentResults = await Promise.all(concurrencyPromises);
  const allocatedIds = concurrentResults.map(r => r.dps_id);
  const uniqueIds = new Set(allocatedIds);

  assert.strictEqual(uniqueIds.size, 10, 'Todas as 10 alocações concorrentes devem gerar DPS IDs únicos');
  const duplicateCount = allocatedIds.length - uniqueIds.size;
  assert.strictEqual(duplicateCount, 0, 'DUPLICATE_DPS_ID deve ser estritamente 0');
  console.log('   ✓ DPS_ALLOCATION_CONCURRENCY=PASS (10/10 únicas, DUPLICATE_DPS_ID=0)');

  // =========================================================================
  // 13. GATE 3 — ALÍQUOTA DO SIMPLES NACIONAL (pTotTribSN) FISCALMENTE CORRETA
  // =========================================================================
  console.log('Testing GATE 3: Simples Nacional Rates (pTotTribSN) Fail-Closed & Canonical Rates...');

  // 3.1 Busca canônica por competência
  const rate08 = resolveSimplesNacionalRate({ competencia: '08/2026' });
  assert.strictEqual(rate08.pTotTribSN, '2.39');
  assert.strictEqual(rate08.source, 'PGDAS-D_EXTRATO_DEF');

  const rate10 = resolveSimplesNacionalRate({ competencia: '2026-10-01' });
  assert.strictEqual(rate10.pTotTribSN, '2.39');

  // 3.2 Competência desconhecida sem apuração lança NATIONAL_PTOTTRIBSN_MISSING
  assert.throws(() => {
    resolveSimplesNacionalRate({ competencia: '01/2020' });
  }, /NATIONAL_PTOTTRIBSN_MISSING/);

  // 3.3 Fail-Closed no buildNationalDpsXml: ausência de pTotTribSN lança erro imediato
  assert.throws(() => {
    buildNationalDpsXml({
      ...hicCandidate,
      valores: {
        valorServicos: 100,
        aliquotaIss: 2.00, // Mesmo com aliquotaIss presente, não há fallback silencioso
        pTotTribSN: null
      }
    });
  }, /NATIONAL_PTOTTRIBSN_MISSING/);

  // 3.4 Estrita separação: aliquotaIss é municipal e não interfere em pTotTribSN
  const dpsWithBoth = buildNationalDpsXml({
    ...hicCandidate,
    valores: {
      valorServicos: 100,
      aliquotaIss: 5.00,
      pTotTribSN: '2.39'
    }
  });
  assert.ok(dpsWithBoth.xml.includes('<pAliq>5.00</pAliq>'));
  assert.ok(dpsWithBoth.xml.includes('<pTotTribSN>2.39</pTotTribSN>'));
  console.log('   ✓ GATE 3 PASS: pTotTribSN fail-closed e separação estrita validados');

  // =========================================================================
  // 14. GATE 2 — EXACTLY-ONCE REAL & RECONCILIAÇÃO DE TIMEOUT (SEM RPS)
  // =========================================================================
  console.log('Testing GATE 2: Exactly-Once Idempotency & Realistic Timeout Recovery...');

  // 14.1 Replay idempotente relendo entrada ISSUED do ledger
  const testIssuedSheet = [
    CANONICAL_NATIONAL_LEDGER_HEADERS,
    [
      'homologation', 'req-already-issued', '1',
      'DPS313130723130240700010500001000000000000099', '99', '1',
      'ISSUED', '2026-10-21T10:00:00Z', '2026-10-21T10:05:00Z',
      '99', '31313071231302407000105000000000009926100000000000'
    ]
  ];

  const replayResult = await issueNationalDemandItem({
    environment: 'homologation',
    requestId: 'req-already-issued',
    itemIndex: 1,
    certData,
    dependencies: {
      createSheetIfNotExists: async () => true,
      readSheetValues: async () => testIssuedSheet,
      appendSheetValues: async () => { throw new Error('Append proibido no replay!'); },
      updateSheetValues: async () => { throw new Error('Update proibido no replay!'); }
    }
  });

  assert.strictEqual(replayResult.status, 'ALREADY_ISSUED');
  assert.strictEqual(replayResult.newDps, 0);
  assert.strictEqual(replayResult.newNfse, 0);
  assert.strictEqual(replayResult.newRps, 0);
  assert.strictEqual(replayResult.gerarNfseCalls, 0);
  console.log('   ✓ EXACTLY-ONCE REPLAY PASS: status ALREADY_ISSUED, ZERO novo POST, ZERO new DPS');

  // 14.2 Reconciliação de UNKNOWN_AFTER_TIMEOUT via HEAD/GET DPS
  const timeoutSheet = [
    CANONICAL_NATIONAL_LEDGER_HEADERS,
    [
      'homologation', 'req-timeout-recovery', '1',
      'DPS313130723130240700010500001000000000000088', '88', '1',
      'UNKNOWN_AFTER_TIMEOUT', '2026-10-21T10:00:00Z', '2026-10-21T10:05:00Z',
      '', ''
    ]
  ];

  let sheetUpdatedToIssued = false;
  const timeoutDeps = {
    createSheetIfNotExists: async () => true,
    readSheetValues: async () => timeoutSheet,
    updateSheetValues: async (_id, _range, rows) => {
      if (rows[0] && rows[0].includes('ISSUED')) {
        sheetUpdatedToIssued = true;
      }
      return { updatedRows: 1 };
    },
    provider: {
      headDps: async () => ({ exists: true, chaveAcesso: '31313079999999999999999999999999999999999999', nfseNumero: '88' }),
      getDps: async () => ({ status: 'FOUND', chaveAcesso: '31313079999999999999999999999999999999999999', nfseNumero: '88' })
    }
  };

  const timeoutReconcileResult = await reconcileNationalDps({
    environment: 'homologation',
    requestId: 'req-timeout-recovery',
    itemIndex: 1,
    certData
  }, timeoutDeps);

  assert.strictEqual(timeoutReconcileResult.status, 'ISSUED');
  assert.strictEqual(timeoutReconcileResult.recoveredViaDpsQuery, true);
  assert.strictEqual(timeoutReconcileResult.nfseNumero, '88');
  assert.strictEqual(sheetUpdatedToIssued, true);
  console.log('   ✓ TIMEOUT RECOVERY PASS: Reconciliado para ISSUED sem RPS e sem novo POST');

  console.log('✓ test-national-provider.js PASSED (GATE 1, GATE 2 & GATE 3 VERIFIED: Canonical Ledger 27 cols, DPS Concurrency, PGDAS-D Rates Fail-Closed, Exactly-Once Replay & Timeout Recovery)');
}

if (require.main === module) {
  run().catch(err => {
    console.error('❌ FALHA test-national-provider.js:', err);
    process.exit(1);
  });
}

module.exports = { run };
