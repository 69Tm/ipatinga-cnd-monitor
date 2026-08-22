'use strict';

const assert = require('assert');
const {
  KNOWN_PATTERNS,
  runHistoricalAnalysis,
  buildTomadoresRows,
  buildPadroesRows,
  buildLocalPrestacaoRepairs,
  rowsEqual
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
assert.ok(hicPlantoes.camposFixos.includes('Inter'));

// 2. HIC Produção
const hicProd = KNOWN_PATTERNS.find(p => p.patternId === 'HIC_PRODUCAO_PS_SUS');
assert.ok(hicProd);
assert.strictEqual(hicProd.cnpjTomadorClean, '20724357000120');
assert.strictEqual(hicProd.codigoMunicipioIncidenciaIss, '3131307');
assert.strictEqual(hicProd.confianca, 'ALTA');

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
assert.deepStrictEqual(cisurg.driveFileIdsExemplo, ['16GPS4KvIWENhRHOs4bYTymb62WetOolk']);

const notas = [
  ['Nº', 'Período', 'Competência', 'Emissão', 'Tomador', 'CNPJ', 'Categoria', '', '', '', '', 'Local'],
  ['10', '06/2026', '07/2026', '', 'HIC', '20.724.357/0001-20', 'HIC — Plantões Médicos PS SUS', '', '', '', '', 'IBGE 0'],
  ['15', '07/2026', '08/2026', '', 'CISURG', '50.098.089/0001-49', 'CISURG — Plantão médico presencial', '', '', '', '', 'IBGE 0']
];
const tomadores = buildTomadoresRows(notas, [
  ['CNPJ', 'Razão Social', 'Nome Curto', 'Logradouro', 'Número', 'Complemento', 'Bairro', 'Cód. Município', 'Município', 'UF', 'CEP', 'E-mail', 'Categorias Conhecidas', 'Status Homologação', 'Fonte Endereço', 'Validado Em', 'Primeiro Uso', 'Último Uso', 'Qtd NFS-e'],
  ['20.724.357/0001-20', 'HIC', 'HIC Guanhães', 'CAPITAO BERNARDO', '257', '', 'CENTRO', '3128006', 'Guanhães', 'MG', '39740000', 'humano@hic.org.br', '', 'HOMOLOGADO', 'NFS-e histórica', '2026-08-22', '', '', '']
]);
assert.strictEqual(tomadores.length, 3);
assert.strictEqual(tomadores[1][11], 'humano@hic.org.br'); // E-mail
assert.strictEqual(tomadores[1][18], 11); // Qtd NFS-e
assert.strictEqual(tomadores[2][8], 'Itabira'); // Município Tomador CISURG

console.log('✓ test-patterns.js PASSED');
