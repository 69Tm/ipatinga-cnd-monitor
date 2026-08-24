'use strict';

const assert = require('assert');
const {
  KNOWN_PATTERNS,
  runHistoricalAnalysis,
  buildTomadoresRows,
  buildPadroesRows
} = require('../patterns');

console.log('Running test-patterns.js...');

assert.strictEqual(KNOWN_PATTERNS.length, 3);

// 1. HIC Plantões
const hicPlantoes = KNOWN_PATTERNS.find(p => p.patternId === 'HIC_PLANTOES_PS_SUS');
assert.ok(hicPlantoes);
assert.strictEqual(hicPlantoes.cnpjTomadorClean, '20724357000120');
assert.strictEqual(hicPlantoes.codigoTribNacional, '04.03.01');
assert.strictEqual(hicPlantoes.codigoTribMunicipal, '403');
assert.strictEqual(hicPlantoes.localPrestacao, 'Guanhães/MG');
assert.strictEqual(hicPlantoes.codigoIbgePrestacao, '3128006');
assert.strictEqual(hicPlantoes.codigoMunicipioIncidenciaIss, '3131307');
assert.strictEqual(hicPlantoes.confianca, 'ALTA');
assert.ok(hicPlantoes.template.includes('{BLOCO_BANCARIO}'));
assert.ok(!hicPlantoes.template.includes('13618683-0'), 'Zero dados bancarios hardcoded no template');

// 2. HIC Produção
const hicProd = KNOWN_PATTERNS.find(p => p.patternId === 'HIC_PRODUCAO_PS_SUS');
assert.ok(hicProd);
assert.strictEqual(hicProd.cnpjTomadorClean, '20724357000120');
assert.strictEqual(hicProd.codigoMunicipioIncidenciaIss, '3131307');
assert.strictEqual(hicProd.confianca, 'ALTA');
assert.ok(hicProd.template.includes('{BLOCO_BANCARIO}'));

// 3. CISURG
const cisurg = KNOWN_PATTERNS.find(p => p.patternId === 'CISURG_PLANTAO_PRESENCIAL');
assert.ok(cisurg);
assert.strictEqual(cisurg.cnpjTomadorClean, '50098089000149');
assert.strictEqual(cisurg.localPrestacao, 'Guanhães/MG');
assert.strictEqual(cisurg.codigoIbgePrestacao, '3128006');
assert.strictEqual(cisurg.codigoMunicipioIncidenciaIss, '3131307');
assert.strictEqual(cisurg.confianca, 'MÉDIA');
assert.ok(cisurg.template.includes('ESPELHO DO MÊS É FONTE DE VERDADE'));
assert.strictEqual(cisurg.nbs, '123011900');

console.log('✓ test-patterns.js PASSED');
