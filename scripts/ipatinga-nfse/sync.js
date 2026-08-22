'use strict';

const { buildCabecalho, buildConsultarNfseFaixaEnvio, parseConsultarNfseResposta } = require('./abrasf');
const { callSoapOperation } = require('./soap');
const { loadExistingNotas, upsertNotas } = require('./sheets');
const { onlyDigits } = require('./validators');
const { sanitize } = require('./config');

function positiveInteger(value, name, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`INVALID_SYNC_RANGE: ${name} deve ser um inteiro positivo.`);
  }
  return parsed;
}

/**
 * Constrói faixas finitas e inclusivas. Full sem limite é planejado
 * dinamicamente por syncNfse e encerra por blocos vazios consecutivos.
 */
function buildSyncRanges({
  mode = 'incremental',
  maxKnown = 0,
  fromNumber = null,
  toNumber = null,
  batchSize = 50,
  overlap = 10,
  incrementalForward = 100
} = {}) {
  if (!['full', 'incremental'].includes(mode)) throw new Error(`INVALID_SYNC_MODE: ${mode}`);
  const batch = positiveInteger(batchSize, 'batchSize');
  const known = Math.max(0, Number(maxKnown) || 0);
  const overlapSize = Math.max(0, Number(overlap) || 0);
  const forward = positiveInteger(incrementalForward, 'incrementalForward');
  const requestedFrom = positiveInteger(fromNumber, 'from_number', null);
  const requestedTo = positiveInteger(toNumber, 'to_number', null);
  let start;
  let end;

  if (mode === 'full') {
    if (!requestedTo) throw new Error('SYNC_RANGE_END_REQUIRED: full finito requer to_number.');
    start = requestedFrom || 1;
    end = requestedTo;
  } else {
    start = requestedFrom || (known > 0 ? Math.max(1, known - overlapSize + 1) : 1);
    end = requestedTo || Math.max(start, known + forward);
  }
  if (start > end) {
    throw new Error(`INVALID_SYNC_RANGE: from_number (${start}) nao pode ser maior que to_number (${end}).`);
  }
  const ranges = [];
  for (let from = start; from <= end; from += batch) {
    ranges.push({ from, to: Math.min(from + batch - 1, end), page: 1 });
  }
  return ranges;
}

function hasBusinessError(parsed) {
  const legitimateEmptyCodes = new Set(['L000', 'E212']);
  return (parsed.mensagens || []).some(message => {
    const code = String(message.codigo || '').toUpperCase();
    return code && !legitimateEmptyCodes.has(code);
  });
}

function maxKnownNumber(existing) {
  let maxKnown = 0;
  for (const numStr of existing.byNumber.keys()) {
    const number = Number.parseInt(onlyDigits(numStr), 10);
    if (Number.isSafeInteger(number) && number > maxKnown) maxKnown = number;
  }
  return maxKnown;
}

function buildNoteAudit(notes) {
  return notes.map(note => ({
    numero: note.numero,
    status: note.status,
    competencia: note.competencia,
    dataEmissao: note.dataEmissao,
    tomador: note.tomador,
    cnpjTomador: note.cnpjTomador,
    valorServicos: note.valorServicos,
    codigoTribNacional: note.codigoTribNacional,
    codigoTribMunicipal: note.codigoTribMunicipal,
    localPrestacao: note.localPrestacao,
    codigoMunicipioPrestacao: note.codigoMunicipioPrestacao,
    municipioIncidencia: note.municipioIncidencia,
    aliquota: note.aliquota,
    codigoVerificacao: note.codigoVerificacao,
    situacaoDetalhe: note.situacaoDetalhe
  }));
}

async function syncNfse(options = {}, dependencies = {}) {
  const {
    mode = 'incremental',
    environment = 'production',
    fromNumber = null,
    toNumber = null,
    dryRun = false,
    certData = null,
    batchSize = process.env.NFE_SYNC_BATCH_SIZE || 50,
    overlap = process.env.NFE_SYNC_OVERLAP || 10,
    incrementalForward = process.env.NFE_SYNC_INCREMENTAL_FORWARD || 100,
    emptyRangesToStop = process.env.NFE_SYNC_EMPTY_RANGES_TO_STOP || 10
  } = options;
  const loadNotas = dependencies.loadExistingNotas || loadExistingNotas;
  const upsert = dependencies.upsertNotas || upsertNotas;
  const soapCall = dependencies.callSoapOperation || callSoapOperation;
  const parseResponse = dependencies.parseConsultarNfseResposta || parseConsultarNfseResposta;
  const startTime = Date.now();
  const batch = positiveInteger(batchSize, 'batchSize');
  const emptyLimit = positiveInteger(emptyRangesToStop, 'emptyRangesToStop');

  if (!certData || certData.loaded !== true || certData.isValid !== true) {
    throw new Error('CERTIFICATE_NOT_READY: sync autenticado exige certificado carregado e valido.');
  }

  const existing = await loadNotas();
  const maxKnown = maxKnownNumber(existing);
  const boundedRanges = mode === 'incremental' || toNumber
    ? buildSyncRanges({ mode, maxKnown, fromNumber, toNumber, batchSize: batch, overlap, incrementalForward })
    : null;
  const actualRanges = [];
  const completedRanges = [];
  const allApiNotas = new Map();
  let highestObserved = maxKnown;
  let consecutiveEmptyAfterHighest = 0;
  let dynamicFrom = positiveInteger(fromNumber, 'from_number', 1);
  let rangeIndex = 0;
  let terminationReason = boundedRanges ? 'BOUNDED_RANGE_COMPLETED' : null;

  while (true) {
    let range;
    if (boundedRanges) {
      if (rangeIndex >= boundedRanges.length) break;
      range = boundedRanges[rangeIndex++];
    } else {
      range = { from: dynamicFrom, to: dynamicFrom + batch - 1, page: 1 };
      dynamicFrom = range.to + 1;
    }
    actualRanges.push(range);

    try {
      const soapResult = await soapCall({
        environment,
        operation: 'ConsultarNfseFaixa',
        cabecMsg: buildCabecalho(),
        dadosMsg: buildConsultarNfseFaixaEnvio(range),
        certData
      });
      const parsed = parseResponse(soapResult.outputXml);
      if (!parsed || !Array.isArray(parsed.notas) || !Array.isArray(parsed.mensagens)) {
        throw new Error('UNEXPECTED_ABRASF_RESPONSE: resposta sem estrutura reconhecida.');
      }
      if (hasBusinessError(parsed)) {
        throw new Error(`ABRASF_BUSINESS_ERROR: ${JSON.stringify(sanitize(parsed.mensagens))}`);
      }
      if (parsed.success !== true) {
        throw new Error('UNEXPECTED_ABRASF_RESPONSE: resposta ABRASF sem sucesso e sem mensagem reconhecida.');
      }

      for (const note of parsed.notas) {
        if (!note || !note.numero) throw new Error('UNEXPECTED_ABRASF_RESPONSE: NFS-e sem numero.');
        const number = Number.parseInt(onlyDigits(note.numero), 10);
        if (Number.isSafeInteger(number)) highestObserved = Math.max(highestObserved, number);
        const key = note.chaveAcesso || `${onlyDigits(note.cnpjTomador)}:${onlyDigits(note.numero)}`;
        allApiNotas.set(key, note);
      }
      completedRanges.push({ ...range, statusCode: soapResult.statusCode, total: parsed.notas.length });

      if (!boundedRanges) {
        if (parsed.notas.length === 0 && range.from > highestObserved) {
          consecutiveEmptyAfterHighest++;
        } else {
          consecutiveEmptyAfterHighest = 0;
        }
        if (consecutiveEmptyAfterHighest >= emptyLimit) {
          terminationReason = `EMPTY_RANGES_AFTER_HIGHEST_${emptyLimit}`;
          break;
        }
      }
    } catch (error) {
      const failure = new Error(`PARTIAL_SYNC_FAILED: faixa ${range.from}-${range.to}: ${sanitize(error.message)}`);
      failure.code = 'PARTIAL_SYNC_FAILED';
      failure.syncSummary = {
        operation: 'sync',
        status: 'PARTIAL_SYNC_FAILED',
        environment,
        mode,
        dryRun,
        timestamp: new Date().toISOString(),
        durationSec: Number(((Date.now() - startTime) / 1000).toFixed(2)),
        requestedRange: { from: fromNumber, to: toNumber },
        actualRanges,
        completedRanges,
        highestObserved,
        totalApi: allApiNotas.size,
        totalNormalized: allApiNotas.size,
        upsertResult: null,
        warnings: [],
        errors: [sanitize(error.message)]
      };
      throw failure;
    }
  }

  const apiNotas = Array.from(allApiNotas.values()).sort((a, b) => Number(a.numero) - Number(b.numero));
  const upsertResult = await upsert(apiNotas, null, dryRun);
  return {
    operation: 'sync',
    status: dryRun ? 'DRY_RUN' : 'SUCCESS',
    environment,
    mode,
    dryRun,
    timestamp: new Date().toISOString(),
    durationSec: Number(((Date.now() - startTime) / 1000).toFixed(2)),
    requestedRange: { from: fromNumber, to: toNumber },
    terminationReason,
    emptyRangesToStop: boundedRanges ? null : emptyLimit,
    highestObserved,
    actualRanges,
    completedRanges,
    totalApi: apiNotas.length,
    totalNormalized: apiNotas.length,
    primeiraNfEncontrada: apiNotas[0]?.numero || null,
    ultimaNfEncontrada: apiNotas.at(-1)?.numero || null,
    noteAudit: buildNoteAudit(apiNotas),
    upsertResult,
    errors: [],
    warnings: []
  };
}

module.exports = { buildSyncRanges, syncNfse, hasBusinessError, maxKnownNumber, buildNoteAudit };
