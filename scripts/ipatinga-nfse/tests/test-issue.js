'use strict';

const assert = require('assert');
const forge = require('node-forge');
const {
  buildConsultarNfsePorRpsEnvio,
  parseGerarNfseResposta,
  reconcileRps,
  issueHomologation
} = require('../issue');
const { RPS_STATUS, RECONCILIATION_STATUS } = require('../ledger');

console.log('Running test-issue.js...');

// Cria certificado autoassinado em memória para os testes
const keypair = forge.pki.rsa.generateKeyPair(1024);
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
  ['CNPJ', 'Razão Social', 'Nome Curto', 'Logradouro', 'Número', 'Complemento', 'Bairro', 'Cód. Município', 'Município', 'UF', 'CEP', 'Fonte Endereço', 'Validado Em', 'Categorias Conhecidas', 'Status Homologação'],
  ['20.724.357/0001-20', 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO', 'HIC', 'CAPITAO BERNARDO', '257', '', 'CENTRO', '3128006', 'GUANHAES', 'MG', '39740000', 'NFS-e histórica', '2026-08-22', 'HIC', 'HOMOLOGADO']
];
const mockPatterns = [
  ['ID Padrão', 'Nome Padrão', 'Tomador', 'CNPJ Tomador', 'Categoria', 'Template / Descrição Oficial', 'Cód. Trib. Nacional', 'Cód. Trib. Municipal', 'Local Prestação', 'Cód. Município Prestação', 'Cód. Município Incidência', 'NBS', 'Confiança', 'Status'],
  ['HIC_PLANTOES_PS_SUS', 'HIC Plantões', 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO', '20.724.357/0001-20', 'HIC — Plantões PS SUS', '', '04.03.01', '403', 'Guanhães/MG', '3128006', '3131307', '123011900', 'ALTA', 'VALIDADO']
];

function mockSheetReader(overrides = {}) {
  return async (_id, range) => {
    const norm = String(range || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (norm.includes('rps')) return overrides.rps || [];
    if (norm.includes('demanda')) return overrides.demandas || mockDemandas;
    if (norm.includes('tomador')) return overrides.tomadores || mockTomadores;
    if (norm.includes('padro')) return overrides.padroes || mockPatterns;
    if (norm.includes('nota')) return overrides.notas || [];
    return [];
  };
}

async function run() {
  // 1. Testa builder de consulta por RPS com escape e tag correta ConsultarNfseRpsEnvio
  const queryXml = buildConsultarNfsePorRpsEnvio({ rpsNumero: '1001', rpsSerie: 'A', rpsTipo: '1' });
  assert.ok(queryXml.includes('<Numero>1001</Numero>'));
  assert.ok(queryXml.includes('<ConsultarNfseRpsEnvio'));

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

  const parsed = parseGerarNfseResposta(sampleSuccessResponse);
  assert.strictEqual(parsed.hasNfse, true);
  assert.strictEqual(parsed.numero, '95001');
  assert.strictEqual(parsed.codigoVerificacao, 'ABC123XYZ');

  // 3. Testa issueHomologation em DRY-RUN
  const dryResult = await issueHomologation({
    requestId: 'req-test-homolog',
    itemIndex: 1,
    certData,
    dryRun: true
  }, {
    readSheetValues: mockSheetReader()
  });

  assert.strictEqual(dryResult.status, 'DRY_RUN_SUCCESS');
  assert.strictEqual(dryResult.gerarNfseCalls, 0);
  assert.strictEqual(dryResult.externalWrites, 0);
  assert.strictEqual(dryResult.xsdValidation, 'VALIDATED_OFFICIAL_XSD');
  assert.strictEqual(dryResult.xmlSignature, 'VALIDATED_XMLDSIG_C14N');
  assert.ok(dryResult.xmlSha256);

  // 4. Testa reconcileRps diretamente
  const mockRpsStorage = [
    ['environment', 'request_id', 'item_index', 'rps_numero', 'rps_serie', 'rps_tipo', 'status', 'allocated_at', 'submitted_at', 'nfse_numero', 'nfse_chave', 'last_query_at', 'attempt_count', 'last_attempt_at', 'provider_error_codes', 'provider_message', 'error'],
    ['homologation', 'req-reconcile-test', '1', '1003', 'A', '1', 'SUBMITTED_ASYNC_PROCESSING', '2026-08-22T10:00:00Z', '2026-08-22T10:00:01Z', '', '', '', '1', '2026-08-22T10:00:01Z', '', '', '']
  ];

  const recResult = await reconcileRps({
    environment: 'homologation',
    rpsNumero: '1003',
    certData
  }, {
    readSheetValues: mockSheetReader({ rps: mockRpsStorage }),
    updateSheetValues: async (_id, _range, rows) => { mockRpsStorage[1] = rows[0]; },
    callSoapOperation: async () => ({
      outputXml: `<ConsultarNfseRpsResposta xmlns="http://www.abrasf.org.br/nfse.xsd">
        <CompNfse><Nfse><InfNfse><Numero>95003</Numero><CodigoVerificacao>CHAVE95003</CodigoVerificacao><DataEmissao>2026-08-22T10:05:00</DataEmissao></InfNfse></Nfse></CompNfse>
      </ConsultarNfseRpsResposta>`
    })
  });

  assert.strictEqual(recResult.status, RECONCILIATION_STATUS.ISSUED);
  assert.strictEqual(recResult.nfseNumero, '95003');
  assert.strictEqual(mockRpsStorage[1][6], RPS_STATUS.ISSUED);
  assert.strictEqual(mockRpsStorage[1][9], '95003');

  // 5. Testa idempotência com status ISSUED já no Ledger
  const idempotentResult = await issueHomologation({
    requestId: 'req-reconcile-test',
    itemIndex: 1,
    certData,
    dryRun: false
  }, {
    readSheetValues: mockSheetReader({ rps: mockRpsStorage }),
    updateSheetValues: async () => {},
    appendSheetValues: async () => {}
  });

  assert.strictEqual(idempotentResult.status, 'ALREADY_ISSUED');
  assert.strictEqual(idempotentResult.nfseNumero, '95003');
  assert.strictEqual(idempotentResult.gerarNfseCalls, 0);

  // 6. Testa Reemissão autorizada após REJECTED_CORRECTABLE e NOT_FOUND_CONFIRMED
  let soapCallsCount = 0;
  const mockLedgerRejected = [
    ['environment', 'request_id', 'item_index', 'rps_numero', 'rps_serie', 'rps_tipo', 'status', 'allocated_at', 'submitted_at', 'nfse_numero', 'nfse_chave', 'last_query_at', 'attempt_count', 'last_attempt_at', 'provider_error_codes', 'provider_message', 'error'],
    ['homologation', 'req-test-homolog', '1', '1001', 'A', '1', 'REJECTED_CORRECTABLE', '2026-08-22T10:00:00Z', '2026-08-22T10:00:01Z', '', '', '2026-08-22T10:00:05Z', '1', '2026-08-22T10:00:01Z', 'EL78', 'Tag endereco ausente', 'EL78']
  ];

  const retryResult = await issueHomologation({
    requestId: 'req-test-homolog',
    itemIndex: 1,
    certData,
    dryRun: false
  }, {
    readSheetValues: mockSheetReader({ rps: mockLedgerRejected }),
    updateSheetValues: async () => {},
    appendSheetValues: async () => {},
    callSoapOperation: async ({ operation }) => {
      soapCallsCount++;
      if (operation === 'ConsultarNfsePorRps') {
        return { outputXml: '<ConsultarNfseRpsResposta xmlns="http://www.abrasf.org.br/nfse.xsd"><ListaMensagemRetorno><MensagemRetorno><Codigo>E4</Codigo><Mensagem>RPS nao encontrado</Mensagem></MensagemRetorno></ListaMensagemRetorno></ConsultarNfseRpsResposta>' };
      }
      if (operation === 'GerarNfse') {
        return { outputXml: sampleSuccessResponse };
      }
      return { outputXml: '' };
    }
  });

  assert.strictEqual(retryResult.status, 'ISSUED');
  assert.strictEqual(retryResult.nfseNumero, '95001');
  assert.strictEqual(soapCallsCount, 2); // 1 ConsultarNfsePorRps + 1 GerarNfse

  console.log('✓ test-issue.js PASSED');
}

module.exports = run();
