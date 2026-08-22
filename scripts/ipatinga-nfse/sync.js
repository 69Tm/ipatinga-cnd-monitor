'use strict';

const { buildCabecalho, buildConsultarNfseFaixaEnvio, parseConsultarNfseResposta } = require('./abrasf');
const { callSoapOperation } = require('./soap');
const { loadExistingNotas, upsertNotas } = require('./sheets');
const { onlyDigits } = require('./validators');
const { sanitize } = require('./config');

function positiveInteger(value, name, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`INVALID_SYNC_RANGE: ${name} deve ser um inteiro positivo.`);
  return parsed;
}

function buildSyncRanges({
  mode = 'incremental', maxKnown = 0, fromNumber = null, toNumber = null,
  batchSize = 50, overlap = 10, incrementalForward = 100, fullMaxNumber = 1000
} = {}) {
  if (!['full', 'incremental'].includes(mode)) throw new Error(`INVALID_SYNC_MODE: ${mode}`);
  const batch = positiveInteger(batchSize, 'batchSize');
  const known = Math.max(0, Number(maxKnown) || 0);
  const overlapSize = Math.max(0, Number(overlap) || 0);
  const forward = positiveInteger(incrementalForward, 'incrementalForward');
  const fullMax = positiveInteger(fullMaxNumber, 'fullMaxNumber');
  const requestedFrom = positiveInteger(fromNumber, 'from_number', null);
  const requestedTo = positiveInteger(toNumber, 'to_number', null);
  let start;
  let end;
  if (mode === 'full') {
    start = requestedFrom || 1;
    end = requestedTo || fullMax;
  } else {
    start = requestedFrom || (known > 0 ? Math.max(1, known - overlapSize + 1) : 1);
    end = requestedTo || Math.max(start, known + forward);
  }
  if (start > end) throw new Error(`INVALID_SYNC_RANGE: from_number (${start}) nao pode ser maior que to_number (${end}).`);
  const ranges = [];
  for (let from = start; from <= end; from += batch) ranges.push({ from, to: Math.min(from + batch - 1, end), page: 1 });
  return ranges;
}

function hasBusinessError(parsed) {
  const emptyCodes = new Set(['L000']);
  return (parsed.mensagens || []).some(message => {
    const code = String(message.codigo || '').toUpperCase();
    return code && !emptyCodes.has(code);
  });
}

async function syncNfse(options = {}, dependencies = {}) {
  const {
    mode = 'incremental', environment = 'production', fromNumber = null, toNumber = null,
    dryRun = false, certData = null, batchSize = process.env.NFE_SYNC_BATCH_SIZE || 50,
    overlap = process.env.NFE_SYNC_OVERLAP || 10, incrementalForward = process.env.NFE_SYNC_INCREMENTAL_FORWARD || 100,
    fullMaxNumber = process.env.NFE_SYNC_MAX_NUMBER || 1000
  } = options;
  const loadNotas = dependencies.loadExistingNotas || loadExistingNotas;
  const upsert = dependencies.upsertNotas || upsertNotas;
  const soapCall = dependencies.callSoapOperation || callSoapOperation;
  const parseResponse = dependencies.parseConsultarNfseResposta || parseConsultarNfseResposta;
  const startTime = Date.now();
  if (!certData || certData.loaded !== true || certData.isValid !== true) {
    throw new Error('CERTIFICATE_NOT_READY: sync autenticado exige certificado carregado e valido.');
  }
  const existing = await loadNotas();
  let maxKnown = 0;
  for (const numStr of existing.byNumber.keys()) {
    const number = Number.parseInt(onlyDigits(numStr), 10);
    if (Number.isSafeInteger(number) && number > maxKnown) maxKnown = number;
  }
  const ranges = buildSyncRanges({ mode, maxKnown, fromNumber, toNumber, batchSize, overlap, incrementalForward, fullMaxNumber });
  const allApiNotas = new Map();
  const completedRanges = [];
  for (const range of ranges) {
    try {
      const soapResult = await soapCall({
        environment, operation: 'ConsultarNfseFaixa', cabecMsg: buildCabecalho(),
        dadosMsg: buildConsultarNfseFaixaEnvio(range), certData
      });
      const parsed = parseResponse(soapResult.outputXml);
      if (!parsed || parsed.success !== true || !Array.isArray(parsed.notas) || !Array.isArray(parsed.mensagens)) {
        throw new Error('UNEXPECTED_ABRASF_RESPONSE: resposta sem estrutura reconhecida.');
      }
      if (hasBusinessError(parsed)) throw new Error(`ABRASF_BUSINESS_ERROR: ${JSON.stringify(sanitize(parsed.mensagens))}`);
      for (const note of parsed.notas) {
        if (!note || !note.numero) throw new Error('UNEXPECTED_ABRASF_RESPONSE: NFS-e sem numero.');
        const key = note.chaveAcesso || `${onlyDigits(note.cnpjTomador)}:${onlyDigits(note.numero)}`;
        allApiNotas.set(key, note);
      }
      completedRanges.push({ ...range, statusCode: soapResult.statusCode, total: parsed.notas.length });
    } catch (error) {
      const failure = new Error(`PARTIAL_SYNC_FAILED: faixa ${range.from}-${range.to}: ${sanitize(error.message)}`);
      failure.code = 'PARTIAL_SYNC_FAILED';
      failure.syncSummary = {
        operation: 'sync', status: 'PARTIAL_SYNC_FAILED', environment, mode, dryRun,
        timestamp: new Date().toISOString(), durationSec: Number(((Date.now() - startTime) / 1000).toFixed(2)),
        requestedRange: { from: fromNumber, to: toNumber }, actualRanges: ranges,
        completedRanges, totalApi: allApiNotas.size, totalNormalized: allApiNotas.size,
        upsertResult: null, warnings: [], errors: [sanitize(error.message)]
      };
      throw failure;
    }
  }
  const apiNotas = Array.from(allApiNotas.values()).sort((a, b) => Number(a.numero) - Number(b.numero));
  const upsertResult = await upsert(apiNotas, null, dryRun);
  return {
    operation: 'sync', status: dryRun ? 'DRY_RUN' : 'SUCCESS', environment, mode, dryRun,
    timestamp: new Date().toISOString(), durationSec: Number(((Date.now() - startTime) / 1000).toFixed(2)),
    requestedRange: { from: fromNumber, to: toNumber }, actualRanges: ranges,
    completedRanges, totalApi: apiNotas.length, totalNormalized: apiNotas.length,
    primeiraNfEncontrada: apiNotas[0]?.numero || null, ultimaNfEncontrada: apiNotas.at(-1)?.numero || null,
    upsertResult, errors: [], warnings: []
  };
}

module.exports = { buildSyncRanges, syncNfse, hasBusinessError };
