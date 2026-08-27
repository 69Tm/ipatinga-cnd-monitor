'use strict';

const assert = require('assert');
const forge = require('node-forge');
const { parseConsultarNfseResposta, extractNfseData } = require('../abrasf');
const { parseGerarNfseResposta, reconcileRps } = require('../issue');
const { prepareDemand, demandRows, tomadorRows, patternRows } = require('../prepare');
const { RECONCILIATION_STATUS, RPS_STATUS } = require('../ledger');

console.log('Running test-reconciliation-rps.js...');

// Fixture sanitizada baseada no retorno real do caso de produção
const sampleConsultarRpsResposta = `<?xml version="1.0" encoding="utf-8"?>
<ConsultarNfseRpsResposta xmlns="http://www.abrasf.org.br/nfse.xsd">
  <CompNfse>
    <Nfse>
      <InfNfse Id="NFSE18">
        <Numero>18</Numero>
        <CodigoVerificacao>JGKL748V</CodigoVerificacao>
        <DataEmissao>2026-08-27T10:55:00</DataEmissao>
        <DeclaracaoPrestacaoServico>
          <InfDeclaracaoPrestacaoServico Id="RPS103A">
            <Rps>
              <IdentificacaoRps>
                <Numero>103</Numero>
                <Serie>A</Serie>
                <Tipo>1</Tipo>
              </IdentificacaoRps>
              <DataEmissao>2026-08-27</DataEmissao>
              <Status>1</Status>
            </Rps>
            <Competencia>2026-08-01</Competencia>
            <Servico>
              <Valores>
                <ValorServicos>10.00</ValorServicos>
              </Valores>
              <Discriminacao>Dr Túlio Athélio Sathler Siman: Referente a Plantões Médicos P.S SUS no Mês 08/2026- R$ 10,00.</Discriminacao>
            </Servico>
            <Prestador>
              <CpfCnpj><Cnpj>31302407000105</Cnpj></CpfCnpj>
            </Prestador>
            <TomadorServico>
              <RazaoSocial>ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO</RazaoSocial>
            </TomadorServico>
          </InfDeclaracaoPrestacaoServico>
        </DeclaracaoPrestacaoServico>
      </InfNfse>
    </Nfse>
  </CompNfse>
</ConsultarNfseRpsResposta>`;

const sampleGerarNfseResposta = `<?xml version="1.0" encoding="utf-8"?>
<GerarNfseResposta xmlns="http://www.abrasf.org.br/nfse.xsd">
  <CompNfse>
    <Nfse>
      <InfNfse Id="NFSE18">
        <DeclaracaoPrestacaoServico>
          <InfDeclaracaoPrestacaoServico Id="RPS103A">
            <Rps>
              <IdentificacaoRps>
                <Numero>103</Numero>
                <Serie>A</Serie>
                <Tipo>1</Tipo>
              </IdentificacaoRps>
            </Rps>
          </InfDeclaracaoPrestacaoServico>
        </DeclaracaoPrestacaoServico>
        <Numero>18</Numero>
        <CodigoVerificacao>JGKL748V</CodigoVerificacao>
        <DataEmissao>2026-08-27T10:55:00</DataEmissao>
      </InfNfse>
    </Nfse>
  </CompNfse>
</GerarNfseResposta>`;

// In-memory test certificate
const keypair = forge.pki.rsa.generateKeyPair(1024);
const cert = forge.pki.createCertificate();
cert.publicKey = keypair.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
const attrs = [{ name: 'commonName', value: 'DEXMED RECONCILE TEST' }];
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
  // 1. Test parseConsultarNfseResposta failsafe extraction
  const parsedConsult = parseConsultarNfseResposta(sampleConsultarRpsResposta);
  assert.strictEqual(parsedConsult.notas.length, 1, 'Deve extrair exatamente 1 nota');
  assert.strictEqual(parsedConsult.notas[0].numero, '18', 'NFS-e número deve ser 18 e NÃO o RPS 103');
  assert.strictEqual(parsedConsult.notas[0].codigoVerificacao, 'JGKL748V', 'Código de verificação deve ser JGKL748V');
  assert.ok(parsedConsult.notas[0].dataEmissao, 'Data de emissão deve estar presente');

  // 2. Test parseGerarNfseResposta failsafe extraction
  const parsedGerar = parseGerarNfseResposta(sampleGerarNfseResposta);
  assert.strictEqual(parsedGerar.hasNfse, true, 'hasNfse deve ser true');
  assert.strictEqual(parsedGerar.numero, '18', 'GerarNfse deve extrair NFS-e 18 e NÃO RPS 103');
  assert.strictEqual(parsedGerar.codigoVerificacao, 'JGKL748V', 'GerarNfse deve extrair JGKL748V');

  // 3. Test reconcileRps with mocked SOAP
  const mockLedgerRows = [
    ['environment', 'request_id', 'item_index', 'rps_numero', 'rps_serie', 'rps_tipo', 'status', 'allocated_at', 'submitted_at', 'nfse_numero', 'nfse_chave', 'last_query_at', 'attempt_count', 'last_attempt_at', 'provider_error_codes', 'provider_message', 'error'],
    ['production', '1a03eb59b2dd3e5f', '1', '103', 'A', '1', RPS_STATUS.SUBMITTING, '2026-08-27T13:55:28.874Z', '2026-08-27T13:55:29.318Z', '', '', '', '1', '2026-08-27T13:55:29.318Z', '', '', '']
  ];

  let updatedLedgerRow = null;
  const reconcileRes = await reconcileRps({
    environment: 'production',
    requestId: '1a03eb59b2dd3e5f',
    itemIndex: 1,
    rpsNumero: '103',
    certData
  }, {
    readSheetValues: async () => mockLedgerRows,
    updateSheetValues: async (_id, _range, values) => { updatedLedgerRow = values[0]; },
    createSheetIfNotExists: async () => true,
    callSoapOperation: async () => ({ statusCode: 200, outputXml: sampleConsultarRpsResposta })
  });

  assert.strictEqual(reconcileRes.status, RECONCILIATION_STATUS.ISSUED, 'Status de reconciliação deve ser ISSUED');
  assert.strictEqual(reconcileRes.rpsNumero, '103', 'RPS número deve ser 103');
  assert.strictEqual(reconcileRes.nfseNumero, '18', 'NFS-e número reconciliado deve ser 18');
  assert.strictEqual(reconcileRes.nfseChave, 'JGKL748V', 'Chave/código reconciliado deve ser JGKL748V');

  // 4. Test description money formatting in prepareDemand
  const mockDemandas = [
    ['Data demanda', 'Origem', 'Message ID', 'Período', 'Notas solicitadas', 'Valores', 'CNDs / anexos exigidos', 'Descrição obrigatória', 'Status'],
    ['2026-08-27', 'tulio69tm@gmail.com', 'req-desc-test', '08/2026', 'HIC — Plantões PS SUS', '10', '', '', 'PENDENTE']
  ];
  const mockTomadores = [
    ['CNPJ', 'Razão Social', 'Nome Curto', 'Logradouro', 'Número', 'Complemento', 'Bairro', 'Cód. Município', 'Município', 'UF', 'CEP', 'Fonte Endereço', 'Validado Em', 'Categorias Conhecidas', 'Status Homologação'],
    ['20.724.357/0001-20', 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO', 'HIC', 'CAPITAO BERNARDO', '257', '', 'CENTRO', '3128006', 'GUANHAES', 'MG', '39740000', 'NFS-e histórica', '2026-08-22', 'HIC', 'HOMOLOGADO']
  ];
  const mockPatterns = [
    ['ID Padrão', 'Nome Padrão', 'Tomador', 'CNPJ Tomador', 'Categoria', 'Template / Descrição Oficial', 'Cód. Trib. Nacional', 'Cód. Trib. Municipal', 'Local Prestação', 'Cód. Município Prestação', 'Cód. Município Incidência', 'ISS Retido', 'Exigibilidade ISS', 'NBS', 'Confiança', 'Status'],
    ['HIC_PLANTOES_PS_SUS', 'HIC Plantões', 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO', '20.724.357/0001-20', 'HIC — Plantões PS SUS', 'Dr Túlio Athélio Sathler Siman: Referente a Plantões Médicos P.S SUS no Mês {MM/AAAA}- R$ {VALOR}. {BLOCO_BANCARIO_VALIDADO}', '04.03.01', '403', 'Guanhães/MG', '3128006', '3131307', '2', '1', '123011900', 'ALTA', 'VALIDADO']
  ];

  const prepared = prepareDemand({
    requestId: 'req-desc-test',
    demandas: demandRows(mockDemandas),
    tomadores: tomadorRows(mockTomadores),
    patterns: patternRows(mockPatterns),
    notas: []
  });

  assert.strictEqual(prepared.validationStatus, 'READY_TO_ISSUE');
  assert.ok(prepared.candidates[0].descricao.includes('R$ 10,00.'), `Descrição deve formatar 'R$ 10,00.' e não 'R$ 10.'. Descrição gerada: ${prepared.candidates[0].descricao}`);

  console.log('✅ ALL RPS-TO-NFSE RECONCILIATION & FORMATTING TESTS PASSED!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
