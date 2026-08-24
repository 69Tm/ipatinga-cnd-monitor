'use strict';

const { CONFIG } = require('./config');
const { readSheetValues, appendSheetValues, updateSheetValues, createSheetIfNotExists } = require('./google');

const RPS_STATUS = Object.freeze({
  ALLOCATED: 'ALLOCATED',
  SUBMITTING: 'SUBMITTING',
  SUBMITTED_ASYNC_PROCESSING: 'SUBMITTED_ASYNC_PROCESSING',
  ISSUED: 'ISSUED',
  REJECTED_CORRECTABLE: 'REJECTED_CORRECTABLE',
  UNKNOWN_AFTER_TIMEOUT: 'UNKNOWN_AFTER_TIMEOUT',
  PROVIDER_INFRA_UNAVAILABLE: 'PROVIDER_INFRA_UNAVAILABLE',
  FAILED_SAFE: 'FAILED_SAFE'
});

const RECONCILIATION_STATUS = Object.freeze({
  ISSUED: 'ISSUED',
  RPS_NOT_FOUND_CONFIRMED: 'RPS_NOT_FOUND_CONFIRMED',
  PROCESSING: 'PROCESSING',
  QUERY_FAILED: 'QUERY_FAILED',
  AMBIGUOUS: 'AMBIGUOUS'
});

const MAX_ATTEMPTS = 5;

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
  'attempt_count',
  'last_attempt_at',
  'provider_error_codes',
  'provider_message',
  'error'
];

function transformLegacyLedgerRow(row) {
  if (!row || row.length === 0) return [];
  
  if (row.length <= 13) {
    const legacyError = row[12] ? String(row[12]).trim() : '';
    const isSubmitted = Boolean(row[8]);
    const attemptCount = isSubmitted ? '1' : '0';
    const lastAttemptAt = row[8] ? String(row[8]).trim() : '';

    return [
      row[0] || '',
      row[1] || '',
      row[2] || '',
      row[3] || '',
      row[4] || '',
      row[5] || '',
      row[6] || '',
      row[7] || '',
      row[8] || '',
      row[9] || '',
      row[10] || '',
      row[11] || '',
      attemptCount,
      lastAttemptAt,
      '',
      '',
      legacyError
    ];
  }

  return row;
}

async function ensureLedgerSheet(dependencies = {}) {
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tabName = CONFIG.SHEETS.TABS.RPS || 'RPS';
  const createSheet = dependencies.createSheetIfNotExists || createSheetIfNotExists;
  const read = dependencies.readSheetValues || readSheetValues;
  const update = dependencies.updateSheetValues || updateSheetValues;

  await createSheet(spreadsheetId, tabName);

  const existing = await read(spreadsheetId, `${tabName}!A1:Q1`);
  if (!existing || existing.length === 0 || !existing[0] || existing[0].length === 0) {
    await update(spreadsheetId, `${tabName}!A1:Q1`, [LEDGER_HEADERS]);
    return true;
  }

  return false;
}

async function loadLedger(dependencies = {}) {
  const read = dependencies.readSheetValues || readSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tabName = CONFIG.SHEETS.TABS.RPS || 'RPS';

  const rows = await read(spreadsheetId, `${tabName}!A:Q`);
  if (!rows || rows.length <= 1) {
    return [];
  }

  return rows.slice(1).map((rawRow, idx) => {
    const row = transformLegacyLedgerRow(rawRow);
    const rawAttempts = row[12];
    const entry = {
      rowIndex: idx + 2,
      environment: row[0] || '',
      request_id: row[1] || '',
      item_index: row[2] || '1',
      rps_numero: row[3] || '',
      rps_serie: row[4] || 'A',
      rps_tipo: row[5] || '1',
      status: row[6] || RPS_STATUS.ALLOCATED,
      allocated_at: row[7] || '',
      submitted_at: row[8] || '',
      nfse_numero: row[9] || '',
      nfse_chave: row[10] || '',
      last_query_at: row[11] || '',
      attempt_count: 0,
      last_attempt_at: row[13] || '',
      provider_error_codes: row[14] || '',
      provider_message: row[15] || '',
      error: row[16] || ''
    };

    if (rawAttempts === undefined || rawAttempts === null || isNaN(Number(rawAttempts))) {
      entry.attempt_count = entry.submitted_at ? 1 : 0;
    } else {
      entry.attempt_count = rawAttempts !== '' ? Number(rawAttempts) : (entry.submitted_at ? 1 : 0);
    }
    return entry;
  });
}

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
    '0', // attempt_count
    '', // last_attempt_at
    '', // provider_error_codes
    '', // provider_message
    ''  // error
  ];

  await append(spreadsheetId, `${tabName}!A:Q`, [newRow]);

  return {
    rowIndex: ledgerEntries.length + 2,
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
    attempt_count: 0,
    last_attempt_at: '',
    provider_error_codes: '',
    provider_message: '',
    error: ''
  };
}

async function updateLedgerEntry(entry, updates, dependencies = {}) {
  const update = dependencies.updateSheetValues || updateSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tabName = CONFIG.SHEETS.TABS.RPS || 'RPS';

  const updatedEntry = { ...entry, ...updates };
  const attempts = Number(updatedEntry.attempt_count || 0);

  const rowValues = [
    updatedEntry.environment,
    updatedEntry.request_id,
    String(updatedEntry.item_index),
    updatedEntry.rps_numero,
    updatedEntry.rps_serie,
    updatedEntry.rps_tipo,
    updatedEntry.status,
    updatedEntry.allocated_at,
    updatedEntry.submitted_at,
    updatedEntry.nfse_numero,
    updatedEntry.nfse_chave,
    updatedEntry.last_query_at,
    String(attempts),
    updatedEntry.last_attempt_at,
    updatedEntry.provider_error_codes,
    updatedEntry.provider_message,
    updatedEntry.error
  ];

  await update(spreadsheetId, `${tabName}!A${entry.rowIndex}:Q${entry.rowIndex}`, [rowValues]);
  return updatedEntry;
}

async function markSubmitting(entry, dependencies = {}) {
  const now = new Date().toISOString();
  const currentAttempts = Number(entry.attempt_count || 0);

  return updateLedgerEntry(entry, {
    status: RPS_STATUS.SUBMITTING,
    submitted_at: entry.submitted_at || now,
    last_attempt_at: now,
    attempt_count: currentAttempts + 1
  }, dependencies);
}

async function markSubmittedAsyncProcessing(entry, { providerMessage = '' } = {}, dependencies = {}) {
  return updateLedgerEntry(entry, {
    status: RPS_STATUS.SUBMITTED_ASYNC_PROCESSING,
    last_query_at: new Date().toISOString(),
    provider_message: String(providerMessage || 'Aguardando processamento assíncrono').slice(0, 500)
  }, dependencies);
}

async function markIssued(entry, { nfseNumero, nfseChave, dataEmissao }, dependencies = {}) {
  return updateLedgerEntry(entry, {
    status: RPS_STATUS.ISSUED,
    nfse_numero: String(nfseNumero),
    nfse_chave: String(nfseChave),
    last_query_at: new Date().toISOString(),
    provider_error_codes: '',
    provider_message: 'NFS-e emitida com sucesso',
    error: ''
  }, dependencies);
}

async function markRejectedCorrectable(entry, { error, providerErrorCodes = '', providerMessage = '' }, dependencies = {}) {
  const count = Number(entry.attempt_count || 0);
  const nextStatus = count >= MAX_ATTEMPTS ? RPS_STATUS.FAILED_SAFE : RPS_STATUS.REJECTED_CORRECTABLE;
  const errorText = count >= MAX_ATTEMPTS ? `MAX_ATTEMPTS_EXCEEDED (${count}): ${error}` : String(error || 'REJECTED_CORRECTABLE');

  return updateLedgerEntry(entry, {
    status: nextStatus,
    last_query_at: new Date().toISOString(),
    provider_error_codes: String(providerErrorCodes || ''),
    provider_message: String(providerMessage || errorText).slice(0, 500),
    error: errorText
  }, dependencies);
}

async function markUnknownAfterTimeout(entry, { error }, dependencies = {}) {
  return updateLedgerEntry(entry, {
    status: RPS_STATUS.UNKNOWN_AFTER_TIMEOUT,
    last_query_at: new Date().toISOString(),
    error: String(error || 'TIMEOUT')
  }, dependencies);
}

async function markProviderInfraUnavailable(entry, { error }, dependencies = {}) {
  return updateLedgerEntry(entry, {
    status: RPS_STATUS.PROVIDER_INFRA_UNAVAILABLE,
    last_query_at: new Date().toISOString(),
    error: String(error || 'PROVIDER_INFRA_UNAVAILABLE')
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
  RECONCILIATION_STATUS,
  MAX_ATTEMPTS,
  LEDGER_HEADERS,
  transformLegacyLedgerRow,
  ensureLedgerSheet,
  loadLedger,
  findLedgerEntry,
  allocateNextRpsNumber,
  allocateRpsAtomically,
  updateLedgerEntry,
  markSubmitting,
  markSubmittedAsyncProcessing,
  markIssued,
  markRejectedCorrectable,
  markUnknownAfterTimeout,
  markProviderInfraUnavailable,
  markFailedSafe
};
