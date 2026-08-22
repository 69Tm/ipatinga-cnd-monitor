'use strict';

const assert = require('assert');
const { XMLValidator } = require('fast-xml-parser');
const {
  demandRows,
  tomadorRows,
  patternRows,
  prepareDemand,
  handlePrepare
} = require('../prepare');

console.log('Running test-prepare.js...');

const demandasRaw = [
  ['Message ID', 'Período', 'Notas solicitadas', 'Valores', 'Descrição obrigatória', 'Status', 'NFS-e resultantes', 'Números RPS', 'Séries RPS', 'Tipos RPS'],
  ['req-hic', '08/2026', 'HIC — Plantões PS SUS; HIC — Produção PS SUS', '1000,00; 200,00', 'Descrição plantões vinda do e-mail || Descrição produção vinda do e-mail', 'PENDENTE', '', '101;102', 'A;A', '1;1'],
  ['req-cisurg', '08/2026', 'CISURG — Plantões credenciamento', '4199,40', 'DESCRIÇÃO EXATA DO ESPELHO MENSAL', 'PENDENTE', '', '103', 'A', '1'],
  ['req-done', '07/2026', 'CISURG', '4199,40', 'descrição', 'CONCLUÍDA', '15', '', '', '']
];
const tomadoresRaw = [
  ['CNPJ', 'Razão Social', 'Nome Curto', 'Município', 'Categorias Conhecidas', 'Status Homologação'],
  ['20.724.357/0001-20', 'HIC', 'HIC', 'Guanhães/MG', 'HIC', 'HOMOLOGADO'],
  ['50.098.089/0001-49', 'CISURG', 'CISURG', 'Itabira/MG', 'CISURG', 'HOMOLOGADO']
];
const patternsRaw = [
  ['ID Padrão', 'Nome Padrão', 'Tomador', 'CNPJ Tomador', 'Categoria', 'Template / Descrição Oficial', 'Cód. Trib. Nacional', 'Cód. Trib. Municipal', 'Local Prestação', 'NBS', 'Confiança', 'Status'],
  ['HIC_PLANTOES_PS_SUS', 'HIC Plantões', 'HIC', '20.724.357/0001-20', 'HIC — Plantões PS SUS', '', '04.03.01', '403', 'Guanhães/MG', '123011900', 'ALTA', 'VALIDADO'],
  ['HIC_PRODUCAO_PS_SUS', 'HIC Produção', 'HIC', '20.724.357/0001-20', 'HIC — Produção PS SUS', '', '04.03.01', '403', 'Guanhães/MG', '123011900', 'ALTA', 'VALIDADO'],
  ['CISURG_PLANTAO_PRESENCIAL', 'CISURG', 'CISURG', '50.098.089/0001-49', 'CISURG', '', '04.03.01', '403', 'Guanhães/MG', '123011900', 'MÉDIA', 'VALIDADO']
];

const demandas = demandRows(demandasRaw);
const tomadores = tomadorRows(tomadoresRaw);
const patterns = patternRows(patternsRaw);

const hic = prepareDemand({ requestId: 'req-hic', demandas, tomadores, patterns });
assert.strictEqual(hic.candidates.length, 2);
assert.notStrictEqual(hic.candidates[0].patternId, hic.candidates[1].patternId);
assert.strictEqual(hic.candidates[0].valor, 1000);
assert.strictEqual(hic.candidates[1].valor, 200);
assert.strictEqual(hic.candidates[0].aliquotaIss, null);
assert.strictEqual(XMLValidator.validate(hic.candidates[0].xmlCandidate), true);
assert.deepStrictEqual(hic.blockingReasons, ['OFFICIAL_ABRASF_XSD_NOT_AVAILABLE_TO_EXECUTOR']);

const cisurg = prepareDemand({ requestId: 'req-cisurg', demandas, tomadores, patterns });
assert.strictEqual(cisurg.candidates[0].descricao, 'DESCRIÇÃO EXATA DO ESPELHO MENSAL');
assert.ok(!cisurg.blockingReasons.includes('CISURG_MONTHLY_MIRROR_DESCRIPTION_REQUIRED'));
assert.ok(cisurg.candidates[0].xmlCandidate.includes('DESCRIÇÃO EXATA DO ESPELHO MENSAL'));

const done = prepareDemand({ requestId: 'req-done', demandas, tomadores, patterns });
assert.deepStrictEqual(done.blockingReasons, ['DUPLICATE_ALREADY_ISSUED']);
assert.strictEqual(done.candidates.length, 0);

const missingCritical = prepareDemand({
  requestId: 'req-cisurg',
  demandas: demandRows([demandasRaw[0], ['req-cisurg', '08/2026', 'CISURG', '4199,40', '', 'PENDENTE', '', '', '', '']]),
  tomadores,
  patterns
});
assert.ok(missingCritical.blockingReasons.includes('DESCRIPTION_SOURCE_REQUIRED'));
assert.ok(missingCritical.blockingReasons.includes('CISURG_MONTHLY_MIRROR_DESCRIPTION_REQUIRED'));
assert.ok(missingCritical.blockingReasons.includes('RPS_NUMBER_MISSING'));

async function run() {
  let writes = 0;
  const lookup = range => {
    if (range.includes('Demandas')) return demandasRaw;
    if (range.includes('Tomadores')) return tomadoresRaw;
    if (range.includes('Padrões')) return patternsRaw;
    return [['Nº NFS-e']];
  };
  const result = await handlePrepare({ requestId: 'req-cisurg', environment: 'production', dryRun: false }, {
    readSheetValues: async (_id, range) => lookup(range),
    updateSheetValues: async () => { writes++; },
    appendSheetValues: async () => { writes++; }
  });
  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(result.writeAllowed, false);
  assert.strictEqual(result.executedWrites, 0);
  assert.strictEqual(writes, 0);
  console.log('✓ test-prepare.js PASSED');
}

module.exports = run();
