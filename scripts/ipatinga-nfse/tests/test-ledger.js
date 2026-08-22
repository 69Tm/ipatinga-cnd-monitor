'use strict';

const assert = require('assert');
const {
  loadLedger,
  findLedgerEntry,
  allocateNextRpsNumber,
  allocateRpsAtomically,
  markSubmitting,
  markSubmittedAsyncProcessing,
  markIssued,
  markRejectedCorrectable,
  markUnknownAfterTimeout,
  markFailedSafe,
  RPS_STATUS,
  MAX_ATTEMPTS
} = require('../ledger');

console.log('Running test-ledger.js...');

let mockStorage = [
  ['environment', 'request_id', 'item_index', 'rps_numero', 'rps_serie', 'rps_tipo', 'status', 'allocated_at', 'submitted_at', 'nfse_numero', 'nfse_chave', 'last_query_at', 'attempt_count', 'last_attempt_at', 'provider_error_codes', 'provider_message', 'error'],
  ['homologation', 'req-test-1', '1', '1001', 'A', '1', 'ISSUED', '2026-08-22T09:00:00Z', '2026-08-22T09:00:05Z', '90001', 'CHAVE123', '2026-08-22T09:00:10Z', '1', '2026-08-22T09:00:05Z', '', 'NFS-e emitida com sucesso', '']
];

const mockDependencies = {
  readSheetValues: async () => mockStorage,
  appendSheetValues: async (_id, _range, rows) => {
    mockStorage.push(...rows);
  },
  updateSheetValues: async (_id, range, rows) => {
    const match = range.match(/!A(\d+):Q\d+/);
    if (match) {
      const idx = parseInt(match[1], 10) - 1;
      mockStorage[idx] = rows[0];
    }
  }
};

async function run() {
  // 1. Alocação persistente no mockStorage
  let alloc = await allocateRpsAtomically({
    environment: 'homologation',
    requestId: 'req-test-2',
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
  assert.strictEqual(mockStorage[2][12], 1);

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

  console.log('✓ test-ledger.js PASSED');
}

module.exports = run();
