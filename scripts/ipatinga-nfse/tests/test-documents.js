'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { fetchOfficialNfseDocument, ensureDocumentosSheet } = require('../documents');

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

  const expectedSha256 = crypto.createHash('sha256').update(Buffer.from(sampleOfficialXml, 'utf8')).digest('hex');

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
        outputXmlBytes: Buffer.from(sampleOfficialXml, 'utf8')
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

  // 1. Executa fetchOfficialNfseDocument
  const res = await fetchOfficialNfseDocument({
    requestId: '1a03eb59b2dd3e5f',
    itemIndex: 1,
    environment: 'production',
    certData: mockCertData
  }, dependencies);

  // Validações
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.status, 'SUCCESS');
  assert.strictEqual(res.operation, 'fetch_document');
  assert.strictEqual(res.environment, 'production');
  assert.strictEqual(res.requestId, '1a03eb59b2dd3e5f');
  assert.strictEqual(res.itemIndex, 1);
  assert.strictEqual(res.rpsNumero, '103');
  assert.strictEqual(res.nfseNumero, '18');
  assert.strictEqual(res.codigoVerificacao, 'JGKL748V');
  assert.strictEqual(res.driveFileId, 'drive_doc_official_18_id');
  assert.strictEqual(res.sha256, expectedSha256);
  assert.strictEqual(res.source, 'CONSULTAR_NFSE_POR_RPS');
  assert.strictEqual(res.fileName, 'NFSE-18-DEXMED-JGKL748V-OFFICIAL.xml');

  // Valida que apenas ConsultarNfsePorRps foi chamada
  assert.strictEqual(soapCalls.length, 1);
  assert.strictEqual(soapCalls[0].operation, 'ConsultarNfsePorRps');
  assert.ok(soapCalls[0].dadosMsg.includes('<Numero>103</Numero>'));

  // Valida upload no Drive
  assert.strictEqual(driveUploads.length, 1);
  assert.strictEqual(driveUploads[0].fileName, 'NFSE-18-DEXMED-JGKL748V-OFFICIAL.xml');
  assert.strictEqual(driveUploads[0].buffer.toString('utf8'), sampleOfficialXml);

  // Valida append na aba Documentos
  assert.strictEqual(sheetAppends.length, 1);
  const appendedRow = sheetAppends[0].values[0];
  assert.strictEqual(appendedRow[0], '1a03eb59b2dd3e5f');
  assert.strictEqual(appendedRow[1], '1');
  assert.strictEqual(appendedRow[2], '103');
  assert.strictEqual(appendedRow[3], '18');
  assert.strictEqual(appendedRow[4], 'NFSE_XML');
  assert.strictEqual(appendedRow[5], 'CONSULTAR_NFSE_POR_RPS');
  assert.strictEqual(appendedRow[6], 'drive_doc_official_18_id');
  assert.strictEqual(appendedRow[7], expectedSha256);
  assert.strictEqual(appendedRow[8], 'READY');

  // Falha de upload deve ser fail-closed: status ERROR, sem ID sintético e sem READY.
  sheetAppends = [];
  let recoveryArtifacts = [];
  const failingUploadDependencies = {
    ...dependencies,
    persistOfficialRecoveryArtifact: async (artifact) => {
      recoveryArtifacts.push(artifact);
      return { xmlPath: '/private/artifact.xml', metadataPath: '/private/artifact.xml.json' };
    },
    uploadDriveBuffer: async () => {
      throw new Error('storage quota exceeded');
    }
  };
  await assert.rejects(
    fetchOfficialNfseDocument({
      requestId: '1a03eb59b2dd3e5f',
      itemIndex: 1,
      environment: 'production',
      certData: mockCertData
    }, failingUploadDependencies),
    /DRIVE_UPLOAD_FAILED/
  );
  assert.strictEqual(sheetAppends.length, 1);
  const errorRow = sheetAppends[0].values[0];
  assert.strictEqual(errorRow[6], '');
  assert.strictEqual(errorRow[8], 'ERROR');
  assert.ok(errorRow[10].includes('DRIVE_UPLOAD_FAILED'));
  assert.ok(errorRow[10].includes('RECOVERY_ARTIFACT_AVAILABLE'));
  assert.ok(!errorRow.join('|').includes('OFFICIAL_BYTES_VALIDATED_'));
  assert.strictEqual(recoveryArtifacts.length, 1);
  assert.strictEqual(recoveryArtifacts[0].fileName, 'NFSE-18-DEXMED-JGKL748V-OFFICIAL.xml');
  assert.strictEqual(recoveryArtifacts[0].buffer.toString('utf8'), sampleOfficialXml);
  assert.strictEqual(recoveryArtifacts[0].metadata.sha256, expectedSha256);

  console.log('✓ test-documents.js PASSED');
}

if (require.main === module) {
  runDocumentsTests().catch(err => {
    console.error('❌ FALHA EM test-documents.js:', err);
    process.exit(1);
  });
}

module.exports = { runDocumentsTests };
