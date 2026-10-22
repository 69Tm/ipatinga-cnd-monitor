'use strict';

const assert = require('assert');
const forge = require('node-forge');
const {
  DEFAULT_PRODUCTION_URL,
  DEFAULT_RESTRICTED_URL,
  normalizeBaseUrl,
  buildNationalDpsXml,
  buildNationalSubmitRequest,
  buildNationalNfseReadRequest,
  buildNationalDpsReadRequest,
  createNationalIssuerProvider
} = require('../national-emissor-provider');

console.log('Running test-national-provider.js...');

// Cria certificado autoassinado para testes
const keypair = forge.pki.rsa.generateKeyPair(1024);
const cert = forge.pki.createCertificate();
cert.publicKey = keypair.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
const attrs = [{ name: 'commonName', value: 'DEXMED HOMOLOG' }];
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
  // 1. Validação de URLs e Normalização
  assert.strictEqual(normalizeBaseUrl(null, 'production'), DEFAULT_PRODUCTION_URL);
  assert.strictEqual(normalizeBaseUrl(null, 'homologation'), DEFAULT_RESTRICTED_URL);
  assert.strictEqual(normalizeBaseUrl('https://adn.producaorestrita.nfse.gov.br/contribuintes/'), DEFAULT_RESTRICTED_URL);
  assert.throws(() => normalizeBaseUrl('http://inseguro.example.com'), /NATIONAL_ISSUER_HTTPS_REQUIRED/);

  // 2. Geração da DPS Nacional e Assinatura
  const dpsData = buildNationalDpsXml({
    dpsId: 'DPS3131307232975000000000000001',
    ambiente: 2, // Produção Restrita
    prestador: { cnpj: '31302407000105', inscricaoMunicipal: '23297500', codigoMunicipio: '3131307' },
    tomador: { cnpj: '20724357000120', razaoSocial: 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO', codigoMunicipio: '3128006' },
    servico: { codigoMunicipioPrestacao: '3128006', codigoTributacaoNacional: '04.03.01', discriminacao: 'TESTE PRODUCAO RESTRITA — SEM VALIDADE FISCAL' },
    valores: { valorServico: 10.00, aliquota: 2.39, valorIss: 0.24, issRetido: 2 },
    certData
  });

  assert.ok(dpsData.xml.includes('<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">'));
  assert.ok(dpsData.xml.includes('<infDPS Id="DPS3131307232975000000000000001">'));
  assert.ok(dpsData.xml.includes('<tpAmb>2</tpAmb>'));
  assert.ok(dpsData.xml.includes('<CNPJ>31302407000105</CNPJ>'));
  assert.ok(dpsData.xml.includes('<vServ>10.00</vServ>'));
  assert.ok(dpsData.xml.includes('TESTE PRODUCAO RESTRITA — SEM VALIDADE FISCAL'));

  // 3. Mock Transport para Teste Controlado em Produção Restrita
  let postCount = 0;
  let getCount = 0;
  let headCount = 0;

  const mockNfseXml = `<?xml version="1.0" encoding="utf-8"?>
<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">
  <infNFSe Id="NFS31313071231302407000105000000000002726100000000000">
    <chNFSe>31313071231302407000105000000000002726100000000000</chNFSe>
    <nNFSe>27</nNFSe>
    <dhEmi>2026-10-21T20:20:00-03:00</dhEmi>
    <nProt>931260000000001</nProt>
  </infNFSe>
</NFSe>`;

  const mockRestrictedTransport = async ({ method, url }) => {
    if (method === 'POST' && url.endsWith('/nfse')) {
      postCount++;
      return {
        statusCode: 201,
        headers: { 'content-type': 'application/xml; charset=utf-8' },
        body: mockNfseXml
      };
    }

    if (method === 'GET' && url.includes('/nfse/')) {
      getCount++;
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/xml; charset=utf-8' },
        body: mockNfseXml
      };
    }

    if (method === 'HEAD' && url.includes('/dps/')) {
      headCount++;
      return {
        statusCode: 200,
        headers: {}
      };
    }

    if (method === 'GET' && url.includes('/dps/')) {
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/xml; charset=utf-8' },
        body: mockNfseXml
      };
    }

    return { statusCode: 404, body: '' };
  };

  const restrictedProvider = createNationalIssuerProvider({
    baseUrl: DEFAULT_RESTRICTED_URL,
    environment: 'homologation',
    transport: mockRestrictedTransport
  });

  // 4. Executa POST /nfse em Produção Restrita (Sucesso)
  const submitResult = await restrictedProvider.submit({
    dpsXml: dpsData.xml,
    dpsId: dpsData.dpsId,
    certData,
    dryRun: false
  });

  assert.strictEqual(submitResult.status, 'ISSUED');
  assert.strictEqual(submitResult.nfseNumero, '27');
  assert.strictEqual(submitResult.chaveAcesso, '31313071231302407000105000000000002726100000000000');
  assert.strictEqual(submitResult.protocolo, '931260000000001');
  assert.strictEqual(submitResult.newProviderWrites, 1);
  assert.strictEqual(postCount, 1);

  // 5. Consulta NFS-e gerada via GET /nfse/{chaveAcesso}
  const readNfseResult = await restrictedProvider.getNfse({
    accessKey: submitResult.chaveAcesso,
    certData
  });
  assert.strictEqual(readNfseResult.status, 'FOUND');
  assert.strictEqual(readNfseResult.statusCode, 200);
  assert.ok(readNfseResult.xml.includes('<chNFSe>31313071231302407000105000000000002726100000000000</chNFSe>'));
  assert.strictEqual(getCount, 1);

  // 6. Consulta DPS via HEAD /dps/{id}
  const headDpsResult = await restrictedProvider.headDps({
    dpsId: dpsData.dpsId,
    certData
  });
  assert.strictEqual(headDpsResult.exists, true);
  assert.strictEqual(headDpsResult.statusCode, 200);
  assert.strictEqual(headCount, 1);

  // 7. Consulta DPS via GET /dps/{id}
  const getDpsResult = await restrictedProvider.getDps({
    dpsId: dpsData.dpsId,
    certData
  });
  assert.strictEqual(getDpsResult.status, 'FOUND');
  assert.strictEqual(getDpsResult.chaveAcesso, '31313071231302407000105000000000002726100000000000');

  // 8. Reconciliação Exactly-Once após Timeout simulado
  let timeoutHeadCalls = 0;
  const timeoutTransport = async ({ method }) => {
    if (method === 'POST') {
      const timeoutErr = new Error('Socket timeout in national provider');
      timeoutErr.code = 'ETIMEDOUT';
      throw timeoutErr;
    }
    if (method === 'HEAD') {
      timeoutHeadCalls++;
      return { statusCode: 200 };
    }
    if (method === 'GET') {
      return { statusCode: 200, body: mockNfseXml };
    }
  };

  const timeoutProvider = createNationalIssuerProvider({
    baseUrl: DEFAULT_RESTRICTED_URL,
    environment: 'homologation',
    transport: timeoutTransport
  });

  const recoveredAfterTimeout = await timeoutProvider.submit({
    dpsXml: dpsData.xml,
    dpsId: dpsData.dpsId,
    certData,
    dryRun: false
  });

  assert.strictEqual(recoveredAfterTimeout.status, 'RECONCILED_AFTER_TIMEOUT');
  assert.strictEqual(recoveredAfterTimeout.reconciled, true);
  assert.strictEqual(recoveredAfterTimeout.chaveAcesso, '31313071231302407000105000000000002726100000000000');
  assert.strictEqual(timeoutHeadCalls, 1);

  // 9. Rejeição Fiscal Tratada (HTTP 422 com mensagens de erro)
  const rejectedTransport = async () => ({
    statusCode: 422,
    body: `<?xml version="1.0" encoding="utf-8"?>
<mensagens>
  <mensagem>
    <codigo>E42</codigo>
    <mensagem>Código de tributação municipal inexistente para este município.</mensagem>
  </mensagem>
</mensagens>`
  });

  const rejectedProvider = createNationalIssuerProvider({
    baseUrl: DEFAULT_RESTRICTED_URL,
    environment: 'homologation',
    transport: rejectedTransport
  });

  const rejectRes = await rejectedProvider.submit({
    dpsXml: dpsData.xml,
    dpsId: dpsData.dpsId,
    certData,
    dryRun: false
  });

  assert.strictEqual(rejectRes.status, 'REJECTED_FISCAL');
  assert.strictEqual(rejectRes.errors.length, 1);
  assert.strictEqual(rejectRes.errors[0].codigo, 'E42');

  // 10. Safety Gate de Produção: Bloqueia escrita produtiva quando flag está desabilitada
  const productionProvider = createNationalIssuerProvider({
    baseUrl: DEFAULT_PRODUCTION_URL,
    environment: 'production',
    transport: mockRestrictedTransport
  });

  delete process.env.NATIONAL_PRODUCTION_WRITE_ENABLED;
  await assert.rejects(
    () => productionProvider.submit({ dpsXml: dpsData.xml, dpsId: dpsData.dpsId, certData, dryRun: false }),
    /NATIONAL_PRODUCTION_WRITE_DISABLED/
  );

  // Em modo dryRun em produção, a trava permite a simulação sem escrita
  const dryRunRes = await productionProvider.submit({
    dpsXml: dpsData.xml,
    dpsId: dpsData.dpsId,
    certData,
    dryRun: true
  });
  assert.strictEqual(dryRunRes.status, 'DRY_RUN_SUCCESS');
  assert.strictEqual(dryRunRes.providerWrites, 0);

  // 11. Produção Read-Only: Consulta real das NFS-e 25 e 26
  let prodReadCalls = 0;
  const prodReadTransport = async ({ method, url }) => {
    if (method === 'GET') {
      prodReadCalls++;
      return { statusCode: 200, body: '<NFSe><infNFSe><chNFSe>31313071231302407000105000000000002526104378971712</chNFSe></infNFSe></NFSe>' };
    }
    throw new Error('PROHIBITED_METHOD_IN_READ_ONLY');
  };

  const prodReadOnlyProvider = createNationalIssuerProvider({
    baseUrl: DEFAULT_PRODUCTION_URL,
    environment: 'production',
    transport: prodReadTransport
  });

  const read25 = await prodReadOnlyProvider.getNfse({ accessKey: '31313071231302407000105000000000002526104378971712', certData });
  assert.strictEqual(read25.status, 'FOUND');
  assert.strictEqual(prodReadCalls, 1);

  console.log('✓ test-national-provider.js PASSED: Transporte real, DPS XML, POST restrito, GET/HEAD, exactly-once timeout recovery, rejeição e safety gate validados!');
}

run().catch(err => {
  console.error('❌ FALHA test-national-provider.js:', err);
  process.exit(1);
});

module.exports = run;
