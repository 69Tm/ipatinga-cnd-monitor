'use strict';

const { CONFIG } = require('./config');
const { buildCabecalho, buildConsultarNfseFaixaEnvio, parseConsultarNfseResposta } = require('./abrasf');
const { callSoapOperation } = require('./soap');
const { loadExistingNotas, upsertNotas } = require('./sheets');
const { onlyDigits } = require('./validators');

/**
 * Orquestra a sincronização de NFS-e (Full ou Incremental)
 */
async function syncNfse({
  mode = 'incremental',
  environment = 'production',
  fromNumber = null,
  toNumber = null,
  dryRun = false,
  certData = null
}) {
  const startTime = Date.now();
  const existing = await loadExistingNotas();

  // Descobre a maior nota conhecida na planilha
  let maxKnown = 0;
  for (const numStr of existing.byNumber.keys()) {
    const n = parseInt(onlyDigits(numStr), 10);
    if (!isNaN(n) && n > maxKnown) maxKnown = n;
  }

  const allApiNotas = new Map();
  const pagesConsulted = [];
  const errors = [];

  const BATCH_SIZE = 50;
  let startRange = 1;
  let endRange = 50;

  if (fromNumber && toNumber) {
    startRange = parseInt(fromNumber, 10);
    endRange = parseInt(toNumber, 10);
  } else if (mode === 'incremental' && maxKnown > 0) {
    // Sobreposição das últimas 10 notas para capturar cancelamentos/alterações
    startRange = Math.max(1, maxKnown - 10);
    endRange = maxKnown + 50;
  }

  let currentStart = startRange;
  let hasMore = true;
  let consecutiveEmptyBatches = 0;

  while (hasMore) {
    const currentEnd = Math.min(currentStart + BATCH_SIZE - 1, endRange || currentStart + BATCH_SIZE - 1);
    const pageNum = 1;

    const cabecMsg = buildCabecalho();
    const dadosMsg = buildConsultarNfseFaixaEnvio({
      from: currentStart,
      to: currentEnd,
      page: pageNum
    });

    try {
      const soapRes = await callSoapOperation({
        environment,
        operation: 'ConsultarNfseFaixa',
        cabecMsg,
        dadosMsg,
        certData
      });

      const parsed = parseConsultarNfseResposta(soapRes.outputXml);

      pagesConsulted.push({
        range: `${currentStart}-${currentEnd}`,
        statusCode: soapRes.statusCode,
        notasRetornadas: parsed.notas.length,
        mensagens: parsed.mensagens
      });

      if (parsed.notas.length > 0) {
        consecutiveEmptyBatches = 0;
        for (const n of parsed.notas) {
          allApiNotas.set(String(n.numero), n);
        }
      } else {
        consecutiveEmptyBatches++;
      }

      // Se atingiu o limite definido pelo usuário
      if (toNumber && currentEnd >= parseInt(toNumber, 10)) {
        hasMore = false;
        break;
      }

      // Se estamos em modo full ou incremental sem limite fixo
      if (!toNumber) {
        if (consecutiveEmptyBatches >= 2) {
          // Se após a maior nota conhecida não houver mais nenhuma nota em 2 lotes seguidos
          if (currentStart > maxKnown) {
            hasMore = false;
            break;
          }
        }
        // Se já consultamos muito além de qualquer nota razoável sem retorno
        if (currentStart > Math.max(maxKnown + 100, 200) && consecutiveEmptyBatches >= 2) {
          hasMore = false;
          break;
        }
      }

      currentStart += BATCH_SIZE;
      if (currentStart > 1000) {
        // Trava de segurança para não rodar infinito em caso anômalo
        hasMore = false;
      }
    } catch (err) {
      errors.push({
        range: `${currentStart}-${currentEnd}`,
        error: err.message
      });
      // Em caso de erro neste range, interrompe o avanço
      hasMore = false;
    }
  }

  const apiNotasList = Array.from(allApiNotas.values());
  apiNotasList.sort((a, b) => Number(a.numero) - Number(b.numero));

  // Executa UPSERT no Sheets
  const upsertResult = await upsertNotas(apiNotasList, null, dryRun);

  // Verificação de Regressão das Notas Conhecidas (10, 11, 13, 14, 15) e Nota 12
  const regressionCheck = {
    nota10: allApiNotas.has('10') ? allApiNotas.get('10') : (existing.byNumber.get('10') || null),
    nota11: allApiNotas.has('11') ? allApiNotas.get('11') : (existing.byNumber.get('11') || null),
    nota12: allApiNotas.has('12') ? allApiNotas.get('12') : (existing.byNumber.get('12') || 'Inexistente / Não retornada na API'),
    nota13: allApiNotas.has('13') ? allApiNotas.get('13') : (existing.byNumber.get('13') || null),
    nota14: allApiNotas.has('14') ? allApiNotas.get('14') : (existing.byNumber.get('14') || null),
    nota15: allApiNotas.has('15') ? allApiNotas.get('15') : (existing.byNumber.get('15') || null)
  };

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);

  return {
    operation: 'sync',
    environment,
    mode,
    dryRun,
    timestamp: new Date().toISOString(),
    durationSec: Number(durationSec),
    totalRetornadoApi: apiNotasList.length,
    primeiraNfEncontrada: apiNotasList.length > 0 ? apiNotasList[0].numero : null,
    ultimaNfEncontrada: apiNotasList.length > 0 ? apiNotasList[apiNotasList.length - 1].numero : null,
    upsertResult,
    regressionCheck,
    pagesConsulted,
    errors
  };
}

module.exports = {
  syncNfse
};
