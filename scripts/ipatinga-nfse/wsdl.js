'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { sanitize } = require('./config');

const REQUIRED_OPERATION = 'ConsultarNfseFaixa';

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function parseWsdlContract(xml) {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new Error(`WSDL_INVALID_XML: ${validation.err.msg}`);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, processEntities: false });
  const parsed = parser.parse(xml);
  const definitions = parsed.definitions;
  if (!definitions) throw new Error('WSDL_DEFINITIONS_MISSING');
  const schemas = asArray(definitions.types?.schema);
  const elements = schemas.flatMap(schema => asArray(schema.element));
  const request = elements.find(element => element['@_name'] === `${REQUIRED_OPERATION}Request`);
  const requestFields = asArray(request?.complexType?.sequence?.element).map(element => element['@_name']);
  const bindings = asArray(definitions.binding);
  const binding = bindings.find(item => asArray(item.operation).some(op => op['@_name'] === REQUIRED_OPERATION));
  const bindingOperation = asArray(binding?.operation).find(op => op['@_name'] === REQUIRED_OPERATION);
  const service = asArray(definitions.service)[0];
  const port = asArray(service?.port)[0];
  const address = port?.address?.['@_location'];
  const contract = {
    targetNamespace: definitions['@_targetNamespace'],
    service: service?.['@_name'] || null,
    port: port?.['@_name'] || null,
    binding: binding?.['@_name'] || null,
    operation: bindingOperation?.['@_name'] || null,
    soapAction: bindingOperation?.operation?.['@_soapAction'] || null,
    requestWrapper: request?.['@_name'] || null,
    requestFields,
    endpoint: address || null
  };
  const expectedFields = ['nfseCabecMsg', 'nfseDadosMsg'];
  const valid = Boolean(
    contract.targetNamespace && contract.service && contract.port && contract.binding &&
    contract.operation === REQUIRED_OPERATION && contract.soapAction === 'nfs#ConsultarNfseFaixa' &&
    contract.requestWrapper === 'ConsultarNfseFaixaRequest' &&
    expectedFields.every(field => contract.requestFields.includes(field)) && contract.endpoint
  );
  if (!valid) throw new Error(`WSDL_CONTRACT_MISMATCH: ${JSON.stringify(contract)}`);
  return contract;
}

function fetchText(url, timeoutMs = 30000, redirects = 3) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(parsed, {
      timeout: timeoutMs,
      family: 4,
      headers: { Accept: 'application/wsdl+xml, application/xml, text/xml', 'User-Agent': 'DEXMED-NFSe-Preflight/1.1' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, parsed).toString(), timeoutMs, redirects - 1));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`WSDL_HTTP_ERROR: HTTP ${res.statusCode}`));
        resolve({ body, statusCode: res.statusCode, latencyMs: Date.now() - started });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`WSDL_TIMEOUT: ${timeoutMs}ms`)));
    req.on('error', error => reject(new Error(`WSDL_NETWORK_ERROR: ${sanitize(error.message)}`)));
  });
}

async function inspectWsdl(url, timeoutMs = 30000, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchText(url, timeoutMs);
      return { accessible: true, url, statusCode: response.statusCode, latencyMs: response.latencyMs, attempt, contract: parseWsdlContract(response.body) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

module.exports = { REQUIRED_OPERATION, parseWsdlContract, fetchText, inspectWsdl };
