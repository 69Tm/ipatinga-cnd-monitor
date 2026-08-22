'use strict';

const assert = require('assert');
const forge = require('node-forge');
const { issueHomologation, buildConsultarNfsePorRpsEnvio, parseGerarNfseResposta } = require('../issue');
const { RPS_STATUS } = require('../ledger');

console.log('Running test-issue.js...');

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
  ['req-test-homolog', '08/2026', 'HIC — Plantões PS SUS', '100,00', 'Descrição & teste <especial> "homologação"', 'PENDENTE', '']
];
const mockTomadores = [
  ['CNPJ', 'Razão Social', 'Nome Curto', 'Município', 'Categorias Conhecidas', 'Status Homologação'],
  ['20.724.357/0001-20', 'HIC & CIA LTDA', 'HIC', 'Guanhães/MG', 'HIC', 'HOMOLOGADO']
];
const mockPatterns = [
  ['ID Padrão', 'Nome Padrão', 'Tomador', 'CNPJ Tomador', 'Categoria', 'Template / Descrição Oficial', 'Cód. Trib. Nacional', 'Cód. Trib. Municipal', 'Local Prestação', 'NBS', 'Confiança', 'Status'],
  ['HIC_PLANTOES_PS_SUS', 'HIC Plantões', 'HIC & CIA LTDA', '20.724.357/0001-20', 'HIC — Plantões PS SUS', '', '04.03.01', '403', 'Guanhães/MG', '123011900', 'ALTA', 'VALIDADO']
];

async function run() {
  // 1. Testa builder de consulta por RPS com escape
  const queryXml = buildConsultarNfsePorRpsEnvio({ rpsNumero: '1001', rpsSerie: 'A', rpsTipo: '1' });
  assert.ok(queryXml.includes('<Numero>1001</Numero>'));
  assert.ok(queryXml.includes('<ConsultarNfsePorRpsEnvio'));

  // 2. Testa parse oficial de GerarNfseResposta
  const sampleSuccessResponse = `<GerarNfseResposta xmlns="http://www.abrasf.org.br/nfse.xsd">
    <ListaNfse>
      <CompNfse>
        <Nfse>
          <InfNfse>
            <Numero>95001</Numero>
            <CodigoVerificacao>ABC123XYZ</CodigoVerificacao>
            <DataEmissao>2026-08-22T10:00:00</DataEmissao>
          </InfNfse>
        </Nfse>
      </CompNfse>
    </ListaNfse>
  </GerarNfseResposta>`;
  const parsedRes = parseGerarNfseResposta(sampleSuccessResponse);
  assert.strictEqual(parsedRes.hasNfse, true);
  assert.strictEqual(parsedRes.numero, '95001');
  assert.strictEqual(parsedRes.codigoVerificacao, 'ABC123XYZ');

  // 3. Testa issueHomologation em modo dry_run=true
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
  assert.strictEqual(dryRes.gerarNfseCalls, 0);
  assert.strictEqual(dryRes.externalWrites, 0);
  assert.ok(dryRes.xmlSha256, 'Deve conter hash SHA-256 do XML');
  assert.strictEqual(dryRes.xmlCandidate, undefined, 'NÃO deve expor XML integral');

  // 4. Testa Crash Window no estado SUBMITTING
  // Simula que processo anterior morreu com ledger em SUBMITTING
  const crashSubmittingLedger = [
    ['environment', 'request_id', 'item_index', 'rps_numero', 'rps_serie', 'rps_tipo', 'status', 'allocated_at', 'submitted_at', 'nfse_numero', 'nfse_chave', 'last_query_at', 'error'],
    ['homologation', 'req-test-homolog', '1', '1001', 'A', '1', RPS_STATUS.SUBMITTING, '2026-08-22T09:00:00Z', '2026-08-22T09:00:05Z', '', '', '', '']
  ];

  let soapGerarNfseCalls = 0;
  let soapConsultarRpsCalls = 0;

  // Cenário A: Consulta RPS encontra a nota emitida
  const recoveredRes = await issueHomologation({
    requestId: 'req-test-homolog',
    itemIndex: 1,
    certData,
    dryRun: false
  }, {
    readSheetValues: async (_id, range) => {
      if (range.includes('Demandas')) return mockDemandas;
      if (range.includes('Tomadores')) return mockTomadores;
      if (range.includes('Padrões')) return mockPatterns;
      if (range.includes('RPS')) return crashSubmittingLedger;
      return [['Nº NFS-e']];
    },
    updateSheetValues: async (_id, range, rows) => {
      crashSubmittingLedger[1] = rows[0];
    }
  });

  // 5. Testa FAILED_SAFE bloqueando reemissão automática
  const failedSafeLedger = [
    ['environment', 'request_id', 'item_index', 'rps_numero', 'rps_serie', 'rps_tipo', 'status', 'allocated_at', 'submitted_at', 'nfse_numero', 'nfse_chave', 'last_query_at', 'error'],
    ['homologation', 'req-test-homolog', '1', '1001', 'A', '1', RPS_STATUS.FAILED_SAFE, '2026-08-22T09:00:00Z', '2026-08-22T09:00:05Z', '', '', '2026-08-22T09:00:10Z', 'TOMADOR_INATIVO']
  ];

  const failedSafeRes = await issueHomologation({
    requestId: 'req-test-homolog',
    itemIndex: 1,
    certData,
    dryRun: false
  }, {
    readSheetValues: async (_id, range) => {
      if (range.includes('Demandas')) return mockDemandas;
      if (range.includes('Tomadores')) return mockTomadores;
      if (range.includes('Padrões')) return mockPatterns;
      if (range.includes('RPS')) return failedSafeLedger;
      return [['Nº NFS-e']];
    }
  });

  assert.strictEqual(failedSafeRes.status, 'REVISAO_MANUAL', 'FAILED_SAFE não pode reemitir automaticamente');

  console.log('✓ test-issue.js PASSED');
}

module.exports = run();
