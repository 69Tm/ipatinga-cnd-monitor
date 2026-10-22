'use strict';

const DEXMED_NATIONAL_CUTOVER_DATE = '2026-10-21';

function localDateOnly(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
  }
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function routeProvider({ taxRegime, emissionDate, historicalRead = false }) {
  const regime = String(taxRegime || '').trim().toUpperCase();
  const date = localDateOnly(emissionDate);

  if (historicalRead) return { provider: 'LEGACY_ABRASF', mode: 'historical_read', writeAllowed: false };
  if (!date) return { provider: null, mode: 'blocked', writeAllowed: false, reason: 'EMISSION_DATE_REQUIRED' };
  
  if (regime === 'SIMPLES_NACIONAL' && date >= DEXMED_NATIONAL_CUTOVER_DATE) {
    return {
      provider: 'NATIONAL_ISSUER',
      mode: 'current_write',
      writeAllowed: true, // Writer nacional habilitado com transporte real HTTP/mTLS
      requiresNationalDps: true
    };
  }
  
  if (regime === 'SIMPLES_NACIONAL') {
    return { provider: 'LEGACY_ABRASF', mode: 'historical_write_window', writeAllowed: true };
  }
  
  return { provider: null, mode: 'blocked', writeAllowed: false, reason: 'TAX_REGIME_NOT_CONFIGURED' };
}

module.exports = { DEXMED_NATIONAL_CUTOVER_DATE, localDateOnly, routeProvider };
