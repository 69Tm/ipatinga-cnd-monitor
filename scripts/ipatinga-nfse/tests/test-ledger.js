'use strict';

const assert = require('assert');
const {
  loadLedger,
  findLedgerEntry,
  allocateNextRpsNumber,
  allocateRpsAtomically,
  markSubmitting,
  markIssued,
  markUnknownAfterTimeout,
  markFailedSafe,
  RPS_STATUS
} = require('../ledger');

console.log('Running test-ledger.js...');

let mockStorage = [
  ['environment', 'request_id', 'item_index', 'rps_numero', 'rps_serie', 'rps_tipo', 'status', 'allocated_at', 'submitted_at', 'nfse_numero', 'nfse_chave', 'last_query_at', 'error'],
  ['homologation', 'req-test-1', '1', '1001', 'A', '1', 'ISSUED', '2026-08-22T09:00:00Z', '2026-08-22T09:00:05Z', '90001', 'CHAVE123', '2026-08-22T09:00:10Z', '']
];

const mockDependencies = {
  readSheetValues: async () => mockStorage,
  appendSheetValues: async (_id, _range, rows) => {
    mockStorage.push(...rows);
  },
  updateSheetValues: async (_id, range, rows) => {
    const match = range.match(/!A(\d+):M\d+/);
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
  assert.strictEqual(mockStorage.length, 3);
  assert.strictEqual(mockStorage[2][3], '1002');
  assert.strictEqual(mockStorage[2][6], RPS_STATUS.ALLOCATED);

  // 2. Transição ALLOCATED -> SUBMITTING (reatribuição de estado)
  alloc = await markSubmitting(alloc, mockDependencies);
  assert.strictEqual(alloc.status, RPS_STATUS.SUBMITTING);
  assert.ok(alloc.submitted_at, 'submitted_at deve estar preenchido');
  assert.strictEqual(mockStorage[2][6], RPS_STATUS.SUBMITTING);
  assert.strictEqual(mockStorage[2][8], alloc.submitted_at);

  // 3. Transição SUBMITTING -> ISSUED (preservando submitted_at na linha final do mockStorage)
  const submittedAtSaved = alloc.submitted_at;
  alloc = await markIssued(alloc, { nfseNumero: '90002', nfseChave: 'CHAVE90002' }, mockDependencies);
  assert.strictEqual(alloc.status, RPS_STATUS.ISSUED);
  assert.strictEqual(alloc.nfse_numero, '90002');
  assert.strictEqual(mockStorage[2][6], RPS_STATUS.ISSUED);
  assert.strictEqual(mockStorage[2][8], submittedAtSaved, 'submitted_at DEVE ser preservado na linha persistida final');
  assert.strictEqual(mockStorage[2][9], '90002');

  // 4. Teste Timeout Transition
  let allocTimeout = await allocateRpsAtomically({
    environment: 'homologation',
    requestId: 'req-timeout',
    itemIndex: 1
  }, mockDependencies);

  allocTimeout = await markSubmitting(allocTimeout, mockDependencies);
  const timeoutSubmittedAt = allocTimeout.submitted_at;

  allocTimeout = await markUnknownAfterTimeout(allocTimeout, { error: 'ECONNRESET' }, mockDependencies);
  assert.strictEqual(allocTimeout.status, RPS_STATUS.UNKNOWN_AFTER_TIMEOUT);
  assert.strictEqual(mockStorage[3][6], RPS_STATUS.UNKNOWN_AFTER_TIMEOUT);
  assert.strictEqual(mockStorage[3][8], timeoutSubmittedAt, 'submitted_at preservado pós timeout');

  console.log('✓ test-ledger.js PASSED');
}

module.exports = run();
