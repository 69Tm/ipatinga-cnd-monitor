'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { fetchOfficialNfseDocument, ensureDocumentosSheet, sendOfficialDocumentCallback } = require('../documents');

console.log('Running test-documents.js...');

async function runDocumentsTests() {
  const sampleOfficialXml = `<?xml version="1.0" encoding="utf-8"?>
<ConsultarNfseRpsResposta xmlns="http://www.abrasf.org.br/nfse.xsd">
  <CompNfse>
    <Nfse versao="2.04">
      <InfNfse Id="NFSE18">
        <Numero>18</Numero>
        <CodigoVerificacao>JGKL748V</CodigoVerificacao>
        <DataEmissao>2026-08-25T14:30:00</DataEmissao>
        <ValoresNfse>
          <ValorServicos>10.00</ValorServicos>
          <Aliquota>0.02</Aliquota>
          <ValorIss>0.20</ValorIss>
          <ValorLiquidoNfse>10.00</ValorLiquidoNfse>
        </ValoresNfse>
        <DeclaracaoPrestacaoServico>
          <InfDeclaracaoPrestacaoServico>
            <Rps>
              <IdentificacaoRps>
                <Numero>103</Numero>
                <Serie>A</Serie>
                <Tipo>1</Tipo>
              </IdentificacaoRps>
            </Rps>
            <Competencia>2026-08-01</Competencia>
            <Servico>
              <Valores>
                <ValorServicos>10.00</ValorServicos>
              </Valores>
              <ItemListaServico>04.01</ItemListaServico>
              <Discriminacao>SERVICOS MEDICOS PLANTAO</Discriminacao>
              <CodigoMunicipio>3131307</CodigoMunicipio>
            </Servico>
            <Prestador>
              <CpfCnpj><Cnpj>31302407000105</Cnpj></CpfCnpj>
              <InscricaoMunicipal>23297500</InscricaoMunicipal>
            </Prestador>
            <TomadorServico>
              <IdentificacaoTomador>
                <CpfCnpj><Cnpj>20724357000120</Cnpj></CpfCnpj>
              </IdentificacaoTomador>
              <RazaoSocial>HOSPITAL IC</RazaoSocial>
            </TomadorServico>
          </InfDeclaracaoPrestacaoServico>
        </DeclaracaoPrestacaoServico>
      </InfNfse>
    </Nfse>
  </CompNfse>
</ConsultarNfseRpsResposta>`;

  const rawOfficialBytes = Buffer.from(sampleOfficialXml, 'utf8');
  const expectedSha256 = crypto.createHash('sha256').update(rawOfficialBytes).digest('hex');

  // Mocks
  let soapCalls = [];
  let driveUploads = [];
  let sheetAppends = [];
  let sheetUpdates = [];
  let mockLedger = [
    {
      environment: 'production',
      request_id: '1a03eb59b2dd3e5f',
      item_index: '1',
      rps_numero: '103',
      rps_serie: 'A',
      rps_tipo: '1',
      status: 'ISSUED',
      nfse_numero: '18',
      nfse_chave: 'JGKL748V'
    }
  ];

  let mockSheetData = {
    'Documentos!A:K': [
      ['request_id', 'item_index', 'rps_numero', 'nfse_numero', 'tipo', 'source', 'drive_file_id', 'sha256', 'status', 'created_at', 'error']
    ],
    'Demandas!A:O': [
      ['Timestamp', 'Origem', 'ID', 'Data Demanda', 'Periodo', 'Notas', 'CNDs', 'Valor', 'Status', 'NFS-e', 'PDF', 'Obs', 'Pipeline', 'Updated', 'Extra'],
      ['2026-08-25', 'test@hic.org.br', '1a03eb59b2dd3e5f', '2026-08-25', '08/2026', 'HIC', '', '10,00', 'ISSUED', '18', '', '', 'DOCUMENT_PENDING', '', '']
    ]
  };

  const dependencies = {
    ensureLedgerSheet: async () => {},
    loadLedger: async () => mockLedger,
    callSoapOperation: async (args) => {
      soapCalls.push(args);
      return {
        statusCode: 200,
        outputXml: sampleOfficialXml,
        outputXmlBytes: rawOfficialBytes
      };
    },
    uploadDriveBuffer: async (buffer, fileName, mimeType, folderId) => {
      driveUploads.push({ buffer, fileName, mimeType, folderId });
      return { id: 'drive_doc_official_18_id', name: fileName };
    },
    getSpreadsheetMetadata: async () => ({
      sheets: [{ properties: { title: 'Documentos' } }, { properties: { title: 'Demandas' } }]
    }),
    createSheetIfNotExists: async () => true,
    readSheetValues: async (ssId, range) => mockSheetData[range] || [],
    appendSheetValues: async (ssId, range, values) => {
      sheetAppends.push({ range, values });
      return { updates: { updatedRows: values.length } };
    },
    updateSheetValues: async (ssId, range, values) => {
      sheetUpdates.push({ range, values });
      return { updatedCells: values.length };
    }
  };

  const mockCertData = {
    loaded: true,
    isValid: true,
    pemCert: '---CERT---',
    pemKey: '---KEY---'
  };

  const testCallbackSecret = 'test_secret_1234567890abcdef1234567890abcdef';
  const testCallbackUrl = 'https://script.google.com/macros/s/TEST_DEPLOYMENT_ID/exec';

  // 1. Teste de Callback HMAC Válido
  let callbackInvocations = [];
  const validCallbackDependencies = {
    ...dependencies,
    callbackUrl: testCallbackUrl,
    callbackSecret: testCallbackSecret,
    sendOfficialDocumentCallback: async (args) => {
      callbackInvocations.push(args);
      return {
        statusCode: 200,
        body: {
          ok: true,
          request_id: args.requestId,
          item_index: args.itemIndex,
          drive_file_id: 'drive_file_via_callback_real_id',
          sha256: args.sha256,
          status: 'READY',
          idempotent: false
        }
      };
    }
  };

  const resCallback = await fetchOfficialNfseDocument({
    requestId: '1a03eb59b2dd3e5f',
    itemIndex: 1,
    environment: 'production',
    certData: mockCertData
  }, validCallbackDependencies);

  assert.strictEqual(resCallback.success, true);
  assert.strictEqual(resCallback.status, 'SUCCESS');
  assert.strictEqual(resCallback.driveFileId, 'drive_file_via_callback_real_id');
  assert.strictEqual(resCallback.sha256, expectedSha256);
  assert.strictEqual(resCallback.callbackExecuted, true);
  assert.strictEqual(callbackInvocations.length, 1);
  assert.strictEqual(callbackInvocations[0].requestId, '1a03eb59b2dd3e5f');
  assert.strictEqual(callbackInvocations[0].rpsNumero, '103');
  assert.strictEqual(callbackInvocations[0].nfseNumero, '18');
  assert.strictEqual(callbackInvocations[0].codigoVerificacao, 'JGKL748V');
  assert.strictEqual(callbackInvocations[0].sha256, expectedSha256);
  console.log('✓ Callback HMAC válido executado com sucesso');

  // 2. Teste de Assinatura HMAC e Payload Envelope
  let capturedPost = null;
  await sendOfficialDocumentCallback({
    callbackUrl: testCallbackUrl,
    callbackSecret: testCallbackSecret,
    requestId: '1a03eb59b2dd3e5f',
    itemIndex: 1,
    rpsNumero: '103',
    nfseNumero: '18',
    codigoVerificacao: 'JGKL748V',
    rawOfficialBytes,
    sha256: expectedSha256,
    fileName: 'NFSE-18-DEXMED-JGKL748V-OFFICIAL.xml'
  }, {
    httpPost: async (args) => {
      capturedPost = args;
      return { statusCode: 200, body: { ok: true, status: 'READY', drive_file_id: 'real_id', sha256: expectedSha256 } };
    }
  });

  assert.ok(capturedPost);
  assert.strictEqual(capturedPost.payload.action, 'nfse_document_callback');
  assert.strictEqual(capturedPost.payload.tipo, 'NFSE_XML');
  assert.strictEqual(capturedPost.payload.source, 'CONSULTAR_NFSE_POR_RPS');
  assert.strictEqual(capturedPost.payload.sha256, expectedSha256);
  assert.ok(capturedPost.headers['X-NFSE-Signature']);
  assert.ok(capturedPost.headers['X-NFSE-Timestamp']);
  assert.ok(capturedPost.headers['X-NFSE-Nonce']);
  console.log('✓ Headers e envelope HMAC gerados corretamente');

  // 3. Teste de Falha: Callback retorna erro lógico -> Workflow fail-closed
  let recoveryArtifacts = [];
  const failingCallbackDependencies = {
    ...dependencies,
    callbackUrl: testCallbackUrl,
    callbackSecret: testCallbackSecret,
    persistOfficialRecoveryArtifact: async (artifact) => {
      recoveryArtifacts.push(artifact);
      return { xmlPath: '/tmp/art.xml', metadataPath: '/tmp/art.json' };
    },
    sendOfficialDocumentCallback: async () => {
      return {
        statusCode: 400,
        body: { ok: false, error: 'INVALID_HMAC_SIGNATURE' }
      };
    }
  };

  sheetAppends = [];
  await assert.rejects(
    fetchOfficialNfseDocument({
      requestId: '1a03eb59b2dd3e5f',
      itemIndex: 1,
      environment: 'production',
      certData: mockCertData
    }, failingCallbackDependencies),
    /INVALID_HMAC_SIGNATURE/
  );
  assert.strictEqual(sheetAppends.length, 1);
  const errorRow = sheetAppends[0].values[0];
  assert.strictEqual(errorRow[6], '');
  assert.strictEqual(errorRow[8], 'ERROR');
  assert.ok(errorRow[10].includes('INVALID_HMAC_SIGNATURE'));
  assert.strictEqual(recoveryArtifacts.length, 1);
  console.log('✓ Falha de callback gera status ERROR e preserva artefato fail-closed');

  // 4. Teste de Divergência de SHA no retorno do Callback -> Workflow fail-closed
  const mismatchShaDependencies = {
    ...dependencies,
    callbackUrl: testCallbackUrl,
    callbackSecret: testCallbackSecret,
    sendOfficialDocumentCallback: async (args) => {
      return {
        statusCode: 200,
        body: {
          ok: true,
          status: 'READY',
          drive_file_id: 'corrupted_file_id',
          sha256: '0000000000000000000000000000000000000000000000000000000000000000'
        }
      };
    }
  };

  await assert.rejects(
    fetchOfficialNfseDocument({
      requestId: '1a03eb59b2dd3e5f',
      itemIndex: 1,
      environment: 'production',
      certData: mockCertData
    }, mismatchShaDependencies),
    /SHA_CALLBACK_MISMATCH/
  );
  console.log('✓ Divergência de SHA no callback bloqueada com fail-closed');

  // 5. Teste de Idempotência: Se já estiver READY, retorna sem chamar SOAP ou callback
  let soapCallsReplay = 0;
  const replayDependencies = {
    ...dependencies,
    callbackUrl: testCallbackUrl,
    callbackSecret: testCallbackSecret,
    callSoapOperation: async () => {
      soapCallsReplay++;
      return { statusCode: 200, outputXml: sampleOfficialXml, outputXmlBytes: rawOfficialBytes };
    },
    readSheetValues: async (ssId, range) => {
      if (range.startsWith('Documentos')) {
        return [
          ['request_id', 'item_index', 'rps_numero', 'nfse_numero', 'tipo', 'source', 'drive_file_id', 'sha256', 'status'],
          ['1a03eb59b2dd3e5f', '1', '103', '18', 'NFSE_XML', 'CONSULTAR_NFSE_POR_RPS', 'existing_drive_id_18', expectedSha256, 'READY']
        ];
      }
      return [];
    }
  };

  const replayRes = await fetchOfficialNfseDocument({
    requestId: '1a03eb59b2dd3e5f',
    itemIndex: 1,
    environment: 'production',
    certData: mockCertData
  }, replayDependencies);

  assert.strictEqual(replayRes.status, 'ALREADY_READY');
  assert.strictEqual(replayRes.driveFileId, 'existing_drive_id_18');
  assert.strictEqual(soapCallsReplay, 0, 'Não deve fazer chamada SOAP se já estiver READY');
  console.log('✓ Idempotência validada: documento READY não realiza novas chamadas');

  console.log('✓ test-documents.js PASSED');
}

if (require.main === module) {
  runDocumentsTests().catch(err => {
    console.error('❌ FALHA EM test-documents.js:', err);
    process.exit(1);
  });
}

module.exports = { runDocumentsTests };
