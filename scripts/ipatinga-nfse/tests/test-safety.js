'use strict';

const assert = require('assert');
const { enforceOperationSafety } = require('../main');

console.log('Running test-safety.js...');

// 1. Emissão sem kill switch deve ser permitida em qualquer ambiente
delete process.env.NFE_ISSUE_KILL_SWITCH;
assert.doesNotThrow(() => enforceOperationSafety('issue', 'production'));
assert.doesNotThrow(() => enforceOperationSafety('issue', 'homologation'));
assert.doesNotThrow(() => enforceOperationSafety('sync', 'production'));

// 2. Kill switch ativo bloqueia emissão
process.env.NFE_ISSUE_KILL_SWITCH = 'true';
assert.throws(() => enforceOperationSafety('issue', 'production'), /NFE_ISSUE_KILL_SWITCH_ACTIVE/);
assert.throws(() => enforceOperationSafety('issue', 'homologation'), /NFE_ISSUE_KILL_SWITCH_ACTIVE/);
assert.doesNotThrow(() => enforceOperationSafety('sync', 'production'));

delete process.env.NFE_ISSUE_KILL_SWITCH;
console.log('✓ test-safety.js PASSED');
