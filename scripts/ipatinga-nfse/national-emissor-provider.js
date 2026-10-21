'use strict';

const DEFAULT_BASE_URL = 'https://adn.nfse.gov.br/contribuintes';

function normalizeBaseUrl(value) {
  const parsed = new URL(String(value || DEFAULT_BASE_URL));
  if (parsed.protocol !== 'https:') throw new Error('NATIONAL_ISSUER_HTTPS_REQUIRED');
  return parsed.toString().replace(/\/$/, '');
}

function buildNationalSubmitRequest({ dpsXml, baseUrl = DEFAULT_BASE_URL }) {
  if (!String(dpsXml || '').trim()) throw new Error('NATIONAL_DPS_XML_REQUIRED');
  return {
    method: 'POST',
    url: `${normalizeBaseUrl(baseUrl)}/nfse`,
    headers: { Accept: 'application/xml', 'Content-Type': 'application/xml; charset=utf-8' },
    body: String(dpsXml),
    tls: { clientCertificateRequired: true, rejectUnauthorized: true }
  };
}

function buildNationalNfseReadRequest({ accessKey, baseUrl = DEFAULT_BASE_URL }) {
  if (!String(accessKey || '').trim()) throw new Error('NATIONAL_NFSE_ACCESS_KEY_REQUIRED');
  return {
    method: 'GET',
    url: `${normalizeBaseUrl(baseUrl)}/nfse/${encodeURIComponent(String(accessKey).trim())}`,
    headers: { Accept: 'application/xml' },
    tls: { clientCertificateRequired: true, rejectUnauthorized: true }
  };
}

function buildNationalDpsReadRequest({ dpsId, method = 'GET', baseUrl = DEFAULT_BASE_URL }) {
  if (!String(dpsId || '').trim()) throw new Error('NATIONAL_DPS_ID_REQUIRED');
  const verb = String(method || 'GET').toUpperCase();
  if (verb !== 'GET' && verb !== 'HEAD') throw new Error('NATIONAL_DPS_READ_METHOD_INVALID');
  return {
    method: verb,
    url: `${normalizeBaseUrl(baseUrl)}/dps/${encodeURIComponent(String(dpsId).trim())}`,
    headers: { Accept: 'application/xml' },
    tls: { clientCertificateRequired: true, rejectUnauthorized: true }
  };
}

function createNationalIssuerProvider({ baseUrl = DEFAULT_BASE_URL } = {}) {
  return Object.freeze({
    name: 'NATIONAL_ISSUER',
    buildSubmitRequest: options => buildNationalSubmitRequest({ ...options, baseUrl }),
    buildNfseReadRequest: options => buildNationalNfseReadRequest({ ...options, baseUrl }),
    buildDpsReadRequest: options => buildNationalDpsReadRequest({ ...options, baseUrl }),
    submit() {
      throw new Error('NATIONAL_ISSUER_WRITE_NOT_VALIDATED: current official enrollment, access and production API behavior are not verified; no DPS was transmitted.');
    }
  });
}

module.exports = {
  DEFAULT_BASE_URL,
  normalizeBaseUrl,
  buildNationalSubmitRequest,
  buildNationalNfseReadRequest,
  buildNationalDpsReadRequest,
  createNationalIssuerProvider
};
