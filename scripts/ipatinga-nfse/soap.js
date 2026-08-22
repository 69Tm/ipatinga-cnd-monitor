'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { CONFIG, sanitize } = require('./config');
const { parseXml, findXmlNode, findXmlValue } = require('./xml');

function decodeXmlEntities(value) {
  return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function extractSoapOutput(data, operation) {
  const parsed = parseXml(data);
  const fault = findXmlNode(parsed, 'Fault');
  if (fault) {
    const code = findXmlValue(fault, 'faultcode') || 'SOAP_FAULT';
    const message = findXmlValue(fault, 'faultstring') || 'SOAP Fault sem mensagem';
    throw new Error(`SOAP_FAULT: ${code}: ${message}`);
  }
  let output = findXmlValue(parsed, 'outputXML');
  if (!output) {
    const response = findXmlNode(parsed, `${operation}Response`);
    output = findXmlValue(response, 'output') || findXmlValue(response, `${operation}Response`);
  }
  if (!output) throw new Error('SOAP_OUTPUT_MISSING: outputXML ausente.');
  output = decodeXmlEntities(output).trim();
  parseXml(output);
  return output;
}

async function callSoapOperation({
  environment = 'production', operation = 'ConsultarNfseFaixa', cabecMsg,
  dadosMsg, certData = null, timeoutMs = 30000, transport = null
}) {
  const envConfig = CONFIG.ENDPOINTS[environment];
  if (!envConfig) throw new Error(`INVALID_ENVIRONMENT: ${environment}`);

  // Regras de segurança de operações permitidas
  const allowedInProduction = ['ConsultarNfseFaixa', 'ConsultarNfseServicoPrestado', 'ConsultarNfsePorRps'];
  const allowedInHomologation = ['ConsultarNfseFaixa', 'ConsultarNfseServicoPrestado', 'ConsultarNfsePorRps', 'GerarNfse'];

  if (environment === 'production' && !allowedInProduction.includes(operation)) {
    throw new Error(`SOAP_OPERATION_NOT_ALLOWED: ${operation} em producao.`);
  }
  if (environment === 'homologation' && !allowedInHomologation.includes(operation)) {
    throw new Error(`SOAP_OPERATION_NOT_ALLOWED: ${operation} em homologacao.`);
  }

  if (!certData || certData.loaded !== true || certData.isValid !== true || !certData.pemCert || !certData.pemKey) {
    throw new Error('CERTIFICATE_NOT_READY: SOAP autenticado exige certificado valido.');
  }
  const namespace = envConfig.namespace;
  const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:nfs="${namespace}">
  <soapenv:Header/>
  <soapenv:Body>
    <nfs:${operation}Request>
      <nfseCabecMsg><![CDATA[${cabecMsg}]]></nfseCabecMsg>
      <nfseDadosMsg><![CDATA[${dadosMsg}]]></nfseDadosMsg>
    </nfs:${operation}Request>
  </soapenv:Body>
</soapenv:Envelope>`;
  const parsedUrl = new URL(envConfig.url);
  const requestOptions = {
    hostname: parsedUrl.hostname, port: parsedUrl.port || 443,
    path: parsedUrl.pathname + parsedUrl.search, method: 'POST', timeout: timeoutMs,
    headers: {
      'Content-Type': 'text/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(soapEnvelope),
      SOAPAction: `"nfs#${operation}"`, 'User-Agent': 'DEXMED-NFSe-Client/1.1'
    },
    cert: certData.pemCert, key: certData.pemKey,
    ...(certData.pemCa ? { ca: certData.pemCa } : {})
  };
  const requestClient = transport || (parsedUrl.protocol === 'https:' ? https : http);
  return new Promise((resolve, reject) => {
    const req = requestClient.request(requestOptions, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            throw new Error(`SOAP_HTTP_ERROR: HTTP ${res.statusCode}: ${sanitize(data.slice(0, 500))}`);
          }
          resolve({ statusCode: res.statusCode, outputXml: extractSoapOutput(data, operation) });
        } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`SOAP_TIMEOUT: ${timeoutMs}ms`)));
    req.on('error', error => reject(new Error(`SOAP_TRANSPORT_ERROR: ${sanitize(error.message)}`)));
    req.write(soapEnvelope);
    req.end();
  });
}

module.exports = { callSoapOperation, extractSoapOutput, decodeXmlEntities };
