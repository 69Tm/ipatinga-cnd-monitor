'use strict';

/**
 * Utilitários e validadores fiscais, contábeis e de strings
 */

function onlyDigits(str) {
  return String(str || '').replace(/\D/g, '');
}

function normalizeCnpj(cnpj) {
  const digits = onlyDigits(cnpj);
  if (!digits) return '';
  return digits.padStart(14, '0');
}

function formatCnpj(cnpj) {
  const digits = normalizeCnpj(cnpj);
  if (digits.length !== 14) return cnpj;
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

function isValidCnpj(cnpj) {
  const clean = onlyDigits(cnpj);
  if (clean.length !== 14 || /^(\d)\1+$/.test(clean)) return false;

  let size = clean.length - 2;
  let numbers = clean.substring(0, size);
  const digits = clean.substring(size);
  let sum = 0;
  let pos = size - 7;

  for (let i = size; i >= 1; i--) {
    sum += Number(numbers.charAt(size - i)) * pos--;
    if (pos < 2) pos = 9;
  }

  let result = sum % 11 < 2 ? 0 : 11 - (sum % 11);
  if (result !== Number(digits.charAt(0))) return false;

  size = size + 1;
  numbers = clean.substring(0, size);
  sum = 0;
  pos = size - 7;

  for (let i = size; i >= 1; i--) {
    sum += Number(numbers.charAt(size - i)) * pos--;
    if (pos < 2) pos = 9;
  }

  result = sum % 11 < 2 ? 0 : 11 - (sum % 11);
  return result === Number(digits.charAt(1));
}

function parseCurrency(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  let str = String(val).trim().replace(/R\$\s*/i, '').replace(/\s/g, '');
  if (str.includes(',') && str.includes('.')) {
    // Ex: 12.925,00
    str = str.replace(/\./g, '').replace(',', '.');
  } else if (str.includes(',')) {
    // Ex: 12925,00
    str = str.replace(',', '.');
  }
  const num = parseFloat(str);
  return isNaN(num) ? 0 : Number(num.toFixed(2));
}

function formatCurrency(val) {
  const num = parseCurrency(val);
  return num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseAliquot(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') {
    if (val > 0 && val < 0.20) return Number((val * 100).toFixed(4));
    return isNaN(val) ? 0 : Number(val.toFixed(4));
  }
  let str = String(val).trim().replace(/%/g, '').replace(/\s/g, '');
  if (str.includes(',')) {
    str = str.replace(',', '.');
  }
  const num = parseFloat(str);
  if (isNaN(num)) return 0;
  if (num > 0 && num < 0.20 && !String(val).includes('%')) {
    return Number((num * 100).toFixed(4));
  }
  return Number(num.toFixed(4));
}

function formatAliquot(val) {
  const num = parseAliquot(val);
  return num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + '%';
}

function parseIsoDate(val) {
  if (!val) return null;
  if (val instanceof Date && !isNaN(val)) return val;
  const str = String(val).trim();
  // Formato ISO: YYYY-MM-DD
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T12:00:00Z`);
  }
  // Formato BR: DD/MM/YYYY
  const brMatch = str.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (brMatch) {
    return new Date(`${brMatch[3]}-${brMatch[2]}-${brMatch[1]}T12:00:00Z`);
  }
  const timestamp = Date.parse(str);
  return isNaN(timestamp) ? null : new Date(timestamp);
}

function formatDateBr(val) {
  const date = parseIsoDate(val);
  if (!date) return '';
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

function formatDateIso(val) {
  const date = parseIsoDate(val);
  if (!date) return '';
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${year}-${month}-${day}`;
}

function parseCompetencia(val) {
  if (!val) return '';
  const str = String(val).trim();
  // Se for MM/YYYY
  if (/^\d{2}\/\d{4}$/.test(str)) return str;
  // Se for YYYY-MM
  const ymMatch = str.match(/^(\d{4})-(\d{2})/);
  if (ymMatch) return `${ymMatch[2]}/${ymMatch[1]}`;
  // Se for ISO completo
  const date = parseIsoDate(str);
  if (date) {
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const year = date.getUTCFullYear();
    return `${month}/${year}`;
  }
  return str;
}

function sanitizeLog(text) {
  if (!text) return '';
  return String(text)
    .replace(/(password|senha|secret|token|client_secret)=([^&]+)/gi, '$1=***REDACTED***')
    .replace(/("password"|"senha"|"token"):\s*"[^"]+"/gi, '$1:"***REDACTED***"');
}

module.exports = {
  onlyDigits,
  normalizeCnpj,
  formatCnpj,
  isValidCnpj,
  parseCurrency,
  formatCurrency,
  parseAliquot,
  formatAliquot,
  parseIsoDate,
  formatDateBr,
  formatDateIso,
  parseCompetencia,
  sanitizeLog
};
