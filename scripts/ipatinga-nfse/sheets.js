'use strict';

const { CONFIG } = require('./config');
const {
  readSheetValues,
  updateSheetValues,
  appendSheetValues,
  batchUpdateSheetValues
} = require('./google');
const {
  formatCurrency,
  formatAliquot,
  formatDateBr,
  onlyDigits,
  parseCurrency,
  parseAliquot,
  parseIsoDate,
  parseCompetencia
} = require('./validators');

function dateKey(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000;
    return new Date(millis).toISOString().slice(0, 10);
  }
  const text = String(value ?? '').trim();
  const isoMatch = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  const brMatch = text.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (brMatch) return `${brMatch[3]}-${brMatch[2]}-${brMatch[1]}`;
  const parsed = parseIsoDate(value);
  return parsed ? `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}` : String(value ?? '').trim();
}

function competenceKey(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return dateKey(value).slice(0, 7);
  const parsed = parseCompetencia(value);
  const match = String(parsed).match(/^(\d{2})\/(\d{4})$/);
  return match ? `${match[2]}-${match[1]}` : String(value ?? '').trim();
}

function semanticallyEqual(columnIndex, left, right) {
  if ([8, 13].includes(columnIndex)) {
    return Math.abs(parseCurrency(left) - parseCurrency(right)) < 0.000001;
  }
  if (columnIndex === 12) {
    return Math.abs(parseAliquot(left) - parseAliquot(right)) < 0.000001;
  }
  if (columnIndex === 3) return dateKey(left) === dateKey(right);
  if (columnIndex === 2) return competenceKey(left) === competenceKey(right);
  return String(left ?? '').trim() === String(right ?? '').trim();
}

/**
 * Lê a aba Notas e mapeia as linhas existentes
 */
async function loadExistingNotas(spreadsheetId = null) {
  const ssId = spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tab = CONFIG.SHEETS.TABS.NOTAS;

  const rows = await readSheetValues(ssId, `${tab}!A:X`, 'UNFORMATTED_VALUE');
  if (!rows || rows.length === 0) {
    return {
      headers: [],
      notas: [],
      byNumber: new Map(),
      byChave: new Map(),
      byCnpjNumero: new Map()
    };
  }

  const headers = rows[0].map(h => String(h || '').trim());
  const notas = [];
  const byNumber = new Map();
  const byChave = new Map();
  const byCnpjNumero = new Map();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = i + 1; // 1-indexed no Sheets
    const numero = String(row[0] || '').trim();
    const chave = String(row[15] || '').trim();

    const record = {
      rowIndex: i,
      rowNumber,
      numero,
      periodoRef: row[1] || '',
      competencia: row[2] || '',
      emissao: row[3] || '',
      tomador: row[4] || '',
      cnpjTomador: row[5] || '',
      categoria: row[6] || '',
      discriminacao: row[7] || '',
      valorServico: row[8] || '',
      codTribNacional: row[9] || '',
      codTribMunicipal: row[10] || '',
      localPrestacao: row[11] || '',
      aliquota: row[12] || '',
      issApurado: row[13] || '',
      nbs: row[14] || '',
      chaveAcesso: chave,
      fonte: row[16] || '',
      emailOrigem: row[17] || '',
      status: row[18] || '',
      observacoes: row[19] || '',
      fonteApi: row[20] || '',
      ultimaSync: row[21] || '',
      codVerificacao: row[22] || '',
      situacaoApi: row[23] || '',
      rawRow: row
    };

    notas.push(record);
    if (numero) {
      const cleanNum = String(parseInt(onlyDigits(numero), 10) || numero);
      byNumber.set(cleanNum, record);
    }
    if (chave) {
      byChave.set(chave, record);
    }
    if (numero && record.cnpjTomador) {
      byCnpjNumero.set(`${onlyDigits(record.cnpjTomador)}:${onlyDigits(numero)}`, record);
    }
  }

  return {
    headers,
    notas,
    byNumber,
    byChave,
    byCnpjNumero
  };
}

/**
 * Garante cabeçalhos completos incluindo as colunas técnicas extras
 */
async function ensureHeaders(spreadsheetId = null) {
  const ssId = spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tab = CONFIG.SHEETS.TABS.NOTAS;

  const current = await readSheetValues(ssId, `${tab}!A1:X1`);
  const baseHeaders = [
    'Nº NFS-e',
    'Período referência',
    'Competência NFS-e',
    'Emissão',
    'Tomador',
    'CNPJ tomador',
    'Categoria',
    'Descrição do serviço',
    'Valor serviço',
    'Cód. trib. nacional',
    'Cód. trib. municipal',
    'Local prestação',
    'Alíquota ISS',
    'ISS apurado',
    'NBS',
    'Chave de acesso',
    'Fonte',
    'E-mail origem',
    'Status',
    'Observações',
    'Fonte API',
    'Última sincronização API',
    'Código de verificação',
    'Situação API'
  ];

  if (!current || current.length === 0 || current[0].length < baseHeaders.length) {
    await updateSheetValues(ssId, `${tab}!A1:X1`, [baseHeaders]);
  }
}

/**
 * Realiza UPSERT de uma lista de NFS-e na aba Notas
 */
async function upsertNotas(apiNotas, spreadsheetId = null, dryRun = false, dependencies = {}) {
  const ssId = spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tab = CONFIG.SHEETS.TABS.NOTAS;
  const ensure = dependencies.ensureHeaders || ensureHeaders;
  const load = dependencies.loadExistingNotas || loadExistingNotas;
  const batchUpdate = dependencies.batchUpdateSheetValues || batchUpdateSheetValues;
  const append = dependencies.appendSheetValues || appendSheetValues;
  if (!dryRun) await ensure(ssId);
  const existing = await load(ssId);

  const timestampIso = new Date().toISOString();
  const rowsToUpdate = [];
  const rowsToAppend = [];

  let totalNew = 0;
  let totalUpdated = 0;
  let totalUnchanged = 0;
  let totalCanceled = 0;
  let totalSubstituted = 0;
  const changeAudit = [];
  const columnNames = [
    'numero', 'periodoRef', 'competencia', 'emissao', 'tomador', 'cnpjTomador',
    'categoria', 'discriminacao', 'valorServico', 'codTribNacional', 'codTribMunicipal',
    'localPrestacao', 'aliquota', 'issApurado', 'nbs', 'chaveAcesso', 'fonte',
    'emailOrigem', 'status', 'observacoes', 'fonteApi', 'ultimaSync',
    'codVerificacao', 'situacaoApi'
  ];

  for (const item of apiNotas) {
    const cleanNum = String(parseInt(onlyDigits(item.numero), 10) || item.numero);
    const cnpjNumberKey = `${onlyDigits(item.cnpjTomador)}:${onlyDigits(item.numero)}`;
    const existingRec = (item.chaveAcesso && existing.byChave.get(item.chaveAcesso)) ||
      existing.byCnpjNumero?.get(cnpjNumberKey) || existing.byNumber.get(cleanNum);

    if (item.status === 'CANCELADA') {
      totalCanceled++;
    }
    if (item.status === 'SUBSTITUIDA') {
      totalSubstituted++;
    }

    if (existingRec) {
      // Linha Existente -> UPDATE preservando campos humanos
      const newRow = [
        item.numero || existingRec.numero,                                  // A
        existingRec.periodoRef || '',                                       // B (humano)
        item.competencia || existingRec.competencia,                        // C
        formatDateBr(item.dataEmissao) || existingRec.emissao,              // D
        item.tomador || existingRec.tomador,                                // E
        item.cnpjTomador || existingRec.cnpjTomador,                        // F
        existingRec.categoria || '',                                        // G (humano)
        item.discriminacao || existingRec.discriminacao,                    // H
        formatCurrency(item.valorServicos),                                 // I
        item.codigoTribNacional || existingRec.codTribNacional,             // J
        item.codigoTribMunicipal || existingRec.codTribMunicipal,           // K
        item.localPrestacao || existingRec.localPrestacao,                  // L
        formatAliquot(item.aliquota),                                       // M
        formatCurrency(item.issApurado),                                    // N
        item.nbs || existingRec.nbs,                                        // O
        item.chaveAcesso || existingRec.chaveAcesso,                        // P
        existingRec.fonte || '',                                            // Q (humano)
        existingRec.emailOrigem || '',                                      // R (humano)
        item.status || existingRec.status,                                  // S
        existingRec.observacoes || '',                                      // T (humano)
        'Prefeitura Ipatinga — ABRASF 2.04',                                 // U (técnico)
        timestampIso,                                                       // V (técnico)
        item.codigoVerificacao || existingRec.codVerificacao,               // W (técnico)
        item.situacaoDetalhe || existingRec.situacaoApi                     // X (técnico)
      ];

      const comparableNew = [...newRow];
      comparableNew[21] = existingRec.ultimaSync || '';
      const comparableOld = Array.from({ length: 24 }, (_, index) => existingRec.rawRow[index] ?? '');
      const changedIndexes = comparableNew
        .map((value, index) => !semanticallyEqual(index, value, comparableOld[index]) ? index : -1)
        .filter(index => index >= 0);
      const changed = changedIndexes.length > 0;
      if (changed) {
        rowsToUpdate.push({ range: `${tab}!A${existingRec.rowNumber}:X${existingRec.rowNumber}`, values: [newRow] });
        changeAudit.push({ numero: item.numero, fields: changedIndexes.map(index => columnNames[index]) });
        totalUpdated++;
      } else {
        totalUnchanged++;
      }
    } else {
      // Nova Nota -> INSERT
      const newRow = [
        item.numero,                                                       // A
        '',                                                                // B
        item.competencia,                                                  // C
        formatDateBr(item.dataEmissao),                                    // D
        item.tomador,                                                      // E
        item.cnpjTomador,                                                  // F
        '',                                                                // G
        item.discriminacao,                                                // H
        formatCurrency(item.valorServicos),                                // I
        item.codigoTribNacional,                                           // J
        item.codigoTribMunicipal,                                          // K
        item.localPrestacao,                                               // L
        formatAliquot(item.aliquota),                                      // M
        formatCurrency(item.issApurado),                                   // N
        item.nbs,                                                          // O
        item.chaveAcesso,                                                  // P
        'API',                                                             // Q
        '',                                                                // R
        item.status,                                                       // S
        '',                                                                // T
        'Prefeitura Ipatinga — ABRASF 2.04',                                // U
        timestampIso,                                                      // V
        item.codigoVerificacao,                                            // W
        item.situacaoDetalhe                                               // X
      ];

      rowsToAppend.push(newRow);
      totalNew++;
    }
  }

  if (!dryRun) {
    // Executa batchUpdate para linhas existentes
    if (rowsToUpdate.length > 0) {
      await batchUpdate(ssId, rowsToUpdate);
    }
    // Executa append para novas linhas
    if (rowsToAppend.length > 0) {
      await append(ssId, `${tab}!A:X`, rowsToAppend);
    }
  }

  return {
    totalProcessed: apiNotas.length,
    totalNew,
    totalUpdated,
    totalUnchanged,
    totalCanceled,
    totalSubstituted,
    changeAudit,
    dryRun
  };
}

module.exports = {
  loadExistingNotas,
  ensureHeaders,
  upsertNotas,
  semanticallyEqual,
  dateKey,
  competenceKey
};
