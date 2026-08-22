'use strict';

const assert = require('assert');
const { buildConsoleSummary } = require('../report');

const result = buildConsoleSummary({
  operation: 'sync',
  status: 'DRY_RUN',
  environment: 'production',
  mode: 'incremental',
  dryRun: true,
  completedRanges: [{ from: 1, to: 50 }, { from: 51, to: 100 }],
  totalApi: 15,
  totalNormalized: 15,
  upsertResult: {
    totalNew: 0,
    totalUpdated: 0,
    totalUnchanged: 15,
    totalCanceled: 1,
    totalSubstituted: 0,
    changeAudit: [
      { numero: '10', fields: ['chaveAcesso'] },
      { numero: '11', fields: ['chaveAcesso', 'situacaoApi'] }
    ]
  },
  errors: [],
  warnings: ['technical warning'],
  noteAudit: [{ numero: 1, descricao: 'must not be logged' }],
  certificate: { privateKeyPem: 'must not be logged' }
});

assert.deepStrictEqual(result, {
  operation: 'sync',
  status: 'DRY_RUN',
  environment: 'production',
  mode: 'incremental',
  dryRun: true,
  completedRanges: 2,
  totalApi: 15,
  totalNormalized: 15,
  new: 0,
  updated: 0,
  unchanged: 15,
  canceled: 1,
  substituted: 0,
  changedFieldCounts: { chaveAcesso: 2, situacaoApi: 1 },
  plannedWrites: 0,
  executedWrites: 0,
  localRepairs: 0,
  errors: 0,
  warnings: 1
});

const preflightResult = buildConsoleSummary({
  operation: 'preflight',
  environment: 'production',
  status: 'READY_ALL_OK',
  dryRun: true
});
assert.strictEqual(preflightResult.operation, 'preflight');
assert.strictEqual(preflightResult.environment, 'production');
assert.strictEqual(preflightResult.status, 'READY_ALL_OK');
assert.strictEqual(preflightResult.dryRun, true);
