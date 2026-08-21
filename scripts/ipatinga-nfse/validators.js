'use strict';

/**
 * Utilitários e validadores fiscais, contábeis e de strings
 */

function onlyDigits(str) {
  return String(str || '').replace(/\D/g, '');
}

function normalizeCnpj(cnpj) {
  const digits = onlyDigits(cnpj);
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
  return isNaN(num) ? 0 : num;
}

function formatCurrency(num) {
  const val = parseCurrency(num);
  return val.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseAliquot(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') {
    // Se for 0.02 -> 2.0 (ou se for 2.0 -> 2.0)
    return val < 1 && val > 0 ? val * 100 : val;
  }
  let str = String(val).replace(/%/g, '').trim();
  str = str.replace(',', '.');
  const num = parseFloat(str);
  if (isNaN(num)) return 0;
  return num < 1 && num > 0 ? num * 100 : num;
}

function formatAliquot(num) {
  const val = parseAliquot(num);
  return val.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + '%';
}

function parseIsoDate(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  const str = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) {
    const parts = str.split('/');
    const d = new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function formatDateBr(val) {
  const d = parseIsoDate(val);
  if (!d) return String(val || '');
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

function formatDateIso(val) {
  const d = parseIsoDate(val);
  if (!d) return '';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${year}-${month}-${day}`;
}

function formatDateTimeIso(val) {
  const d = parseIsoDate(val);
  if (!d) return '';
  return d.toISOString();
}

function parseCompetencia(val) {
  if (!val) return '';
  const str = String(val).trim();
  if (/^\d{2}\/\d{4}$/.test(str)) return str;
  if (/^\d{4}-\d{2}/.test(str)) {
    const parts = str.split('-');
    return `${parts[1]}/${parts[0]}`;
  }
  const d = parseIsoDate(str);
  if (d) {
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${month}/${year}`;
  }
  return str;
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
  formatDateTimeIso,
  parseCompetencia
};
