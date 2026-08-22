'use strict';

const assert = require('assert');
const { XMLValidator } = require('fast-xml-parser');
const {
  demandRows,
  tomadorRows,
  patternRows,
  prepareDemand,
  buildHomologationFixture,
  handlePrepare
} = require('../prepare');

console.log('Running test-prepare.js...');

const demandasRaw = [
  ['Message ID', 'Período', 'Notas solicitadas', 'Valores', 'Descrição obrigatória', 'Status', 'NFS-e resultantes'],
  ['req-hic', '08/2026', 'HIC — Plantões PS SUS; HIC — Produção PS SUS', '1000,00; 200,00', 'Descrição plantões vinda do e-mail || Descrição produção vinda do e-mail', 'PENDENTE', ''],
  ['req-cisurg', '08/2026', 'CISURG — Plantões credenciamento', '4199,40', 'DESCRIÇÃO EXATA DO ESPELHO MENSAL', 'PENDENTE', ''],
  ['req-done', '07/2026', 'CISURG', '4199,40', 'descrição', 'CONCLUÍDA', '15'],
  ['req-sem-pattern', '08/2026', 'Serviço Médico Desconhecido', '500,00', 'Descrição médica avulsa', 'PENDENTE', '']
];
const tomadoresRaw = [
  ['CNPJ', 'Razão Social', 'Nome Curto', 'Município', 'Categorias Conhecidas', 'Status Homologação'],
  ['20.724.357/0001-20', 'HOSPITAL IMACULADA CONCEICAO', 'HIC', 'Guanhães/MG', 'HIC', 'HOMOLOGADO'],
  ['50.098.089/0001-49', 'CISURG', 'CISURG', 'Itabira/MG', 'CISURG', 'HOMOLOGADO']
];
const patternsRaw = [
  ['ID Padrão', 'Nome Padrão', 'Tomador', 'CNPJ Tomador', 'Categoria', 'Template / Descrição Oficial', 'Cód. Trib. Nacional', 'Cód. Trib. Municipal', 'Local Prestação', 'NBS', 'Confiança', 'Status'],
  ['HIC_PLANTOES_PS_SUS', 'HIC Plantões', 'HOSPITAL IMACULADA CONCEICAO', '20.724.357/0001-20', 'HIC — Plantões PS SUS', '', '04.03.01', '403', 'Guanhães/MG', '123011900', 'ALTA', 'VALIDADO'],
  ['HIC_PRODUCAO_PS_SUS', 'HIC Produção', 'HOSPITAL IMACULADA CONCEICAO', '20.724.357/0001-20', 'HIC — Produção PS SUS', '', '04.03.01', '403', 'Guanhães/MG', '123011900', 'ALTA', 'VALIDADO'],
  ['CISURG_PLANTAO_PRESENCIAL', 'CISURG', 'CISURG', '50.098.089/0001-49', 'CISURG', '', '04.03.01', '403', 'Guanhães/MG', '123011900', 'MÉDIA', 'VALIDADO']
];

const demandas = demandRows(demandasRaw);
const tomadores = tomadorRows(tomadoresRaw);
const patterns = patternRows(patternsRaw);

// 1. Demanda HIC válida
const hic = prepareDemand({ requestId: 'req-hic', demandas, tomadores, patterns });
assert.strictEqual(hic.candidates.length, 2);
assert.notStrictEqual(hic.candidates[0].patternId, hic.candidates[1].patternId);
assert.strictEqual(hic.candidates[0].valor, 1000);
assert.strictEqual(hic.candidates[1].valor, 200);
assert.strictEqual(hic.candidates[0].aliquotaIss, null);
assert.strictEqual(hic.candidates[0].rpsStatus, 'PENDING_ALLOCATION');
assert.strictEqual(XMLValidator.validate(hic.candidates[0].xmlCandidate), true);
assert.strictEqual(hic.validationStatus, 'READY_TO_ISSUE');
assert.strictEqual(hic.blockingReasons.length, 0);

// 2. Demanda sem pattern -> PREPARE_NOT_READY (SEM defaults silenciosos)
const semPattern = prepareDemand({ requestId: 'req-sem-pattern', demandas, tomadores, patterns });
assert.strictEqual(semPattern.validationStatus, 'REVISAO_MANUAL');
assert.ok(semPattern.blockingReasons.includes('PATTERN_NOT_IDENTIFIED'));
assert.ok(semPattern.blockingReasons.includes('TAKER_CNPJ_INVALID'));
assert.ok(semPattern.blockingReasons.includes('SERVICE_LOCATION_MISSING'));

// 3. Fixture explícita de homologação
const fixture = buildHomologationFixture();
assert.strictEqual(fixture.validationStatus, 'READY_TO_ISSUE');
assert.strictEqual(fixture.candidates[0].descricao, 'TESTE DE HOMOLOGACAO - SEM VALOR FISCAL - AUTOMACAO DEXMED');
assert.strictEqual(fixture.candidates[0].valor, 10.00);
assert.ok(!fixture.candidates[0].xmlCandidate.includes('<Aliquota>0.0000</Aliquota>'));
assert.ok(!fixture.candidates[0].xmlCandidate.includes('<ValorIss>0</ValorIss>'));
assert.ok(!fixture.candidates[0].xmlCandidate.includes('<CodigoCnae>8610701</CodigoCnae>'));

// 4. Demanda CISURG
const cisurg = prepareDemand({ requestId: 'req-cisurg', demandas, tomadores, patterns });
assert.strictEqual(cisurg.candidates[0].descricao, 'DESCRIÇÃO EXATA DO ESPELHO MENSAL');
assert.ok(!cisurg.blockingReasons.includes('CISURG_MONTHLY_MIRROR_DESCRIPTION_REQUIRED'));
assert.ok(cisurg.candidates[0].xmlCandidate.includes('DESCRIÇÃO EXATA DO ESPELHO MENSAL'));
assert.strictEqual(cisurg.validationStatus, 'READY_TO_ISSUE');

// 5. Demanda já emitida
const done = prepareDemand({ requestId: 'req-done', demandas, tomadores, patterns });
assert.deepStrictEqual(done.blockingReasons, ['DUPLICATE_ALREADY_ISSUED']);
assert.strictEqual(done.candidates.length, 0);

// 6. Demanda sem descrição obrigatória
const missingCritical = prepareDemand({
  requestId: 'req-cisurg',
  demandas: demandRows([demandasRaw[0], ['req-cisurg', '08/2026', 'CISURG', '4199,40', '', 'PENDENTE', '']]),
  tomadores,
  patterns
});
assert.ok(missingCritical.blockingReasons.includes('DESCRIPTION_SOURCE_REQUIRED'));
assert.ok(missingCritical.blockingReasons.includes('CISURG_MONTHLY_MIRROR_DESCRIPTION_REQUIRED'));

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
