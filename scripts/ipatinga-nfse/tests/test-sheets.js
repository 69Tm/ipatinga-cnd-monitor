'use strict';

const assert = require('assert');
const { upsertNotas, semanticallyEqual, dateKey, competenceKey } = require('../sheets');

console.log('Running test-sheets.js...');
assert.strictEqual(semanticallyEqual(8, '12.925,00', '12925'), true);
assert.strictEqual(semanticallyEqual(13, 'R$ 2,29', 2.29), true);
assert.strictEqual(semanticallyEqual(12, '2,4227%', 0.024227), true);
assert.strictEqual(semanticallyEqual(8, '100,00', '101,00'), false);
assert.strictEqual(dateKey(46233), dateKey('2026-07-30'));
assert.strictEqual(competenceKey('07/2026'), '2026-07');

function maps(record = null) {
  const result = { byNumber: new Map(), byChave: new Map(), byCnpjNumero: new Map() };
  if (record) {
    result.byNumber.set(record.numero, record);
    if (record.chaveAcesso) result.byChave.set(record.chaveAcesso, record);
    if (record.cnpjTomador) result.byCnpjNumero.set(`${record.cnpjTomador.replace(/\D/g, '')}:${record.numero}`, record);
  }
  return result;
}

function note(overrides = {}) {
  return {
    numero: '10', competencia: '06/2026', dataEmissao: '2026-06-15',
    tomador: 'HIC', cnpjTomador: '20.724.357/0001-20', discriminacao: 'Servico',
    valorServicos: 100, codigoTribNacional: '04.03.01', codigoTribMunicipal: '403',
    localPrestacao: 'Guanhães/MG', aliquota: 2.291, issApurado: 2.29, nbs: '123',
    chaveAcesso: 'CHAVE10', status: 'NORMAL', codigoVerificacao: 'COD',
    situacaoDetalhe: 'Normal', ...overrides
  };
}

async function run() {
  let appended;
  await upsertNotas([note()], null, false, {
    ensureHeaders: async () => {},
    loadExistingNotas: async () => maps(),
    appendSheetValues: async (_id, _range, values) => { appended = values; },
    batchUpdateSheetValues: async () => assert.fail('não deveria atualizar')
  });
  assert.strictEqual(appended.length, 1);
  assert.strictEqual(appended[0].length, 24);
  assert.strictEqual(appended[0][0], '10');
  assert.strictEqual(appended[0][20], 'Prefeitura Ipatinga — ABRASF 2.04');

  const raw = Array(24).fill('');
  raw[0] = '10'; raw[1] = 'PERIODO HUMANO'; raw[4] = 'HIC antigo'; raw[5] = '20.724.357/0001-20';
  raw[6] = 'CATEGORIA HUMANA'; raw[17] = 'email@origem'; raw[19] = 'OBS HUMANA'; raw[15] = 'CHAVE10';
  const record = {
    rowNumber: 2, numero: '10', periodoRef: raw[1], competencia: '', emissao: '',
    tomador: raw[4], cnpjTomador: raw[5], categoria: raw[6], discriminacao: '',
    valorServico: '', codTribNacional: '', codTribMunicipal: '', localPrestacao: '',
    aliquota: '', issApurado: '', nbs: '', chaveAcesso: raw[15], fonte: '',
    emailOrigem: raw[17], status: '', observacoes: raw[19], fonteApi: '',
    ultimaSync: '', codVerificacao: '', situacaoApi: '', rawRow: raw
  };
  let updated;
  const updateResult = await upsertNotas([note()], null, false, {
    ensureHeaders: async () => {},
    loadExistingNotas: async () => maps(record),
    batchUpdateSheetValues: async (_id, data) => { updated = data; },
    appendSheetValues: async () => assert.fail('mesma chave não deve duplicar')
  });
  const updateRow = updated[0].values[0];
  assert.strictEqual(updateRow.length, 24);
  assert.strictEqual(updateRow[1], 'PERIODO HUMANO');
  assert.strictEqual(updateRow[6], 'CATEGORIA HUMANA');
  assert.strictEqual(updateRow[17], 'email@origem');
  assert.strictEqual(updateRow[19], 'OBS HUMANA');
  assert.strictEqual(updateRow[8], '100,00');
  assert.strictEqual(updateRow[12], '2,291%');
  assert.ok(updateResult.changeAudit[0].fields.includes('periodoRef') === false);
  assert.ok(updateResult.changeAudit[0].fields.includes('valorServico'));

  const fallbackRecord = { ...record, chaveAcesso: '', rawRow: [...raw] };
  fallbackRecord.rawRow[15] = '';
  let fallbackUpdates = 0;
  await upsertNotas([note({ chaveAcesso: '' })], null, false, {
    ensureHeaders: async () => {},
    loadExistingNotas: async () => maps(fallbackRecord),
    batchUpdateSheetValues: async () => { fallbackUpdates++; },
    appendSheetValues: async () => assert.fail('fallback CNPJ+número deve atualizar')
  });
  assert.strictEqual(fallbackUpdates, 1);

  let writes = 0;
  let headerWrites = 0;
  const dryResult = await upsertNotas([note()], null, true, {
    ensureHeaders: async () => { headerWrites++; },
    loadExistingNotas: async () => maps(),
    batchUpdateSheetValues: async () => { writes++; },
    appendSheetValues: async () => { writes++; }
  });
  assert.strictEqual(writes, 0);
  assert.strictEqual(headerWrites, 0);
  assert.strictEqual(dryResult.dryRun, true);
  console.log('✓ test-sheets.js PASSED');
}

module.exports = run();
