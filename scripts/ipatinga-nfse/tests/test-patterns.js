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
assert.strictEqual(hicPlantoes.confianca, 'ALTA');
assert.ok(hicPlantoes.camposFixos.includes('Inter'));
assert.ok(!hicPlantoes.camposFixos.includes('BB'));

// 2. HIC Produção
const hicProd = KNOWN_PATTERNS.find(p => p.patternId === 'HIC_PRODUCAO_PS_SUS');
assert.ok(hicProd);
assert.strictEqual(hicProd.cnpjTomadorClean, '20724357000120');
assert.strictEqual(hicProd.confianca, 'ALTA');

// 3. CISURG
const cisurg = KNOWN_PATTERNS.find(p => p.patternId === 'CISURG_PLANTAO_PRESENCIAL');
assert.ok(cisurg);
assert.strictEqual(cisurg.cnpjTomadorClean, '50098089000149');
assert.strictEqual(cisurg.localPrestacao, 'Guanhães/MG');
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
  ['CNPJ', 'Razão Social', 'Nome Curto', 'Município', 'E-mail', 'Categorias Conhecidas', 'Status Homologação', 'Primeiro Uso', 'Último Uso', 'Qtd NFS-e'],
  ['20.724.357/0001-20', 'HIC', 'HIC Guanhães', 'Guanhães/MG', 'humano@hic.org.br', '', 'HOMOLOGADO', '', '', '']
]);
assert.strictEqual(tomadores.length, 3);
assert.strictEqual(tomadores[1][4], 'humano@hic.org.br');
assert.strictEqual(tomadores[1][9], 1);
assert.strictEqual(tomadores[2][3], 'Itabira/MG');
assert.strictEqual(buildPadroesRows()[0].length, 20);
assert.strictEqual(buildPadroesRows()[1].length, 20);
assert.deepStrictEqual(buildLocalPrestacaoRepairs(notas).map(item => item.numero), ['10', '15']);
assert.strictEqual(rowsEqual([[' a ', 1]], [['a', '1']]), true);

async function run() {
  let externalWrites = 0;
  const result = await runHistoricalAnalysis({ dryRun: true }, {
    getDriveClient: () => ({ files: { list: async () => ({ data: { files: [
      { id: 'A', name: 'HIC NFS.pdf' },
      { id: 'A', name: 'HIC NFS.pdf' },
      { id: 'B', name: 'CISURG NFS.pdf' }
    ] } }) } }),
    readSheetValues: async (_id, range) => range.includes('Notas') ? notas : [['header']],
    updateSheetValues: async () => { externalWrites++; },
    batchUpdateSheetValues: async () => { externalWrites++; }
  });
  assert.strictEqual(externalWrites, 0);
  assert.strictEqual(result.status, 'DRY_RUN');
  assert.strictEqual(result.writeAllowed, false);
  assert.strictEqual(result.totalArquivosDrivePesquisados, 2);
  assert.ok(result.plannedWrites > 0);
  assert.strictEqual(result.executedWrites, 0);
  console.log('✓ test-patterns.js PASSED');
}

module.exports = run();
