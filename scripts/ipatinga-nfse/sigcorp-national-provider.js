'use strict';

const DEFAULT_BASE_URL = 'https://webservice.meumunicipio.online/v1/nfse';

function buildReceptionRequest({ dpsXml, nfseNumber, cnpj, username, password, baseUrl = DEFAULT_BASE_URL }) {
  if (!String(dpsXml || '').trim()) throw new Error('NATIONAL_DPS_XML_REQUIRED');
  if (!/^\d+$/.test(String(nfseNumber || ''))) throw new Error('NATIONAL_NFSE_NUMBER_REQUIRED');
  if (!/^\d{14}$/.test(String(cnpj || ''))) throw new Error('NATIONAL_PROVIDER_CNPJ_INVALID');
  if (!username || !password) throw new Error('NATIONAL_PROVIDER_CREDENTIALS_MISSING');

  const url = new URL(`${String(baseUrl).replace(/\/$/, '')}/recepcao`);
  if (url.protocol !== 'https:') throw new Error('NATIONAL_PROVIDER_HTTPS_REQUIRED');
  return {
    method: 'POST',
    url: url.toString(),
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`,
      'Content-Type': 'application/xml; charset=utf-8',
      'X-NFSe-Prestador-CNPJ': String(cnpj),
      'X-NFSe-nNFSe': String(nfseNumber)
    },
    body: String(dpsXml)
  };
}

function parseReceptionAcknowledgement({ statusCode, body }) {
  if (Number(statusCode) !== 202) {
    return { status: 'PROVIDER_RESPONSE_UNEXPECTED', protocol: '', providerWrites: 1 };
  }
  const text = String(body || '');
  let protocol = '';
  try {
    const parsed = JSON.parse(text);
    protocol = String(parsed.protocolo || parsed.protocol || '').trim();
  } catch (_) {
    const match = text.match(/<(?:\w+:)?(?:protocolo|protocol)\b[^>]*>([^<]+)<\//i);
    protocol = match ? match[1].trim() : '';
  }
  if (!protocol) return { status: 'SUBMITTED_ASYNC_PROCESSING', protocol: '', providerWrites: 1, reconciliationRequired: true };
  return { status: 'SUBMITTED_ASYNC_PROCESSING', protocol, providerWrites: 1, reconciliationRequired: true };
}

function buildReadOnlyConsultationUrl({ protocol, baseUrl = DEFAULT_BASE_URL }) {
  if (!String(protocol || '').trim()) throw new Error('NATIONAL_PROVIDER_PROTOCOL_REQUIRED');
  const url = new URL(`${String(baseUrl).replace(/\/$/, '')}/consulta/${encodeURIComponent(String(protocol).trim())}`);
  if (url.protocol !== 'https:') throw new Error('NATIONAL_PROVIDER_HTTPS_REQUIRED');
  return url.toString();
}

function createNationalNfseProvider({ baseUrl = DEFAULT_BASE_URL } = {}) {
  return Object.freeze({
    name: 'SIGCORP_NATIONAL_DPS',
    buildReceptionRequest: options => buildReceptionRequest({ ...options, baseUrl }),
    parseReceptionAcknowledgement,
    buildReadOnlyConsultationUrl: options => buildReadOnlyConsultationUrl({ ...options, baseUrl }),
    submit() {
      throw new Error('SIGCORP_PROVIDER_WRITE_NOT_VALIDATED: Ipatinga official instructions disagree on the active Simples Nacional path; no DPS was transmitted.');
    }
  });
}

module.exports = {
  DEFAULT_BASE_URL,
  buildReceptionRequest,
  parseReceptionAcknowledgement,
  buildReadOnlyConsultationUrl,
  createNationalNfseProvider
};
