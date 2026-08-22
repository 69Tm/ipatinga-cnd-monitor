'use strict';

const assert = require('assert');
const { KNOWN_PATTERNS } = require('../patterns');

console.log('Running test-patterns.js...');

assert.strictEqual(KNOWN_PATTERNS.length, 3);

// 1. HIC Plantões
const hicPlantoes = KNOWN_PATTERNS.find(p => p.patternId === 'HIC_PLANTOES_PS_SUS');
assert.ok(hicPlantoes);
assert.strictEqual(hicPlantoes.cnpjTomadorClean, '20724357000120');
assert.strictEqual(hicPlantoes.codigoTribNacional, '04.03.01');
assert.strictEqual(hicPlantoes.codigoTribMunicipal, '403');
assert.strictEqual(hicPlantoes.localPrestacao, 'Guanhães/MG');
assert.strictEqual(hicPlantoes.confianca, 'ALTA');

// 2. HIC Produção
const hicProd = KNOWN_PATTERNS.find(p => p.patternId === 'HIC_PRODUCAO_PS_SUS');
assert.ok(hicProd);
assert.strictEqual(hicProd.cnpjTomadorClean, '20724357000120');
assert.strictEqual(hicProd.confianca, 'ALTA');

// 3. CISURG
const cisurg = KNOWN_PATTERNS.find(p => p.patternId === 'CISURG_PLANTAO_PRESENCIAL');
assert.ok(cisurg);
assert.strictEqual(cisurg.cnpjTomadorClean, '50098089000149');
assert.strictEqual(cisurg.localPrestacao, 'Ipatinga/MG');
assert.ok(cisurg.template.includes('ESPELHO DO MÊS É FONTE DE VERDADE'));

console.log('✓ test-patterns.js PASSED');
