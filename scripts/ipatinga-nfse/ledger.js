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

  // Base inicial: 1000 para homologação se vazio, 1 para produção se vazio
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

module.exports = {
  RPS_STATUS,
  LEDGER_HEADERS,
  loadLedger,
  findLedgerEntry,
  allocateNextRpsNumber
};
