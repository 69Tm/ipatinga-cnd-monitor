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
    const match = range.match(/!A(d+):Md+/);
    if (match) {
      const idx = parseInt(match[1], 10) - 1;
      mockStorage[idx] = rows[0];
    }
  }
};

async function run() {
  // 1. Alocação persistente
  const alloc = await allocateRpsAtomically({
    environment: 'homologation',
    requestId: 'req-test-2',
    itemIndex: 1
  }, mockDependencies);

  assert.strictEqual(alloc.rps_numero, '1002');
  assert.strictEqual(alloc.status, RPS_STATUS.ALLOCATED);
  assert.strictEqual(mockStorage.length, 3);

  // 2. Transição ALLOCATED -> SUBMITTING
  const submitting = await markSubmitting(alloc, mockDependencies);
  assert.strictEqual(submitting.status, RPS_STATUS.SUBMITTING);
  assert.ok(submitting.submitted_at);

  // 3. Transição SUBMITTING -> ISSUED
  const issued = await markIssued(submitting, { nfseNumero: '90002', nfseChave: 'CHAVE90002' }, mockDependencies);
  assert.strictEqual(issued.status, RPS_STATUS.ISSUED);
  assert.strictEqual(issued.nfse_numero, '90002');

  // 4. Teste Timeout Transition
  const allocTimeout = await allocateRpsAtomically({
    environment: 'homologation',
    requestId: 'req-timeout',
    itemIndex: 1
  }, mockDependencies);

  const timeoutEntry = await markUnknownAfterTimeout(allocTimeout, { error: 'ECONNRESET' }, mockDependencies);
  assert.strictEqual(timeoutEntry.status, RPS_STATUS.UNKNOWN_AFTER_TIMEOUT);

  console.log('✓ test-ledger.js PASSED');
}

module.exports = run();
