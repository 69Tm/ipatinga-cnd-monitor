'use strict';

const assert = require('assert');
const {
  normalizeCnpj,
  formatCnpj,
  isValidCnpj,
  parseCurrency,
  formatCurrency,
  parseAliquot,
  formatAliquot,
  formatDateBr,
  formatDateIso,
  parseCompetencia
} = require('../validators');

console.log('Running test-validators.js...');

// 1. CNPJ Normalization & Validation
assert.strictEqual(normalizeCnpj('31.302.407/0001-05'), '31302407000105');
assert.strictEqual(formatCnpj('31302407000105'), '31.302.407/0001-05');
assert.strictEqual(isValidCnpj('31.302.407/0001-05'), true);
assert.strictEqual(isValidCnpj('20.724.357/0001-20'), true);
assert.strictEqual(isValidCnpj('50.098.089/0001-49'), true);
assert.strictEqual(isValidCnpj('00.000.000/0000-00'), false);
assert.strictEqual(isValidCnpj('11.111.111/1111-11'), false);

// 2. Currency
assert.strictEqual(parseCurrency('R$ 12.925,00'), 12925);
assert.strictEqual(parseCurrency('12925.00'), 12925);
assert.strictEqual(parseCurrency('4.199,40'), 4199.4);
assert.strictEqual(formatCurrency(12925), '12.925,00');
assert.strictEqual(formatCurrency(4199.4), '4.199,40');

// 3. Aliquots (Dynamic without hardcoding 2% vs 2.291%)
assert.strictEqual(parseAliquot('2.291%'), 2.291);
assert.strictEqual(parseAliquot('2,291%'), 2.291);
assert.strictEqual(parseAliquot('0.02291'), 2.291);
assert.strictEqual(parseAliquot('2%'), 2);
assert.strictEqual(parseAliquot(0.02), 2);
assert.strictEqual(formatAliquot(2.291), '2,2910%');
assert.strictEqual(formatAliquot(2.0), '2,00%');

// 4. Dates & Competência
assert.strictEqual(formatDateBr('2026-06-15T10:30:00'), '15/06/2026');
assert.strictEqual(formatDateIso('15/06/2026'), '2026-06-15');
assert.strictEqual(parseCompetencia('2026-06-01'), '06/2026');
assert.strictEqual(parseCompetencia('07/2026'), '07/2026');

console.log('✓ test-validators.js PASSED');
