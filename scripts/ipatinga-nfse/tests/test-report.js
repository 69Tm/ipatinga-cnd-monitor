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
    totalSubstituted: 0
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
  errors: 0,
  warnings: 1
});

