'use strict';

const assert = require('assert');
const {
  RPS_STATUS,
  MAX_ATTEMPTS,
  loadLedger,
  allocateRpsAtomically,
  markSubmitting,
  markSubmittedAsyncProcessing,
  markIssued,
  markRejectedCorrectable,
  markUnknownAfterTimeout,
  markProviderInfraUnavailable,
  markFailedSafe
} = require('../ledger');

console.log('Running test-ledger.js...');

async function run() {
  const mockStorage = [
    ['environment', 'request_id', 'item_index', 'rps_numero', 'rps_serie', 'rps_tipo', 'status', 'allocated_at', 'submitted_at', 'nfse_numero', 'nfse_chave', 'last_query_at', 'attempt_count', 'last_attempt_at', 'provider_error_codes', 'provider_message', 'error'],
    ['homologation', 'req-existente', '1', '1001', 'A', '1', 'ISSUED', '2026-08-22T10:00:00Z', '2026-08-22T10:00:01Z', '90001', 'CHAVE90001', '2026-08-22T10:00:05Z', '1', '2026-08-22T10:00:01Z', '', 'NFS-e emitida com sucesso', '']
  ];

  const mockDependencies = {
    spreadsheetId: 'mock-ss-id',
    readSheetValues: async (_id, _range) => mockStorage,
    appendSheetValues: async (_id, _range, rows) => {
      rows.forEach(r => mockStorage.push(r));
      return { updates: { updatedRows: rows.length } };
    },
    updateSheetValues: async (_id, range, rows) => {
      const match = range.match(/A(\d+):Q\1/);
      if (match) {
        const rowIndex = parseInt(match[1], 10) - 1;
        mockStorage[rowIndex] = rows[0];
      }
      return { updatedRows: 1 };
    },
    createSheetIfNotExists: async () => true
  };

  // 1. Alocação Atômica de novo RPS
  let alloc = await allocateRpsAtomically({
    environment: 'homologation',
    requestId: 'req-novo',
    itemIndex: 1
  }, mockDependencies);

  assert.strictEqual(alloc.rps_numero, '1002');
  assert.strictEqual(alloc.status, RPS_STATUS.ALLOCATED);
  assert.strictEqual(alloc.attempt_count, 0);
  assert.strictEqual(mockStorage.length, 3);
  assert.strictEqual(mockStorage[2][3], '1002');
  assert.strictEqual(mockStorage[2][6], RPS_STATUS.ALLOCATED);

  // 2. Transição ALLOCATED -> SUBMITTING (incrementa attempt_count)
  alloc = await markSubmitting(alloc, mockDependencies);
  assert.strictEqual(alloc.status, RPS_STATUS.SUBMITTING);
  assert.strictEqual(alloc.attempt_count, 1);
  assert.ok(alloc.submitted_at, 'submitted_at deve estar preenchido');
  assert.ok(alloc.last_attempt_at, 'last_attempt_at deve estar preenchido');
  assert.strictEqual(mockStorage[2][6], RPS_STATUS.SUBMITTING);
  assert.strictEqual(mockStorage[2][8], alloc.submitted_at);
  assert.strictEqual(Number(mockStorage[2][12]), 1);

  // 3. Transição SUBMITTING -> SUBMITTED_ASYNC_PROCESSING
  alloc = await markSubmittedAsyncProcessing(alloc, { providerMessage: 'Solicitação recebida pelo ADN' }, mockDependencies);
  assert.strictEqual(alloc.status, RPS_STATUS.SUBMITTED_ASYNC_PROCESSING);
  assert.strictEqual(mockStorage[2][6], RPS_STATUS.SUBMITTED_ASYNC_PROCESSING);
  assert.strictEqual(mockStorage[2][15], 'Solicitação recebida pelo ADN');

  // 4. Transição SUBMITTED_ASYNC_PROCESSING -> ISSUED
  alloc = await markIssued(alloc, { nfseNumero: '90002', nfseChave: 'CHAVE90002' }, mockDependencies);
  assert.strictEqual(alloc.status, RPS_STATUS.ISSUED);
  assert.strictEqual(alloc.nfse_numero, '90002');
  assert.strictEqual(mockStorage[2][6], RPS_STATUS.ISSUED);
  assert.strictEqual(mockStorage[2][9], '90002');

  // 5. Teste de limite de tentativas (MAX_ATTEMPTS -> FAILED_SAFE)
  let retryAlloc = await allocateRpsAtomically({
    environment: 'homologation',
    requestId: 'req-retry-loop',
    itemIndex: 1
  }, mockDependencies);

  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    retryAlloc = await markSubmitting(retryAlloc, mockDependencies);
    retryAlloc = await markRejectedCorrectable(retryAlloc, { error: 'EL78', providerErrorCodes: 'EL78' }, mockDependencies);
  }

  assert.strictEqual(retryAlloc.attempt_count, MAX_ATTEMPTS);
  assert.strictEqual(retryAlloc.status, RPS_STATUS.FAILED_SAFE, 'Ao atingir MAX_ATTEMPTS deve travar em FAILED_SAFE');

  // 6. Teste de transição PROVIDER_INFRA_UNAVAILABLE
  let infraAlloc = await allocateRpsAtomically({
    environment: 'production',
    requestId: 'req-infra-test-ledger',
    itemIndex: 1
  }, mockDependencies);

  infraAlloc = await markSubmitting(infraAlloc, mockDependencies);
  infraAlloc = await markProviderInfraUnavailable(infraAlloc, { error: 'HTTP 500 WSDL' }, mockDependencies);
  assert.strictEqual(infraAlloc.status, RPS_STATUS.PROVIDER_INFRA_UNAVAILABLE);
  assert.strictEqual(infraAlloc.rps_numero, '101'); // Próximo em produção após o header

  console.log('✓ test-ledger.js PASSED');
}

module.exports = run();
