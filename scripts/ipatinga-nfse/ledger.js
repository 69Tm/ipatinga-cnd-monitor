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
  // Schema Legado (13 colunas: A:M):
  // 0: env, 1: req_id, 2: item_index, 3: rps_num, 4: rps_ser, 5: rps_tip,
  // 6: status, 7: alloc_at, 8: subm_at, 9: nfse_num, 10: nfse_key, 11: last_query_at, 12: error
  if (!row || row.length === 0) return [];
  
  // Se a linha tem 13 colunas ou menos, a coluna 12 (M) é o erro legado
  if (row.length <= 13) {
    const legacyError = row[12] ? String(row[12]).trim() : '';
    const isSubmitted = Boolean(row[8]);
    const attemptCount = isSubmitted ? '1' : '0';
    const lastAttemptAt = row[8] ? String(row[8]).trim() : '';

    return [
      row[0] || '',
      row[1] || '',
      row[2] || '1',
      row[3] || '',
      row[4] || 'A',
      row[5] || '1',
      row[6] || RPS_STATUS.ALLOCATED,
      row[7] || '',
      row[8] || '',
      row[9] || '',
      row[10] || '',
      row[11] || '',
      attemptCount,       // M: attempt_count
      lastAttemptAt,      // N: last_attempt_at
      '',                 // O: provider_error_codes
      legacyError ? legacyError.slice(0, 500) : '', // P: provider_message
      legacyError         // Q: error
    ];
  }

  // Se a linha já tem mais de 13 colunas, verificar se a coluna M (attempt_count) contém texto não-numérico acidental
  const mVal = String(row[12] || '').trim();
  const isMValNumeric = mVal === '' || !isNaN(Number(mVal));
  
  if (!isMValNumeric) {
    // Houve corrupção por shift anterior: M continha o antigo error
    const legacyError = mVal;
    const isSubmitted = Boolean(row[8]);
    const attemptCount = isSubmitted ? '1' : '0';
    const lastAttemptAt = row[8] ? String(row[8]).trim() : '';

    return [
      row[0] || '',
      row[1] || '',
      row[2] || '1',
      row[3] || '',
      row[4] || 'A',
      row[5] || '1',
      row[6] || RPS_STATUS.ALLOCATED,
      row[7] || '',
      row[8] || '',
      row[9] || '',
      row[10] || '',
      row[11] || '',
      attemptCount,
      lastAttemptAt,
      row[14] || '',
      row[15] || (legacyError ? legacyError.slice(0, 500) : ''),
      row[16] || legacyError
    ];
  }

  // Preenche até 17 colunas mantendo os valores originais
  const expanded = [...row];
  while (expanded.length < LEDGER_HEADERS.length) {
    expanded.push('');
  }
  return expanded;
}

async function ensureLedgerSheet(dependencies = {}) {
  const createSheet = dependencies.createSheetIfNotExists || (dependencies.readSheetValues ? null : createSheetIfNotExists);
  const read = dependencies.readSheetValues || readSheetValues;
  const update = dependencies.updateSheetValues || updateSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tabName = CONFIG.SHEETS.TABS.RPS || 'RPS';

  try {
    if (createSheet) {
      await createSheet(spreadsheetId, tabName);
    }
    const raw = await read(spreadsheetId, `${tabName}!A:Q`);
    if (!raw || raw.length === 0 || !raw[0] || raw[0].length === 0) {
      if (update) await update(spreadsheetId, `${tabName}!A1:Q1`, [LEDGER_HEADERS]);
      return;
    }

    // Migração de schema estruturada v1 -> v2 se necessário
    const isHeaderOld = raw[0].length < LEDGER_HEADERS.length || raw[0][12]?.toLowerCase() === 'error';
    const hasCorruptedRows = raw.slice(1).some(r => {
      const m = String(r[12] || '').trim();
      return m !== '' && isNaN(Number(m));
    });

    if (isHeaderOld || hasCorruptedRows) {
      const migratedRows = [LEDGER_HEADERS];
      for (let i = 1; i < raw.length; i++) {
        migratedRows.push(transformLegacyLedgerRow(raw[i]));
      }
      if (update) {
        await update(spreadsheetId, `${tabName}!A1:Q${migratedRows.length}`, migratedRows);
      }
    }
  } catch (err) {
    if (String(err.message).includes('Unable to parse range') || String(err.message).includes('not found')) {
      if (update) await update(spreadsheetId, `${tabName}!A1:Q1`, [LEDGER_HEADERS]);
    } else {
      throw err;
    }
  }
}

async function loadLedger(dependencies = {}) {
  const read = dependencies.readSheetValues || readSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tabName = CONFIG.SHEETS.TABS.RPS || 'RPS';

  let raw = [];
  try {
    raw = await read(spreadsheetId, `${tabName}!A:Q`);
  } catch (err) {
    if (String(err.message).includes('Unable to parse range') || String(err.message).includes('not found')) {
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
    
    // Sanitização de attempt_count caso contenha string legada
    const rawAttempts = entry.attempt_count;
    if (rawAttempts !== '' && isNaN(Number(rawAttempts))) {
      entry.error = entry.error || rawAttempts;
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
    0,  // attempt_count
    '', // last_attempt_at
    '', // provider_error_codes
    '', // provider_message
    ''  // error
  ];

  await append(spreadsheetId, `${tabName}!A:Q`, [newRow]);

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
    merged.attempt_count !== undefined ? Number(merged.attempt_count) : 0,
    merged.last_attempt_at || '',
    merged.provider_error_codes || '',
    merged.provider_message || '',
    merged.error || ''
  ];

  await update(spreadsheetId, `${tabName}!A${rowIndex}:Q${rowIndex}`, [rowValues]);
  return merged;
}

async function markSubmitting(entry, dependencies = {}) {
  const currentCount = Number(entry.attempt_count || 0);
  const nextCount = currentCount + 1;
  const nowIso = new Date().toISOString();

  return updateLedgerEntry(entry, {
    status: RPS_STATUS.SUBMITTING,
    submitted_at: entry.submitted_at || nowIso,
    attempt_count: nextCount,
    last_attempt_at: nowIso
  }, dependencies);
}

async function markSubmittedAsyncProcessing(entry, { providerMessage = '' } = {}, dependencies = {}) {
  return updateLedgerEntry(entry, {
    status: RPS_STATUS.SUBMITTED_ASYNC_PROCESSING,
    last_query_at: new Date().toISOString(),
    provider_message: String(providerMessage || '').slice(0, 500)
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
  markFailedSafe
};
