'use strict';

const { CONFIG } = require('./config');
const { readSheetValues, appendSheetValues, updateSheetValues } = require('./google');

const RPS_STATUS = Object.freeze({
  ALLOCATED: 'ALLOCATED',
  SUBMITTING: 'SUBMITTING',
  ISSUED: 'ISSUED',
  UNKNOWN_AFTER_TIMEOUT: 'UNKNOWN_AFTER_TIMEOUT',
  FAILED_SAFE: 'FAILED_SAFE'
});

const LEDGER_HEADERS = [
  'environment',
  'request_id',
  'item_index',
  'rps_numero',
  'rps_serie',
  'rps_tipo',
  'status',
  'allocated_at',
  'submitted_at',
  'nfse_numero',
  'nfse_chave',
  'last_query_at',
  'error'
];

/**
 * Garante que a aba RPS exista e possua o cabeçalho
 */
async function ensureLedgerSheet(dependencies = {}) {
  const read = dependencies.readSheetValues || readSheetValues;
  const update = dependencies.updateSheetValues || updateSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tabName = CONFIG.SHEETS.TABS.RPS || 'RPS';

  try {
    const raw = await read(spreadsheetId, `${tabName}!A1:M1`);
    if (!raw || raw.length === 0 || !raw[0] || raw[0].length === 0) {
      await update(spreadsheetId, `${tabName}!A1:M1`, [LEDGER_HEADERS]);
    }
  } catch (err) {
    if (String(err.message).includes('Unable to parse range')) {
      await update(spreadsheetId, `${tabName}!A1:M1`, [LEDGER_HEADERS]);
    } else {
      throw err;
    }
  }
}

/**
 * Lê todas as entradas da aba RPS do Ledger
 */
async function loadLedger(dependencies = {}) {
  const read = dependencies.readSheetValues || readSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tabName = CONFIG.SHEETS.TABS.RPS || 'RPS';

  let raw = [];
  try {
    raw = await read(spreadsheetId, `${tabName}!A:M`);
  } catch (err) {
    if (String(err.message).includes('Unable to parse range')) {
      return [];
    }
    throw err;
  }

  if (!raw || raw.length < 2) return [];

  const headers = raw[0].map(h => String(h || '').trim().toLowerCase());
  return raw.slice(1).map((row, idx) => {
    const entry = { _rowIndex: idx + 2 };
    headers.forEach((h, i) => {
      entry[h] = row[i] !== undefined ? String(row[i]).trim() : '';
    });
    return entry;
  });
}

/**
 * Encontra entrada no Ledger pela chave lógica (environment + request_id + item_index)
 */
function findLedgerEntry(ledgerEntries, { environment, requestId, itemIndex }) {
  const normEnv = String(environment || '').trim().toLowerCase();
  const normReq = String(requestId || '').trim();
  const normIdx = String(itemIndex || '1').trim();

  return ledgerEntries.find(entry =>
    entry.environment?.toLowerCase() === normEnv &&
    entry.request_id === normReq &&
    String(entry.item_index) === normIdx
  ) || null;
}

/**
 * Aloca o próximo número de RPS para o ambiente
 */
function allocateNextRpsNumber(ledgerEntries, environment, series = 'A', type = '1') {
  const normEnv = String(environment || '').trim().toLowerCase();
  const envEntries = ledgerEntries.filter(e => e.environment?.toLowerCase() === normEnv);

  let maxNum = 0;
  for (const entry of envEntries) {
    const n = parseInt(entry.rps_numero, 10);
    if (!isNaN(n) && n > maxNum) {
      maxNum = n;
    }
  }

  if (maxNum === 0) {
    maxNum = normEnv === 'homologation' ? 1000 : 100;
  }

  const nextNumber = maxNum + 1;
  return {
    rpsNumero: String(nextNumber),
    rpsSerie: String(series || 'A'),
    rpsTipo: String(type || '1')
  };
}

/**
 * Persiste novo registro ALLOCATED no Ledger
 */
async function allocateRpsAtomically({ environment, requestId, itemIndex = 1, series = 'A', type = '1' }, dependencies = {}) {
  const append = dependencies.appendSheetValues || appendSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tabName = CONFIG.SHEETS.TABS.RPS || 'RPS';

  const ledgerEntries = await loadLedger(dependencies);
  const existing = findLedgerEntry(ledgerEntries, { environment, requestId, itemIndex });
  if (existing) {
    return existing;
  }

  const nextAlloc = allocateNextRpsNumber(ledgerEntries, environment, series, type);
  const nowIso = new Date().toISOString();

  const newRow = [
    environment,
    requestId,
    String(itemIndex),
    nextAlloc.rpsNumero,
    nextAlloc.rpsSerie,
    nextAlloc.rpsTipo,
    RPS_STATUS.ALLOCATED,
    nowIso,
    '', // submitted_at
    '', // nfse_numero
    '', // nfse_chave
    '', // last_query_at
    ''  // error
  ];

  await append(spreadsheetId, `${tabName}!A:M`, [newRow]);

  return {
    _rowIndex: ledgerEntries.length + 2,
    environment,
    request_id: requestId,
    item_index: String(itemIndex),
    rps_numero: nextAlloc.rpsNumero,
    rps_serie: nextAlloc.rpsSerie,
    rps_tipo: nextAlloc.rpsTipo,
    status: RPS_STATUS.ALLOCATED,
    allocated_at: nowIso,
    submitted_at: '',
    nfse_numero: '',
    nfse_chave: '',
    last_query_at: '',
    error: ''
  };
}

/**
 * Atualiza status e campos de uma entrada existente no Ledger
 */
async function updateLedgerEntry(entry, updates, dependencies = {}) {
  const update = dependencies.updateSheetValues || updateSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tabName = CONFIG.SHEETS.TABS.RPS || 'RPS';

  const rowIndex = entry._rowIndex;
  if (!rowIndex) {
    throw new Error('LEDGER_ROW_INDEX_MISSING: Impossível atualizar linha sem _rowIndex.');
  }

  const merged = { ...entry, ...updates };
  const rowValues = [
    merged.environment,
    merged.request_id,
    merged.item_index,
    merged.rps_numero,
    merged.rps_serie,
    merged.rps_tipo,
    merged.status,
    merged.allocated_at,
    merged.submitted_at || '',
    merged.nfse_numero || '',
    merged.nfse_chave || '',
    merged.last_query_at || '',
    merged.error || ''
  ];

  await update(spreadsheetId, `${tabName}!A${rowIndex}:M${rowIndex}`, [rowValues]);
  return merged;
}

async function markSubmitting(entry, dependencies = {}) {
  return updateLedgerEntry(entry, {
    status: RPS_STATUS.SUBMITTING,
    submitted_at: new Date().toISOString()
  }, dependencies);
}

async function markIssued(entry, { nfseNumero, nfseChave }, dependencies = {}) {
  return updateLedgerEntry(entry, {
    status: RPS_STATUS.ISSUED,
    nfse_numero: String(nfseNumero),
    nfse_chave: String(nfseChave),
    error: ''
  }, dependencies);
}

async function markUnknownAfterTimeout(entry, { error }, dependencies = {}) {
  return updateLedgerEntry(entry, {
    status: RPS_STATUS.UNKNOWN_AFTER_TIMEOUT,
    last_query_at: new Date().toISOString(),
    error: String(error || 'TIMEOUT')
  }, dependencies);
}

async function markFailedSafe(entry, { error }, dependencies = {}) {
  return updateLedgerEntry(entry, {
    status: RPS_STATUS.FAILED_SAFE,
    last_query_at: new Date().toISOString(),
    error: String(error || 'UNKNOWN_ERROR')
  }, dependencies);
}

module.exports = {
  RPS_STATUS,
  LEDGER_HEADERS,
  ensureLedgerSheet,
  loadLedger,
  findLedgerEntry,
  allocateNextRpsNumber,
  allocateRpsAtomically,
  updateLedgerEntry,
  markSubmitting,
  markIssued,
  markUnknownAfterTimeout,
  markFailedSafe
};
