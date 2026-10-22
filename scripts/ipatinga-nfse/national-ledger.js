'use strict';

const { CONFIG } = require('./config');
const { readSheetValues, appendSheetValues, updateSheetValues, createSheetIfNotExists } = require('./google');

const NATIONAL_DPS_STATUS = Object.freeze({
  ALLOCATED: 'ALLOCATED',
  SUBMITTING: 'SUBMITTING',
  ISSUED: 'ISSUED',
  REJECTED_CORRECTABLE: 'REJECTED_CORRECTABLE',
  UNKNOWN_AFTER_TIMEOUT: 'UNKNOWN_AFTER_TIMEOUT',
  PROVIDER_INFRA_UNAVAILABLE: 'PROVIDER_INFRA_UNAVAILABLE',
  FAILED_SAFE: 'FAILED_SAFE'
});

const NATIONAL_LEDGER_HEADERS = [
  'environment',
  'request_id',
  'item_index',
  'dps_id',
  'dps_numero',
  'dps_serie',
  'status',
  'allocated_at',
  'submitted_at',
  'nfse_numero',
  'nfse_chave',
  'protocolo',
  'attempt_count',
  'last_attempt_at',
  'provider_error_codes',
  'provider_message',
  'error'
];

/**
 * Constrói o ID oficial da DPS com 45 posições (DPS + 42 dígitos numéricos)
 * Regra: "DPS" + Cód.Mun (7) + Tipo Inscrição (1) + Inscrição Federal (14) + Série DPS (5) + Núm. DPS (15)
 */
function buildOfficialDpsId({ codMun, tipoInscricao = '1', inscricaoFederal, serie = '1', numero }) {
  const cleanMun = String(codMun || '').replace(/\D/g, '');
  if (cleanMun.length !== 7) {
    throw new Error(`NATIONAL_DPS_ID_INVALID: Código do município deve ter exatamente 7 dígitos (recebido: '${codMun}').`);
  }
  const cleanDoc = String(inscricaoFederal || '').replace(/\D/g, '');
  if (cleanDoc.length !== 14 && cleanDoc.length !== 11) {
    throw new Error(`NATIONAL_DPS_ID_INVALID: Inscrição federal deve ter 14 dígitos (CNPJ) ou 11 dígitos (CPF) (recebido: '${inscricaoFederal}').`);
  }
  const munStr = cleanMun;
  const tipoStr = String(tipoInscricao || '1').replace(/\D/g, '').slice(0, 1) || '1';
  const docStr = cleanDoc.padStart(14, '0');
  const serieStr = String(serie || '1').replace(/\D/g, '').padStart(5, '0');
  const numStr = String(numero || '1').replace(/\D/g, '').padStart(15, '0');

  const id = `DPS${munStr}${tipoStr}${docStr}${serieStr}${numStr}`;
  if (!/^DPS[0-9]{42}$/.test(id) || id.length !== 45) {
    throw new Error(`NATIONAL_DPS_ID_INVALID: Identificador gerado '${id}' não atende ao padrão TSIdDPS (45 caracteres, DPS + 42 dígitos).`);
  }
  return id;
}

function getNationalLedgerTabName() {
  return CONFIG.SHEETS.TABS.DPS || 'DPS';
}

async function ensureNationalLedgerSheet(dependencies = {}) {
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tabName = getNationalLedgerTabName();
  const createSheet = dependencies.createSheetIfNotExists || createSheetIfNotExists;
  const read = dependencies.readSheetValues || readSheetValues;
  const update = dependencies.updateSheetValues || updateSheetValues;

  await createSheet(spreadsheetId, tabName);

  const existing = await read(spreadsheetId, `${tabName}!A1:Q1`);
  if (!existing || existing.length === 0 || !existing[0] || existing[0].length === 0) {
    await update(spreadsheetId, `${tabName}!A1:Q1`, [NATIONAL_LEDGER_HEADERS]);
    return true;
  }
  return false;
}

async function loadNationalLedger(dependencies = {}) {
  const read = dependencies.readSheetValues || readSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tabName = getNationalLedgerTabName();

  const rows = await read(spreadsheetId, `${tabName}!A:Q`);
  if (!rows || rows.length <= 1) {
    return [];
  }

  return rows.slice(1).map((row, idx) => {
    return {
      rowIndex: idx + 2,
      environment: row[0] || '',
      request_id: row[1] || '',
      item_index: row[2] || '1',
      dps_id: row[3] || '',
      dps_numero: row[4] || '',
      dps_serie: row[5] || '1',
      status: row[6] || NATIONAL_DPS_STATUS.ALLOCATED,
      allocated_at: row[7] || '',
      submitted_at: row[8] || '',
      nfse_numero: row[9] || '',
      nfse_chave: row[10] || '',
      protocolo: row[11] || '',
      attempt_count: row[12] ? Number(row[12]) : 0,
      last_attempt_at: row[13] || '',
      provider_error_codes: row[14] || '',
      provider_message: row[15] || '',
      error: row[16] || ''
    };
  });
}

function findNationalLedgerEntry(entries, { environment, requestId, itemIndex }) {
  const normEnv = String(environment || '').trim().toLowerCase();
  const normReq = String(requestId || '').trim();
  const normIdx = String(itemIndex || '1').trim();

  return entries.find(entry =>
    entry.environment?.toLowerCase() === normEnv &&
    entry.request_id === normReq &&
    String(entry.item_index) === normIdx
  ) || null;
}

function allocateNextDpsNumber(entries, environment, serie = '1') {
  const normEnv = String(environment || '').trim().toLowerCase();
  const envEntries = entries.filter(e => e.environment?.toLowerCase() === normEnv);

  let maxNum = 0;
  for (const entry of envEntries) {
    const n = parseInt(entry.dps_numero, 10);
    if (!isNaN(n) && n > maxNum) {
      maxNum = n;
    }
  }

  const nextNumber = maxNum + 1;
  return {
    dpsNumero: String(nextNumber),
    dpsSerie: String(serie || '1')
  };
}

async function allocateDpsAtomically({ environment, requestId, itemIndex = 1, serie = '1' }, dependencies = {}) {
  const append = dependencies.appendSheetValues || appendSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tabName = getNationalLedgerTabName();

  const entries = await loadNationalLedger(dependencies);
  const existing = findNationalLedgerEntry(entries, { environment, requestId, itemIndex });
  if (existing) {
    return existing;
  }

  const { dpsNumero, dpsSerie } = allocateNextDpsNumber(entries, environment, serie);
  const now = new Date().toISOString();

  const codMun = CONFIG.PRESTADOR.CODIGO_MUNICIPIO_IPATINGA || '3131307';
  const tipoInscricao = '1'; // CNPJ
  const inscricaoFederal = CONFIG.PRESTADOR.CNPJ_DIGITS || '31302407000105';
  const dpsId = buildOfficialDpsId({
    codMun,
    tipoInscricao,
    inscricaoFederal,
    serie: dpsSerie,
    numero: dpsNumero
  });

  const row = [
    environment,
    requestId,
    String(itemIndex),
    dpsId,
    dpsNumero,
    dpsSerie,
    NATIONAL_DPS_STATUS.ALLOCATED,
    now,
    '', // submitted_at
    '', // nfse_numero
    '', // nfse_chave
    '', // protocolo
    '0', // attempt_count
    '', // last_attempt_at
    '', // provider_error_codes
    '', // provider_message
    ''  // error
  ];

  await append(spreadsheetId, `${tabName}!A:Q`, [row]);

  return {
    rowIndex: entries.length + 2,
    environment,
    request_id: requestId,
    item_index: String(itemIndex),
    dps_id: dpsId,
    dps_numero: dpsNumero,
    dps_serie: dpsSerie,
    status: NATIONAL_DPS_STATUS.ALLOCATED,
    allocated_at: now,
    submitted_at: '',
    nfse_numero: '',
    nfse_chave: '',
    protocolo: '',
    attempt_count: 0,
    last_attempt_at: '',
    provider_error_codes: '',
    provider_message: '',
    error: ''
  };
}

async function updateNationalEntry(entry, fields, dependencies = {}) {
  const update = dependencies.updateSheetValues || updateSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tabName = getNationalLedgerTabName();

  const updated = { ...entry, ...fields };
  const row = [
    updated.environment,
    updated.request_id,
    updated.item_index,
    updated.dps_id,
    updated.dps_numero,
    updated.dps_serie,
    updated.status,
    updated.allocated_at,
    updated.submitted_at,
    updated.nfse_numero,
    updated.nfse_chave,
    updated.protocolo,
    String(updated.attempt_count ?? 0),
    updated.last_attempt_at,
    updated.provider_error_codes,
    updated.provider_message,
    updated.error
  ];

  if (entry.rowIndex) {
    await update(spreadsheetId, `${tabName}!A${entry.rowIndex}:Q${entry.rowIndex}`, [row]);
  }
  return updated;
}

async function markNationalSubmitting(entry, dependencies = {}) {
  const now = new Date().toISOString();
  return updateNationalEntry(entry, {
    status: NATIONAL_DPS_STATUS.SUBMITTING,
    submitted_at: now,
    last_attempt_at: now,
    attempt_count: (Number(entry.attempt_count) || 0) + 1
  }, dependencies);
}

async function markNationalIssued(entry, { nfseNumero, nfseChave, protocolo, xmlOficial }, dependencies = {}) {
  return updateNationalEntry(entry, {
    status: NATIONAL_DPS_STATUS.ISSUED,
    nfse_numero: String(nfseNumero || ''),
    nfse_chave: String(nfseChave || ''),
    protocolo: String(protocolo || ''),
    error: ''
  }, dependencies);
}

async function markNationalRejected(entry, { errorCodes, message }, dependencies = {}) {
  return updateNationalEntry(entry, {
    status: NATIONAL_DPS_STATUS.REJECTED_CORRECTABLE,
    provider_error_codes: String(errorCodes || ''),
    provider_message: String(message || ''),
    error: String(message || '')
  }, dependencies);
}

async function markNationalTimeout(entry, { error }, dependencies = {}) {
  return updateNationalEntry(entry, {
    status: NATIONAL_DPS_STATUS.UNKNOWN_AFTER_TIMEOUT,
    error: String(error || 'TIMEOUT')
  }, dependencies);
}

async function markNationalFailedSafe(entry, { error }, dependencies = {}) {
  return updateNationalEntry(entry, {
    status: NATIONAL_DPS_STATUS.FAILED_SAFE,
    error: String(error || 'FAILED_SAFE')
  }, dependencies);
}

module.exports = {
  NATIONAL_DPS_STATUS,
  NATIONAL_LEDGER_HEADERS,
  buildOfficialDpsId,
  ensureNationalLedgerSheet,
  loadNationalLedger,
  findNationalLedgerEntry,
  allocateDpsAtomically,
  markNationalSubmitting,
  markNationalIssued,
  markNationalRejected,
  markNationalTimeout,
  markNationalFailedSafe
};
