'use strict';

const { CONFIG } = require('./config');
const { readSheetValues, appendSheetValues, updateSheetValues, createSheetIfNotExists } = require('./google');

const CANONICAL_NATIONAL_LEDGER_TAB = 'Ledger NFS-e Nacional';

const NATIONAL_DPS_STATUS = Object.freeze({
  ALLOCATED: 'ALLOCATED',
  SUBMITTING: 'SUBMITTING',
  ISSUED: 'ISSUED',
  REJECTED_CORRECTABLE: 'REJECTED_CORRECTABLE',
  UNKNOWN_AFTER_TIMEOUT: 'UNKNOWN_AFTER_TIMEOUT',
  PROVIDER_INFRA_UNAVAILABLE: 'PROVIDER_INFRA_UNAVAILABLE',
  FAILED_SAFE: 'FAILED_SAFE'
});

/**
 * Schema canônico unificado de 27 colunas para o Ledger NFS-e Nacional
 */
const CANONICAL_NATIONAL_LEDGER_HEADERS = Object.freeze([
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
  'error',
  'document_model',
  'provider',
  'reference_period',
  'competencia_nfse',
  'emitted_at',
  'source_message_id',
  'source_sent_message_id',
  'official_pdf_drive_file_id',
  'official_pdf_sha256',
  'source_type'
]);

// Alias para compatibilidade com código existente
const NATIONAL_LEDGER_HEADERS = CANONICAL_NATIONAL_LEDGER_HEADERS;

const HEADER_ALIASES = Object.freeze({
  environment: ['environment', 'ambiente', 'env'],
  request_id: ['request_id', 'requestid', 'demanda', 'demanda_id', 'message_id', 'id_requisicao', 'requisicao'],
  item_index: ['item_index', 'item', 'index', 'item_idx', 'numero_item'],
  dps_id: ['dps_id', 'id_dps', 'dpsid'],
  dps_numero: ['dps_numero', 'numero_dps', 'num_dps', 'n_dps', 'dps_num'],
  dps_serie: ['dps_serie', 'serie_dps', 'serie'],
  status: ['status', 'situacao', 'estado'],
  allocated_at: ['allocated_at', 'alocado_em', 'data_alocacao'],
  submitted_at: ['submitted_at', 'submetido_em', 'data_submissao', 'enviado_em'],
  nfse_numero: ['nfse_numero', 'numero_nfse', 'num_nfse', 'nfse', 'numero_nota', 'nota_fiscal'],
  nfse_chave: ['nfse_chave', 'chave_nfse', 'chave_acesso', 'chave', 'chave_de_acesso'],
  protocolo: ['protocolo', 'protocolo_autorizacao', 'protocolo_envio'],
  attempt_count: ['attempt_count', 'tentativas', 'tentativa', 'num_tentativas'],
  last_attempt_at: ['last_attempt_at', 'ultima_tentativa', 'data_ultima_tentativa'],
  provider_error_codes: ['provider_error_codes', 'codigos_erro', 'codigo_erro', 'erro_provedor_codigos'],
  provider_message: ['provider_message', 'mensagem_provedor', 'mensagem', 'msg_provedor'],
  error: ['error', 'erro', 'ultimo_erro'],
  document_model: ['document_model', 'modelo_documento', 'modelo'],
  provider: ['provider', 'provedor'],
  reference_period: ['reference_period', 'periodo_referencia', 'periodo'],
  competencia_nfse: ['competencia_nfse', 'competencia'],
  emitted_at: ['emitted_at', 'emitido_em', 'data_emissao'],
  source_message_id: ['source_message_id', 'mensagem_origem_id', 'source_msg_id'],
  source_sent_message_id: ['source_sent_message_id', 'mensagem_envio_id'],
  official_pdf_drive_file_id: ['official_pdf_drive_file_id', 'pdf_file_id', 'drive_pdf_id'],
  official_pdf_sha256: ['official_pdf_sha256', 'pdf_sha256', 'hash_pdf'],
  source_type: ['source_type', 'tipo_origem', 'tipo_fonte']
});

function normalizeHeaderName(name) {
  if (!name) return '';
  return String(name)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function buildHeaderMapping(firstRow = []) {
  const map = {};
  firstRow.forEach((colName, idx) => {
    const norm = normalizeHeaderName(colName);
    for (const [canonicalField, aliases] of Object.entries(HEADER_ALIASES)) {
      if (norm === canonicalField || aliases.includes(norm)) {
        if (map[canonicalField] === undefined) {
          map[canonicalField] = idx;
        }
      }
    }
  });
  return map;
}

function buildRowFromEntry(entry, headerRow, headerMap) {
  const len = Math.max(headerRow.length, CANONICAL_NATIONAL_LEDGER_HEADERS.length);
  const row = new Array(len).fill('');

  CANONICAL_NATIONAL_LEDGER_HEADERS.forEach((key, defaultIdx) => {
    const colIdx = headerMap[key] !== undefined ? headerMap[key] : defaultIdx;
    if (colIdx >= 0) {
      let val = entry[key];
      if (val === undefined || val === null) val = '';
      row[colIdx] = String(val);
    }
  });

  return row;
}

/**
 * Constrói o ID oficial da DPS com 45 posições (DPS + 42 dígitos numéricos)
 * Regra: "DPS" + Cód.Mun (7) + Tipo Inscrição (1) + Inscrição Federal (14) + Série DPS (5) + Núm. DPS (15)
 */
function buildOfficialDpsId({ codMun, tipoInscricao, inscricaoFederal, serie = '1', numero }) {
  const cleanMun = String(codMun || '').replace(/\D/g, '');
  if (cleanMun.length !== 7) {
    throw new Error(`NATIONAL_DPS_ID_INVALID: Código do município deve ter exatamente 7 dígitos (recebido: '${codMun}').`);
  }
  const cleanDoc = String(inscricaoFederal || '').replace(/\D/g, '');
  if (cleanDoc.length !== 14 && cleanDoc.length !== 11) {
    throw new Error(`NATIONAL_DPS_ID_INVALID: Inscrição federal deve ter 14 dígitos (CNPJ) ou 11 dígitos (CPF) (recebido: '${inscricaoFederal}').`);
  }
  const munStr = cleanMun;
  // Regra Oficial NFS-e Nacional: 1 = CPF, 2 = CNPJ
  const defaultTipo = cleanDoc.length === 11 ? '1' : '2';
  const tipoStr = (tipoInscricao !== undefined && tipoInscricao !== null && String(tipoInscricao).trim())
    ? String(tipoInscricao).replace(/\D/g, '').slice(0, 1)
    : defaultTipo;
  const docStr = cleanDoc.padStart(14, '0');
  const serieStr = String(serie || '1').replace(/\D/g, '').padStart(5, '0');
  const numStr = String(numero || '1').replace(/\D/g, '').padStart(15, '0');

  const id = `DPS${munStr}${tipoStr}${docStr}${serieStr}${numStr}`;
  if (!/^DPS[0-9]{42}$/.test(id) || id.length !== 45) {
    throw new Error(`NATIONAL_DPS_ID_INVALID: Identificador gerado '${id}' não atende ao padrão TSIdDPS (45 caracteres, DPS + 42 dígitos).`);
  }
  return id;
}

function getNationalLedgerTabName(dependencies = {}) {
  const tab = dependencies.tabName || CONFIG.SHEETS.TABS.DPS;
  if (!tab || tab === 'DPS') {
    return CANONICAL_NATIONAL_LEDGER_TAB;
  }
  return tab;
}

async function ensureNationalLedgerSheet(dependencies = {}) {
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tabName = dependencies.tabName || getNationalLedgerTabName(dependencies);
  const createSheet = dependencies.createSheetIfNotExists || createSheetIfNotExists;
  const read = dependencies.readSheetValues || readSheetValues;
  const update = dependencies.updateSheetValues || updateSheetValues;

  // Proibição estrita de criar aba paralela 'DPS'
  if (dependencies.tabName && dependencies.tabName.trim().toUpperCase() === 'DPS') {
    throw new Error("CANONICAL_TAB_ERROR: Proibido utilizar aba 'DPS'. O ledger canônico deve ser estritamente 'Ledger NFS-e Nacional'.");
  }

  await createSheet(spreadsheetId, tabName);

  const existing = await read(spreadsheetId, `${tabName}!1:1`);
  if (!existing || existing.length === 0 || !existing[0] || existing[0].length === 0) {
    await update(spreadsheetId, `${tabName}!1:1`, [CANONICAL_NATIONAL_LEDGER_HEADERS]);
    return true;
  }

  const currentHeaders = existing[0];
  const missingHeaders = [];
  const normCurrent = currentHeaders.map(normalizeHeaderName);

  CANONICAL_NATIONAL_LEDGER_HEADERS.forEach(canonicalH => {
    const aliases = HEADER_ALIASES[canonicalH] || [canonicalH];
    const found = aliases.some(a => normCurrent.includes(a));
    if (!found) {
      missingHeaders.push(canonicalH);
    }
  });

  if (missingHeaders.length > 0) {
    const newHeaders = [...currentHeaders, ...missingHeaders];
    await update(spreadsheetId, `${tabName}!1:1`, [newHeaders]);
    return true;
  }

  return false;
}

async function loadNationalLedger(dependencies = {}) {
  const read = dependencies.readSheetValues || readSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tabName = getNationalLedgerTabName();

  const rows = await read(spreadsheetId, `${tabName}!A:AA`);
  if (!rows || rows.length <= 1) {
    return [];
  }

  const headerRow = rows[0] || [];
  const headerMap = buildHeaderMapping(headerRow);

  return rows.slice(1).map((row, idx) => {
    const getVal = (canonicalKey, fallbackIndex) => {
      const colIdx = headerMap[canonicalKey] !== undefined ? headerMap[canonicalKey] : fallbackIndex;
      return (colIdx >= 0 && colIdx < row.length) ? (row[colIdx] || '') : '';
    };

    return {
      rowIndex: idx + 2,
      environment: getVal('environment', 0),
      request_id: getVal('request_id', 1),
      item_index: getVal('item_index', 2) || '1',
      dps_id: getVal('dps_id', 3),
      dps_numero: getVal('dps_numero', 4),
      dps_serie: getVal('dps_serie', 5) || '1',
      status: getVal('status', 6) || NATIONAL_DPS_STATUS.ALLOCATED,
      allocated_at: getVal('allocated_at', 7),
      submitted_at: getVal('submitted_at', 8),
      nfse_numero: getVal('nfse_numero', 9),
      nfse_chave: getVal('nfse_chave', 10),
      protocolo: getVal('protocolo', 11),
      attempt_count: getVal('attempt_count', 12) ? Number(getVal('attempt_count', 12)) : 0,
      last_attempt_at: getVal('last_attempt_at', 13),
      provider_error_codes: getVal('provider_error_codes', 14),
      provider_message: getVal('provider_message', 15),
      error: getVal('error', 16),
      document_model: getVal('document_model', 17) || 'DPS',
      provider: getVal('provider', 18) || 'NATIONAL_ISSUER',
      reference_period: getVal('reference_period', 19),
      competencia_nfse: getVal('competencia_nfse', 20),
      emitted_at: getVal('emitted_at', 21),
      source_message_id: getVal('source_message_id', 22),
      source_sent_message_id: getVal('source_sent_message_id', 23),
      official_pdf_drive_file_id: getVal('official_pdf_drive_file_id', 24),
      official_pdf_sha256: getVal('official_pdf_sha256', 25),
      source_type: getVal('source_type', 26) || 'OFFICIAL'
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

/**
 * Alocação sequencial com proteção estrita do histórico de produção:
 * Se environment === 'production', o piso da série 1 é 26 (após NFS-e 25 e 26),
 * garantindo que a próxima emissão seja >= 27 e NUNCA DPS 1.
 */
function allocateNextDpsNumber(entries, environment, serie = '1', options = {}) {
  const normEnv = String(environment || '').trim().toLowerCase();
  const isProd = normEnv === 'production';

  let maxNum = (isProd && String(serie || '1') === '1') ? 26 : 0;

  for (const entry of entries) {
    const entryEnv = String(entry.environment || '').trim().toLowerCase();
    if (entryEnv === normEnv) {
      const nDps = parseInt(entry.dps_numero, 10);
      if (!isNaN(nDps) && nDps > maxNum) {
        maxNum = nDps;
      }
      const nNfse = parseInt(entry.nfse_numero, 10);
      if (!isNaN(nNfse) && nNfse > maxNum) {
        maxNum = nNfse;
      }
    }
  }

  if (options.minStartNumber && options.minStartNumber > maxNum) {
    maxNum = options.minStartNumber - 1;
  }

  const nextNumber = maxNum + 1;
  return {
    dpsNumero: String(nextNumber),
    dpsSerie: String(serie || '1')
  };
}

// Mutex in-process para serializar alocações concorrentes e evitar race conditions
const allocationLocks = new Map();

async function withAllocationLock(key, fn) {
  let currentLock = allocationLocks.get(key) || Promise.resolve();
  let release;
  const nextLock = new Promise(resolve => { release = resolve; });
  allocationLocks.set(key, currentLock.then(() => nextLock));
  try {
    await currentLock;
    return await fn();
  } finally {
    release();
    if (allocationLocks.get(key) === nextLock) {
      allocationLocks.delete(key);
    }
  }
}

async function findNextAvailableDpsNumber({
  entries,
  environment,
  serie = '1',
  codMun,
  tipoInscricao,
  inscricaoFederal,
  checkProviderHead = false,
  provider = null,
  certData = null
}) {
  let { dpsNumero, dpsSerie } = allocateNextDpsNumber(entries, environment, serie);

  if (checkProviderHead && provider && typeof provider.headDps === 'function') {
    let attempts = 0;
    while (attempts < 50) {
      const candidateId = buildOfficialDpsId({
        codMun,
        tipoInscricao,
        inscricaoFederal,
        serie: dpsSerie,
        numero: dpsNumero
      });
      try {
        const headRes = await provider.headDps({ dpsId: candidateId, certData });
        if (headRes && headRes.exists) {
          dpsNumero = String(parseInt(dpsNumero, 10) + 1);
          attempts++;
          continue;
        }
      } catch (headErr) {
        break;
      }
      break;
    }
  }

  return { dpsNumero, dpsSerie };
}

async function allocateDpsAtomically({
  environment,
  requestId,
  itemIndex = 1,
  serie = '1',
  checkProviderHead = false
}, dependencies = {}) {
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const lockKey = `${spreadsheetId}:${environment}:${serie}`;

  return await withAllocationLock(lockKey, async () => {
    const append = dependencies.appendSheetValues || appendSheetValues;
    const read = dependencies.readSheetValues || readSheetValues;
    const tabName = getNationalLedgerTabName();

    // Sempre relê o ledger atômico dentro da seção crítica
    const entries = await loadNationalLedger(dependencies);
    const existing = findNationalLedgerEntry(entries, { environment, requestId, itemIndex });
    if (existing) {
      return existing;
    }

    const codMun = CONFIG.PRESTADOR.CODIGO_MUNICIPIO_IPATINGA || '3131307';
    const inscricaoFederal = CONFIG.PRESTADOR.CNPJ_DIGITS || '31302407000105';
    const tipoInscricao = inscricaoFederal.length === 11 ? '1' : '2';

    const { dpsNumero, dpsSerie } = await findNextAvailableDpsNumber({
      entries,
      environment,
      serie,
      codMun,
      tipoInscricao,
      inscricaoFederal,
      checkProviderHead,
      provider: dependencies.provider,
      certData: dependencies.certData
    });

    const now = new Date().toISOString();
    const dpsId = buildOfficialDpsId({
      codMun,
      tipoInscricao,
      inscricaoFederal,
      serie: dpsSerie,
      numero: dpsNumero
    });

    const headerRead = await read(spreadsheetId, `${tabName}!1:1`);
    const headerRow = (headerRead && headerRead[0] && headerRead[0].length > 0) ? headerRead[0] : CANONICAL_NATIONAL_LEDGER_HEADERS;
    const headerMap = buildHeaderMapping(headerRow);

    const entryObj = {
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
      error: '',
      document_model: 'DPS',
      provider: 'NATIONAL_ISSUER',
      reference_period: dependencies.referencePeriod || '',
      competencia_nfse: dependencies.competenciaNfse || '',
      emitted_at: '',
      source_message_id: dependencies.sourceMessageId || requestId,
      source_sent_message_id: '',
      official_pdf_drive_file_id: '',
      official_pdf_sha256: '',
      source_type: 'OFFICIAL'
    };

    const row = buildRowFromEntry(entryObj, headerRow, headerMap);

    await append(spreadsheetId, `${tabName}!A:AA`, [row]);

    return entryObj;
  });
}

async function updateNationalEntry(entry, fields, dependencies = {}) {
  const update = dependencies.updateSheetValues || updateSheetValues;
  const read = dependencies.readSheetValues || readSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tabName = getNationalLedgerTabName();

  const updated = { ...entry, ...fields };

  if (entry.rowIndex) {
    const headerRead = await read(spreadsheetId, `${tabName}!1:1`);
    const headerRow = (headerRead && headerRead[0] && headerRead[0].length > 0) ? headerRead[0] : CANONICAL_NATIONAL_LEDGER_HEADERS;
    const headerMap = buildHeaderMapping(headerRow);
    const row = buildRowFromEntry(updated, headerRow, headerMap);
    await update(spreadsheetId, `${tabName}!A${entry.rowIndex}:AA${entry.rowIndex}`, [row]);
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

async function markNationalIssued(entry, { nfseNumero, nfseChave, protocolo, xmlOficial, emittedAt }, dependencies = {}) {
  const now = new Date().toISOString();
  return updateNationalEntry(entry, {
    status: NATIONAL_DPS_STATUS.ISSUED,
    nfse_numero: String(nfseNumero || ''),
    nfse_chave: String(nfseChave || ''),
    protocolo: String(protocolo || ''),
    emitted_at: emittedAt || now,
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
  CANONICAL_NATIONAL_LEDGER_TAB,
  CANONICAL_NATIONAL_LEDGER_HEADERS,
  NATIONAL_DPS_STATUS,
  NATIONAL_LEDGER_HEADERS,
  HEADER_ALIASES,
  normalizeHeaderName,
  buildHeaderMapping,
  buildRowFromEntry,
  buildOfficialDpsId,
  getNationalLedgerTabName,
  ensureNationalLedgerSheet,
  loadNationalLedger,
  findNationalLedgerEntry,
  allocateNextDpsNumber,
  allocateDpsAtomically,
  updateNationalEntry,
  markNationalSubmitting,
  markNationalIssued,
  markNationalRejected,
  markNationalTimeout,
  markNationalFailedSafe
};
