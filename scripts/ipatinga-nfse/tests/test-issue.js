'use strict';

const assert = require('assert');
const forge = require('node-forge');
const { issueHomologation, buildConsultarNfsePorRpsEnvio } = require('../issue');
const { RPS_STATUS } = require('../ledger');

console.log('Running test-issue.js...');

// Cria certificado e chave sintéticos
const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
const cert = forge.pki.createCertificate();
cert.publicKey = keypair.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
const attrs = [{ name: 'commonName', value: 'DEXMED HOMOLOG TEST' }];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.sign(keypair.privateKey, forge.md.sha256.create());

const certData = {
  loaded: true,
  isValid: true,
  pemCert: forge.pki.certificateToPem(cert),
  pemKey: forge.pki.privateKeyToPem(keypair.privateKey)
};

const mockDemandas = [
  ['Message ID', 'Período', 'Notas solicitadas', 'Valores', 'Descrição obrigatória', 'Status', 'NFS-e resultantes'],
  ['req-test-homolog', '08/2026', 'HIC — Plantões PS SUS', '100,00', 'Descrição teste homologação', 'PENDENTE', '']
];
const mockTomadores = [
  ['CNPJ', 'Razão Social', 'Nome Curto', 'Município', 'Categorias Conhecidas', 'Status Homologação'],
  ['20.724.357/0001-20', 'HIC', 'HIC', 'Guanhães/MG', 'HIC', 'HOMOLOGADO']
];
const mockPatterns = [
  ['ID Padrão', 'Nome Padrão', 'Tomador', 'CNPJ Tomador', 'Categoria', 'Template / Descrição Oficial', 'Cód. Trib. Nacional', 'Cód. Trib. Municipal', 'Local Prestação', 'NBS', 'Confiança', 'Status'],
  ['HIC_PLANTOES_PS_SUS', 'HIC Plantões', 'HIC', '20.724.357/0001-20', 'HIC — Plantões PS SUS', '', '04.03.01', '403', 'Guanhães/MG', '123011900', 'ALTA', 'VALIDADO']
];

async function run() {
  // 1. Testa builder de consulta por RPS
  const queryXml = buildConsultarNfsePorRpsEnvio({ rpsNumero: '1001', rpsSerie: 'A', rpsTipo: '1' });
  assert.ok(queryXml.includes('<Numero>1001</Numero>'));
  assert.ok(queryXml.includes('<ConsultarNfsePorRpsEnvio'));

  // 2. Testa issueHomologation em modo dry_run
  const dryRes = await issueHomologation({
    requestId: 'req-test-homolog',
    itemIndex: 1,
    certData,
    dryRun: true
  }, {
    readSheetValues: async (_id, range) => {
      if (range.includes('Demandas')) return mockDemandas;
      if (range.includes('Tomadores')) return mockTomadores;
      if (range.includes('Padrões')) return mockPatterns;
      if (range.includes('RPS')) return [['environment', 'request_id', 'item_index', 'rps_numero', 'rps_serie', 'rps_tipo', 'status']];
      return [['Nº NFS-e']];
    }
  });

  assert.strictEqual(dryRes.status, 'DRY_RUN_SUCCESS');
  assert.strictEqual(dryRes.environment, 'homologation');
  assert.strictEqual(dryRes.rpsNumero, '1001');
  assert.ok(dryRes.xmlCandidate.includes('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">'));

  // 3. Testa idempotência (ALREADY_ISSUED) quando o Ledger já registra a nota emitida
  const alreadyIssuedRes = await issueHomologation({
    requestId: 'req-test-homolog',
    itemIndex: 1,
    certData,
    dryRun: false
  }, {
    readSheetValues: async (_id, range) => {
      if (range.includes('Demandas')) return mockDemandas;
      if (range.includes('Tomadores')) return mockTomadores;
      if (range.includes('Padrões')) return mockPatterns;
      if (range.includes('RPS')) {
        return [
          ['environment', 'request_id', 'item_index', 'rps_numero', 'rps_serie', 'rps_tipo', 'status', 'allocated_at', 'submitted_at', 'nfse_numero', 'nfse_chave', 'last_query_at', 'error'],
          ['homologation', 'req-test-homolog', '1', '1001', 'A', '1', RPS_STATUS.ISSUED, '2026-08-22T09:00:00Z', '2026-08-22T09:00:05Z', '9999', 'CHAVE999', '2026-08-22T09:00:10Z', '']
        ];
      }
      return [['Nº NFS-e']];
    }
  });

  assert.strictEqual(alreadyIssuedRes.status, 'ALREADY_ISSUED');
  assert.strictEqual(alreadyIssuedRes.nfseNumero, '9999');

  console.log('✓ test-issue.js PASSED');
}

module.exports = run();
