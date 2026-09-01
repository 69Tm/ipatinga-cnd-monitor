'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { fetchOfficialNfseDocument, ensureDocumentosSheet, sendOfficialDocumentCallback, buildCanonicalHmacString } = require('../documents');

console.log('Running test-documents.js...');

async function runDocumentsTests() {
  const sampleOfficialXmlNormal = `<?xml version="1.0" encoding="utf-8"?>
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

  const sampleOfficialXmlCancelled = `<?xml version="1.0" encoding="utf-8"?>
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
    <NfseCancelamento>
      <Confirmacao>
        <InfConfirmacaoCancelamento>
          <Numero>18</Numero>
          <CodigoCancelamento>1</CodigoCancelamento>
          <DataHora>2026-08-27T14:16:49-03:00</DataHora>
        </InfConfirmacaoCancelamento>
      </Confirmacao>
    </NfseCancelamento>
  </CompNfse>
</ConsultarNfseRpsResposta>`;

  const rawOfficialBytesCancelled = Buffer.from(sampleOfficialXmlCancelled, 'utf8');
  const expectedSha256Cancelled = crypto.createHash('sha256').update(rawOfficialBytesCancelled).digest('hex');

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
    'Documentos NFS-e!A:K': [
      ['request_id', 'item_index', 'rps_numero', 'nfse_numero', 'tipo', 'source', 'drive_file_id', 'sha256', 'status', 'created_at', 'error']
    ],
    'Demandas!A:O': [
      ['Data demanda', 'Origem', 'ID', 'Competência', 'Notas', 'CNDs', 'Valor', 'Status', 'NFS-e', 'PDF', 'Observações', 'Estado pipeline', 'Última atualização', 'Erro / pendência', 'Extra'],
      ['2026-08-27', 'test@hic.org.br', '1a03eb59b2dd3e5f', '08/2026', 'HIC', '', '10,00', 'ISSUED', '18', '', 'Obs Original Não Sobrescrever', 'DOCUMENT_FETCH_DISPATCHED', '', '', '']
    ]
  };

  const dependencies = {
    ensureLedgerSheet: async () => {},
    loadLedger: async () => mockLedger,
    callSoapOperation: async (args) => {
      soapCalls.push(args);
      return {
        statusCode: 200,
        outputXml: sampleOfficialXmlCancelled,
        outputXmlBytes: rawOfficialBytesCancelled
      };
    },
    uploadDriveBuffer: async (buffer, fileName, mimeType, folderId) => {
      driveUploads.push({ buffer, fileName, mimeType, folderId });
      return { id: 'drive_doc_official_18_id', name: fileName };
    },
    getSpreadsheetMetadata: async () => ({
      sheets: [{ properties: { title: 'Documentos NFS-e' } }, { properties: { title: 'Demandas' } }]
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

  // 1. Teste de Detecção de NfseCancelamento e Bloqueio de Draft (Fail-Closed)
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
          drive_file_id: '1ZFlpjQW61Idp9whOcKY3a5XT0eNLjeO3',
          sha256: args.sha256,
          status: 'READY',
          nfse_status: args.nfseStatus,
          pipeline_state: args.nfseStatus === 'CANCELADA' ? 'BLOCKED_CANCELLED_NFSE' : 'DOCUMENTS_READY',
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
  assert.strictEqual(resCallback.driveFileId, '1ZFlpjQW61Idp9whOcKY3a5XT0eNLjeO3');
  assert.strictEqual(resCallback.sha256, expectedSha256Cancelled);
  assert.strictEqual(resCallback.isCancelled, true, 'NFS-e 18 cancelada deve ser detectada');
  assert.strictEqual(resCallback.nfseStatus, 'CANCELADA');
  assert.strictEqual(resCallback.pipelineState, 'BLOCKED_CANCELLED_NFSE');
  assert.strictEqual(resCallback.draftBlocked, true, 'Draft deve ser bloqueado para NFS-e cancelada');
  assert.strictEqual(callbackInvocations.length, 1);
  assert.strictEqual(callbackInvocations[0].nfseStatus, 'CANCELADA');
  console.log('✓ Cancelamento de NFS-e detectado e bloqueio de draft validado com fail-closed');

  // 2. Teste de Canonical String e Assinatura HMAC Não-Circular
  const ts = '1725148800000';
  const nonce = 'test-nonce-123';
  const canonicalStr = buildCanonicalHmacString({
    timestamp: ts,
    nonce,
    action: 'nfse_document_callback',
    requestId: '1a03eb59b2dd3e5f',
    itemIndex: '1',
    rpsNumero: '103',
    nfseNumero: '18',
    codigoVerificacao: 'JGKL748V',
    tipo: 'NFSE_XML',
    source: 'CONSULTAR_NFSE_POR_RPS',
    sha256: expectedSha256Cancelled,
    fileName: 'NFSE-18-DEXMED-JGKL748V-OFFICIAL.xml',
    xmlBytesSha256: expectedSha256Cancelled
  });

  const expectedCanonical = [
    ts,
    nonce,
    'nfse_document_callback',
    '1a03eb59b2dd3e5f',
    '1',
    '103',
    '18',
    'JGKL748V',
    'NFSE_XML',
    'CONSULTAR_NFSE_POR_RPS',
    expectedSha256Cancelled.toLowerCase(),
    'NFSE-18-DEXMED-JGKL748V-OFFICIAL.xml',
    expectedSha256Cancelled.toLowerCase()
  ].join('\n');

  assert.strictEqual(canonicalStr, expectedCanonical);

  // Alteração de qualquer campo invalida a assinatura
  const sigValid = crypto.createHmac('sha256', testCallbackSecret).update(canonicalStr, 'utf8').digest('hex');
  const alteredCanonical = canonicalStr.replace('103', '104');
  const sigAltered = crypto.createHmac('sha256', testCallbackSecret).update(alteredCanonical, 'utf8').digest('hex');
  assert.notStrictEqual(sigValid, sigAltered, 'Alteração de qualquer campo assinado deve invalidar o HMAC');
  console.log('✓ Canonical HMAC determinístico e não-circular validado');

  // 3. Teste de Falha: Callback retorna erro -> Fail closed com persistência de artefato
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

  // 4. Teste de Idempotência: Se já estiver READY, retorna sem chamar SOAP ou callback
  let soapCallsReplay = 0;
  const replayDependencies = {
    ...dependencies,
    callbackUrl: testCallbackUrl,
    callbackSecret: testCallbackSecret,
    callSoapOperation: async () => {
      soapCallsReplay++;
      return { statusCode: 200, outputXml: sampleOfficialXmlCancelled, outputXmlBytes: rawOfficialBytesCancelled };
    },
    readSheetValues: async (ssId, range) => {
      if (range.startsWith('Documentos NFS-e')) {
        return [
          ['request_id', 'item_index', 'rps_numero', 'nfse_numero', 'tipo', 'source', 'drive_file_id', 'sha256', 'status'],
          ['1a03eb59b2dd3e5f', '1', '103', '18', 'NFSE_XML', 'CONSULTAR_NFSE_POR_RPS', '1ZFlpjQW61Idp9whOcKY3a5XT0eNLjeO3', expectedSha256Cancelled, 'READY']
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
  assert.strictEqual(replayRes.driveFileId, '1ZFlpjQW61Idp9whOcKY3a5XT0eNLjeO3');
  assert.strictEqual(soapCallsReplay, 0, 'Não deve fazer chamada SOAP se já estiver READY');
  console.log('✓ Idempotência validada: documento READY não realiza novas chamadas fiscais');

  console.log('✓ test-documents.js PASSED');
}

if (require.main === module) {
  runDocumentsTests().catch(err => {
    console.error('❌ FALHA EM test-documents.js:', err);
    process.exit(1);
  });
}

module.exports = { runDocumentsTests };
