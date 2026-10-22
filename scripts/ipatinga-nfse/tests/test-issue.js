'use strict';

const assert = require('assert');
const forge = require('node-forge');
const {
  buildConsultarNfsePorRpsEnvio,
  parseGerarNfseResposta,
  reconcileRps,
  issueNfse: issueNfseEngine
} = require('../issue');
const { checkPendingEntries } = require('../main');
const { RPS_STATUS, RECONCILIATION_STATUS } = require('../ledger');

console.log('Running test-issue.js...');

const issueNfse = (args, dependencies = {}) => issueNfseEngine(args, { issueDate: '2026-08-24', ...dependencies });

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
  ['req-test-homolog', '08/2026', 'HIC — Plantões PS SUS', '100,00', 'Descrição & teste <especial> "homologação"', 'PENDENTE', ''],
  ['req-reconcile-test', '08/2026', 'HIC — Plantões PS SUS', '100,00', 'Descrição & teste', 'PENDENTE', '']
];
const mockTomadores = [
  ['CNPJ', 'Razão Social', 'Nome Curto', 'Logradouro', 'Número', 'Complemento', 'Bairro', 'Cód. Município', 'Município', 'UF', 'CEP', 'Fonte Endereço', 'Validado Em', 'Categorias Conhecidas', 'Status Homologação'],
  ['20.724.357/0001-20', 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO', 'HIC', 'CAPITAO BERNARDO', '257', '', 'CENTRO', '3128006', 'GUANHAES', 'MG', '39740000', 'NFS-e histórica', '2026-08-22', 'HIC', 'HOMOLOGADO']
];
const mockPatterns = [
  ['ID Padrão', 'Nome Padrão', 'Tomador', 'CNPJ Tomador', 'Categoria', 'Template / Descrição Oficial', 'Cód. Trib. Nacional', 'Cód. Trib. Municipal', 'Local Prestação', 'Cód. Município Prestação', 'Cód. Município Incidência', 'ISS Retido', 'Exigibilidade ISS', 'NBS', 'Confiança', 'Status'],
  ['HIC_PLANTOES_PS_SUS', 'HIC Plantões', 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO', '20.724.357/0001-20', 'HIC — Plantões PS SUS', '', '04.03.01', '403', 'Guanhães/MG', '3128006', '3131307', '2', '1', '123011900', 'ALTA', 'VALIDADO']
];

function mockSheetReader(overrides = {}) {
  return async (_id, range) => {
    const norm = String(range || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (norm.includes('rps')) return overrides.rps || [];
    if (norm.includes('demanda')) return overrides.demandas || mockDemandas;
    if (norm.includes('tomador')) return overrides.tomadores || mockTomadores;
    if (norm.includes('padro')) return overrides.padroes || mockPatterns;
    if (norm.includes('documentos')) return overrides.documentos || [];
    if (norm.includes('nota')) return overrides.notas || [];
    return [];
  };
}

async function run() {
  process.env.NFE_ALLOW_CONTROLLED_PRODUCTION_TEST = 'true';

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

  // 3. Testa issueNfse em DRY-RUN
  const dryResult = await issueNfse({
    requestId: 'req-test-homolog',
    itemIndex: 1,
    certData,
    dryRun: true
  }, {
    readSheetValues: mockSheetReader(),
    createSheetIfNotExists: async () => true,
    updateSheetValues: async () => {}
  });

  assert.strictEqual(dryResult.status, 'DRY_RUN_SUCCESS');
  assert.strictEqual(dryResult.gerarNfseCalls, 0);
  assert.strictEqual(dryResult.fiscalWrites, 0);
  assert.strictEqual(dryResult.sheetWritebacks, 1);
  assert.strictEqual(dryResult.xsdValidation, 'VALIDATED_OFFICIAL_XSD');
  assert.strictEqual(dryResult.xmlSignature, 'VALIDATED_XMLDSIG_C14N');
  assert.ok(dryResult.xmlSha256);

  // 3b. Testa que falha no write-back do dry-run rejeita com DRY_RUN_WRITEBACK_FAILED
  await assert.rejects(async () => {
    await issueNfse({
      requestId: 'req-test-homolog',
      itemIndex: 1,
      certData,
      dryRun: true
    }, {
      readSheetValues: mockSheetReader(),
      createSheetIfNotExists: async () => true,
      updateSheetValues: async () => { throw new Error('API_QUOTA_EXCEEDED'); }
    });
  }, /DRY_RUN_WRITEBACK_FAILED/, 'Dry-run deve falhar se o write-back na planilha falhar');

  // 4. Testa reconcileRps diretamente
  const mockRpsStorage = [
    ['environment', 'request_id', 'item_index', 'rps_numero', 'rps_serie', 'rps_tipo', 'status', 'allocated_at', 'submitted_at', 'nfse_numero', 'nfse_chave', 'last_query_at', 'attempt_count', 'last_attempt_at', 'provider_error_codes', 'provider_message', 'error'],
    ['production', 'req-reconcile-test', '1', '1003', 'A', '1', 'SUBMITTED_ASYNC_PROCESSING', '2026-08-22T10:00:00Z', '2026-08-22T10:00:01Z', '', '', '', '1', '2026-08-22T10:00:01Z', '', '', '']
  ];

  const recResult = await reconcileRps({
    environment: 'production',
    rpsNumero: '1003',
    certData
  }, {
    readSheetValues: mockSheetReader({ rps: mockRpsStorage }),
    updateSheetValues: async (_id, _range, rows) => { mockRpsStorage[1] = rows[0]; },
    createSheetIfNotExists: async () => true,
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
  const idempotentResult = await issueNfse({
    requestId: 'req-reconcile-test',
    itemIndex: 1,
    certData,
    dryRun: false
  }, {
    readSheetValues: mockSheetReader({ rps: mockRpsStorage }),
    updateSheetValues: async () => {},
    appendSheetValues: async () => {},
    createSheetIfNotExists: async () => true
  });

  assert.strictEqual(idempotentResult.status, 'ALREADY_ISSUED');
  assert.strictEqual(idempotentResult.gerarNfseCalls, 0);

  // 6. Testa tratamento de Timeout e Recuperação por Consulta RPS
  let rpsStorageTimeout = [
    ['environment', 'request_id', 'item_index', 'rps_numero', 'rps_serie', 'rps_tipo', 'status', 'allocated_at', 'submitted_at', 'nfse_numero', 'nfse_chave', 'last_query_at', 'attempt_count', 'last_attempt_at', 'provider_error_codes', 'provider_message', 'error'],
    ['production', 'fixture-controlada-timeout', '1', '1004', 'A', '1', 'ALLOCATED', '2026-08-22T10:00:00Z', '', '', '', '', '0', '', '', '', '']
  ];

  const timeoutResult = await issueNfse({
    requestId: 'fixture-controlada-timeout',
    itemIndex: 1,
    certData,
    dryRun: false
  }, {
    readSheetValues: mockSheetReader({ rps: rpsStorageTimeout }),
    updateSheetValues: async (_id, _range, rows) => { rpsStorageTimeout[1] = rows[0]; },
    appendSheetValues: async () => {},
    createSheetIfNotExists: async () => true,
    callSoapOperation: async ({ operation }) => {
      if (operation === 'GerarNfse') {
        throw new Error('ETIMEDOUT: Connection timed out on GerarNfse');
      }
      if (operation === 'ConsultarNfsePorRps') {
        return {
          outputXml: `<ConsultarNfseRpsResposta xmlns="http://www.abrasf.org.br/nfse.xsd">
            <CompNfse><Nfse><InfNfse><Numero>95004</Numero><CodigoVerificacao>CHAVETIMEOUT</CodigoVerificacao><DataEmissao>2026-08-22T10:10:00</DataEmissao></InfNfse></Nfse></CompNfse>
          </ConsultarNfseRpsResposta>`
        };
      }
      throw new Error(`Unexpected operation: ${operation}`);
    }
  });

  assert.strictEqual(timeoutResult.status, 'ISSUED');
  assert.strictEqual(timeoutResult.nfseNumero, '95004');
  assert.strictEqual(timeoutResult.recoveredViaRpsQuery, true);

  // 7. Testa tratamento de PROVIDER_INFRA_UNAVAILABLE (HTTP 500 / WSDL SOAP Fault)
  let rpsStorageInfra = [
    ['environment', 'request_id', 'item_index', 'rps_numero', 'rps_serie', 'rps_tipo', 'status', 'allocated_at', 'submitted_at', 'nfse_numero', 'nfse_chave', 'last_query_at', 'attempt_count', 'last_attempt_at', 'provider_error_codes', 'provider_message', 'error'],
    ['production', 'fixture-controlada-infra', '1', '101', 'A', '1', 'ALLOCATED', '2026-08-23T22:00:00Z', '', '', '', '', '0', '', '', '', '']
  ];

  const infraResult = await issueNfse({
    requestId: 'fixture-controlada-infra',
    itemIndex: 1,
    certData,
    dryRun: false
  }, {
    readSheetValues: mockSheetReader({ rps: rpsStorageInfra }),
    updateSheetValues: async (_id, _range, rows) => { rpsStorageInfra[1] = rows[0]; },
    appendSheetValues: async () => {},
    createSheetIfNotExists: async () => true,
    callSoapOperation: async () => {
      throw new Error('SOAP_HTTP_ERROR_500: SOAP-ERROR: Parsing WSDL: Couldn\'t load from https://abrasfipatinga.meumunicipio.online/ws/nfs?wsdl');
    }
  });

  assert.strictEqual(infraResult.status, RPS_STATUS.PROVIDER_INFRA_UNAVAILABLE);
  assert.strictEqual(rpsStorageInfra[1][6], RPS_STATUS.PROVIDER_INFRA_UNAVAILABLE);
  assert.strictEqual(rpsStorageInfra[1][3], '101'); // Preservou RPS 101 sem criar novo

  // 8. Testa Recuperação de PROVIDER_INFRA_UNAVAILABLE -> Reconcile NOT_FOUND -> Emissão com o MESMO RPS 101 (sem criar novo)
  let appendCalls = 0;
  let gerarCalls = 0;
  let rpsStorageRetry = [
    ['environment', 'request_id', 'item_index', 'rps_numero', 'rps_serie', 'rps_tipo', 'status', 'allocated_at', 'submitted_at', 'nfse_numero', 'nfse_chave', 'last_query_at', 'attempt_count', 'last_attempt_at', 'provider_error_codes', 'provider_message', 'error'],
    ['production', 'fixture-controlada-prod-1787530132367', '1', '101', 'A', '1', 'PROVIDER_INFRA_UNAVAILABLE', '2026-08-23T22:00:00Z', '2026-08-23T22:00:01Z', '', '', '', '1', '2026-08-23T22:00:01Z', '', '', 'SOAP-ERROR: Parsing WSDL']
  ];

  const retryRecoveryResult = await issueNfse({
    requestId: 'fixture-controlada-prod-1787530132367',
    itemIndex: 1,
    certData,
    dryRun: false
  }, {
    readSheetValues: mockSheetReader({ rps: rpsStorageRetry }),
    updateSheetValues: async (_id, _range, rows) => { rpsStorageRetry[1] = rows[0]; },
    appendSheetValues: async () => { appendCalls++; },
    createSheetIfNotExists: async () => true,
    callSoapOperation: async ({ operation, dadosMsg }) => {
      if (operation === 'ConsultarNfsePorRps') {
        return {
          outputXml: `<ConsultarNfseRpsResposta xmlns="http://www.abrasf.org.br/nfse.xsd">
            <ListaMensagemRetorno>
              <MensagemRetorno>
                <Codigo>E4</Codigo>
                <Mensagem>RPS nao encontrado</Mensagem>
              </MensagemRetorno>
            </ListaMensagemRetorno>
          </ConsultarNfseRpsResposta>`
        };
      }
      if (operation === 'GerarNfse') {
        gerarCalls++;
        assert.ok(dadosMsg.includes('<Numero>101</Numero>'), 'GerarNfse deve usar estritamente o RPS 101');
        return {
          outputXml: `<GerarNfseResposta xmlns="http://www.abrasf.org.br/nfse.xsd">
            <ListaNfse>
              <CompNfse>
                <Nfse>
                  <InfNfse>
                    <Numero>16</Numero>
                    <CodigoVerificacao>CHAVEPROD16</CodigoVerificacao>
                    <DataEmissao>2026-08-24T10:00:00</DataEmissao>
                  </InfNfse>
                </Nfse>
              </CompNfse>
            </ListaNfse>
          </GerarNfseResposta>`
        };
      }
      throw new Error(`Unexpected operation: ${operation}`);
    }
  });

  assert.strictEqual(retryRecoveryResult.status, 'ISSUED');
  assert.strictEqual(retryRecoveryResult.rpsNumero, '101');
  assert.strictEqual(retryRecoveryResult.nfseNumero, '16');
  assert.strictEqual(retryRecoveryResult.nfseChave, 'CHAVEPROD16');
  assert.strictEqual(gerarCalls, 1, 'Deve chamar GerarNfse exatamente 1 vez');
  assert.strictEqual(appendCalls, 0, 'NÃO deve alocar novo RPS (zero appendSheetValues)');
  assert.strictEqual(rpsStorageRetry[1][3], '101');
  assert.strictEqual(rpsStorageRetry[1][6], RPS_STATUS.ISSUED);
  assert.strictEqual(rpsStorageRetry[1][9], '16');

  // 9. Testa bloqueio de fixture controlada sem a flag NFE_ALLOW_CONTROLLED_PRODUCTION_TEST
  delete process.env.NFE_ALLOW_CONTROLLED_PRODUCTION_TEST;
  let threwControlled = false;
  try {
    await issueNfse({
      requestId: 'fixture-controlada-teste-bloqueio',
      itemIndex: 1,
      certData,
      dryRun: false
    }, {
      readSheetValues: mockSheetReader({ rps: [] }),
      createSheetIfNotExists: async () => true,
      updateSheetValues: async () => {}
    });
  } catch (e) {
    threwControlled = true;
    assert.ok(e.message.includes('CONTROLLED_PRODUCTION_TEST_DISABLED'));
  }
  assert.strictEqual(threwControlled, true, 'Fixture controlada em producao deve ser barrada sem flag');

  // Replay de demanda nacional já enviada: sem ledger legado, escrita ou chamada ao provedor.
  const sentDemand = [
    ['Message ID', 'Período', 'Notas solicitadas', 'Valores', 'Descrição obrigatória', 'Status', 'NFS-e resultantes'],
    ['sent-request', '09/2026', 'Plantões; Produção', '7700,00; 1560,00', 'Plantões || Produção', 'COMPLETED_SENT', '25; 26']
  ];
  let ledgerCreateCalls = 0;
  for (const [itemIndex, nfseNumero] of [[1, '25'], [2, '26']]) {
    const replay = await issueNfseEngine({ requestId: 'sent-request', itemIndex, dryRun: false }, {
      readSheetValues: mockSheetReader({ demandas: sentDemand }),
      createSheetIfNotExists: async () => { ledgerCreateCalls++; },
      updateSheetValues: async () => { throw new Error('unexpected write'); },
      appendSheetValues: async () => { throw new Error('unexpected write'); },
      callSoapOperation: async () => { throw new Error('unexpected provider call'); }
    });
    assert.strictEqual(replay.status, 'ALREADY_COMPLETED');
    assert.strictEqual(replay.nfseNumero, nfseNumero);
    assert.deepStrictEqual([replay.newDps, replay.newRps, replay.newNfse, replay.newEmails, replay.newDrafts, replay.newProviderWrites], [0, 0, 0, 0, 0, 0]);
  }
  assert.strictEqual(ledgerCreateCalls, 0);

  const officialDocs = [
    ['request_id', 'item_index', 'rps_numero', 'nfse_numero', 'tipo', 'source', 'drive_file_id', 'sha256', 'status', 'created_at', 'error'],
    ['external-request', '1', '', '25', 'OFFICIAL_DANFSE_PDF', 'GMAIL_SENT_ATTACHMENT', 'drive-25', 'hash-25', 'READY', '', '']
  ];
  const officialNotes = [
    ['Nº NFS-e', 'Período referência', 'Competência NFS-e', 'Emissão', 'Tomador', 'CNPJ tomador', 'Categoria', 'Descrição do serviço', 'Valor serviço', 'Cód. trib. nacional', 'Cód. trib. municipal', 'Local prestação', 'Alíquota ISS', 'ISS apurado', 'NBS', 'Chave de acesso', 'Fonte', 'E-mail origem', 'Status', 'Observações', 'Fonte API', 'Última sincronização API', 'Código de verificação', 'Situação API'],
    ['25', '09/2026', '20/10/2026', '20/10/2026', 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO', '20724357000120', 'HIC', 'Plantões', 'R$ 7.700,00', '', '040301', 'Guanhães/MG', '2,390%', 'R$ 184,03', '123011900', 'key-25', 'Gmail — DANFSe oficial enviado', 'thread-1', 'NORMAL', '', 'DANFSe v2.0', '', '', 'NFS-e Gerada']
  ];
  const docsReplay = await issueNfseEngine({ requestId: 'external-request', itemIndex: 1, dryRun: false }, {
    readSheetValues: mockSheetReader({ documentos: officialDocs, notas: officialNotes }),
    createSheetIfNotExists: async () => { throw new Error('must not create legacy ledger'); },
    callSoapOperation: async () => { throw new Error('must not invoke provider'); }
  });
  assert.strictEqual(docsReplay.status, 'ALREADY_COMPLETED');
  assert.strictEqual(docsReplay.nfseNumero, '25');
  assert.strictEqual(docsReplay.reconciledFromOfficialDocument, true);

  // Para uma nova emissão corrente, a rota nacional é selecionada e o safety gate de produção bloqueia antes de criar o ledger.
  let currentLedgerCreateCalls = 0;
  await assert.rejects(() => issueNfseEngine({ requestId: 'new-current-request', itemIndex: 1, certData, dryRun: false }, {
    issueDate: '2026-10-21',
    readSheetValues: mockSheetReader(),
    createSheetIfNotExists: async () => { currentLedgerCreateCalls++; },
    callSoapOperation: async () => { throw new Error('ABRASF write must not run'); }
  }), /NATIONAL_PRODUCTION_WRITE_DISABLED/);
  assert.strictEqual(currentLedgerCreateCalls, 0);

  let currentDryRunUpdatedRows = 0;
  const currentDryRun = await issueNfseEngine({ requestId: 'new-current-request', itemIndex: 1, certData, dryRun: true }, {
    issueDate: '2026-10-21',
    readSheetValues: mockSheetReader({
      demandas: [
        ['Message ID', 'Período', 'Notas solicitadas', 'Valores', 'Descrição obrigatória', 'Status', 'NFS-e resultantes'],
        ['new-current-request', '09/2026', 'HIC — Plantões PS SUS', '100,00', 'Descrição corrente', 'PENDENTE', '']
      ]
    }),
    createSheetIfNotExists: async () => { currentLedgerCreateCalls++; },
    updateSheetValues: async () => { currentDryRunUpdatedRows++; },
    callSoapOperation: async () => { throw new Error('ABRASF write must not run'); }
  });
  assert.strictEqual(currentDryRun.status, 'DRY_RUN_SUCCESS');
  assert.strictEqual(currentDryRun.provider, 'NATIONAL_ISSUER');
  assert.strictEqual(currentLedgerCreateCalls, 0);
  assert.strictEqual(currentDryRunUpdatedRows, 1);

  // 10. Testa pending_check (checkPendingEntries)
  const rpsPendingSample = [
    ['environment', 'request_id', 'item_index', 'rps_numero', 'rps_serie', 'rps_tipo', 'status'],
    ['production', 'req-1', '1', '101', 'A', '1', 'ISSUED'],
    ['production', 'req-2', '1', '102', 'A', '1', 'PROVIDER_INFRA_UNAVAILABLE'],
    ['homologation', 'req-3', '1', '1001', 'A', '1', 'SUBMITTED_ASYNC_PROCESSING']
  ];
  const pendingCheckRes = await checkPendingEntries({
    readSheetValues: async () => rpsPendingSample
  });
  assert.strictEqual(pendingCheckRes.pendingCount, 1, 'Deve identificar exatamente 1 pendencia em producao');
  assert.strictEqual(pendingCheckRes.pendingEntries[0].requestId, 'req-2');

  console.log('✓ test-issue.js PASSED');
}

module.exports = run();
