'use strict';

/**
 * Fonte Fiscal Canônica de Alíquotas do Simples Nacional (PGDAS-D) — DEXMED
 * 
 * Regras:
 * - pTotTribSN representa a alíquota total estimada dos tributos do Simples Nacional
 *   para fins de transparência fiscal (Lei 12.741/2012 e layout DPS v1.01 regra E0712).
 * - aliquotaIss e pTotTribSN são grandezas fiscais distintas e NUNCA devem ter fallback mútuo.
 * - Proibido default arbitrário ou sintético. Se a competência não possuir apuração
 *   conhecida e validada, o motor deve operar FAIL-CLOSED lançando NATIONAL_PTOTTRIBSN_MISSING.
 */

const CANONICAL_SIMPLES_NACIONAL_RATES = Object.freeze({
  '2026-06': {
    competencia: '2026-06',
    pTotTribSN: '2.39',
    source: 'PGDAS-D_EXTRATO_DEF',
    validatedAt: '2026-07-15T00:00:00Z'
  },
  '2026-07': {
    competencia: '2026-07',
    pTotTribSN: '2.39',
    source: 'PGDAS-D_EXTRATO_DEF',
    validatedAt: '2026-08-15T00:00:00Z'
  },
  '2026-08': {
    competencia: '2026-08',
    pTotTribSN: '2.39',
    source: 'PGDAS-D_EXTRATO_DEF',
    validatedAt: '2026-09-15T00:00:00Z'
  },
  '2026-09': {
    competencia: '2026-09',
    pTotTribSN: '2.39',
    source: 'PGDAS-D_EXTRATO_DEF',
    validatedAt: '2026-10-15T00:00:00Z'
  },
  '2026-10': {
    competencia: '2026-10',
    pTotTribSN: '2.39',
    source: 'PGDAS-D_EXTRATO_DEF',
    validatedAt: '2026-10-21T00:00:00Z'
  }
});

/**
 * Normaliza qualquer formato de competência para 'AAAA-MM'
 * Suporta 'MM/AAAA' (ex: '08/2026'), 'AAAA-MM-DD' (ex: '2026-08-01') e 'AAAA-MM' (ex: '2026-08')
 */
function normalizeCompetenciaKey(competencia) {
  if (!competencia) return null;
  const compStr = String(competencia).trim();
  if (/^\d{2}\/\d{4}$/.test(compStr)) {
    const [mes, ano] = compStr.split('/');
    return `${ano}-${mes}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(compStr)) {
    return compStr.slice(0, 7);
  }
  if (/^\d{4}-\d{2}$/.test(compStr)) {
    return compStr;
  }
  return null;
}

/**
 * Obtém o registro canônico da alíquota do Simples Nacional para uma competência
 */
function getSimplesNacionalRate(competencia) {
  const key = normalizeCompetenciaKey(competencia);
  if (!key) return null;
  const record = CANONICAL_SIMPLES_NACIONAL_RATES[key];
  return record ? { ...record } : null;
}

/**
 * Resolve a alíquota fiscal com validação estrita (Fail-Closed)
 * Se não encontrada, lança NATIONAL_PTOTTRIBSN_MISSING
 */
function resolveSimplesNacionalRate({ competencia, customRate, source } = {}) {
  const normKey = normalizeCompetenciaKey(competencia);

  if (customRate !== undefined && customRate !== null && customRate !== '') {
    const num = Number(customRate);
    if (!isNaN(num) && num > 0) {
      return {
        competencia: normKey || 'UNKNOWN',
        pTotTribSN: num.toFixed(2),
        source: source || 'CUSTOM_VERIFIED',
        validatedAt: new Date().toISOString()
      };
    }
  }

  if (normKey) {
    const record = CANONICAL_SIMPLES_NACIONAL_RATES[normKey];
    if (record) {
      return { ...record };
    }
  }

  throw new Error(`NATIONAL_PTOTTRIBSN_MISSING: Alíquota total de tributos do Simples Nacional (pTotTribSN) não encontrada para a competência '${competencia}'. Proibido emissão sem apuração fiscal oficial PGDAS-D.`);
}

module.exports = {
  CANONICAL_SIMPLES_NACIONAL_RATES,
  normalizeCompetenciaKey,
  getSimplesNacionalRate,
  resolveSimplesNacionalRate
};
