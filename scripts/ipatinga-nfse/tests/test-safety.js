'use strict';

const assert = require('assert');
const { enforceOperationSafety } = require('../main');

console.log('Running test-safety.js...');
assert.throws(() => enforceOperationSafety('issue', 'production'), /PRODUCTION_ISSUE_DISABLED/);
assert.doesNotThrow(() => enforceOperationSafety('sync', 'production'));
console.log('✓ test-safety.js PASSED');
