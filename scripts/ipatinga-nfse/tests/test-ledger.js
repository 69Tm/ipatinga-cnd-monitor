'use strict';

const assert = require('assert');
const { loadLedger, findLedgerEntry, allocateNextRpsNumber, RPS_STATUS } = require('../ledger');

console.log('Running test-ledger.js...');

const sampleRows = [
  ['environment', 'request_id', 'item_index', 'rps_numero', 'rps_serie', 'rps_tipo', 'status', 'allocated_at', 'submitted_at', 'nfse_numero', 'nfse_chave', 'last_query_at', 'error'],
  ['homologation', 'req-test-1', '1', '1001', 'A', '1', 'ISSUED', '2026-08-22T09:00:00Z', '2026-08-22T09:00:05Z', '90001', 'CHAVE123', '2026-08-22T09:00:10Z', ''],
  ['production', 'req-prod-1', '1', '101', 'A', '1', 'ISSUED', '2026-08-22T09:00:00Z', '2026-08-22T09:00:05Z', '16', 'CHAVEPROD', '2026-08-22T09:00:10Z', '']
];

async function run() {
  const ledger = await loadLedger({
    readSheetValues: async () => sampleRows
  });

  assert.strictEqual(ledger.length, 2);

  const found = findLedgerEntry(ledger, {
    environment: 'homologation',
    requestId: 'req-test-1',
    itemIndex: 1
  });
  assert.ok(found);
  assert.strictEqual(found.rps_numero, '1001');
  assert.strictEqual(found.status, RPS_STATUS.ISSUED);

  const nextAlloc = allocateNextRpsNumber(ledger, 'homologation', 'A', '1');
  assert.strictEqual(nextAlloc.rpsNumero, '1002');
  assert.strictEqual(nextAlloc.rpsSerie, 'A');

  console.log('✓ test-ledger.js PASSED');
}

module.exports = run();
