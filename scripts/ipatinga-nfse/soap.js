'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { CONFIG, sanitize } = require('./config');
const { parseXml, findXmlNode, findXmlValue } = require('./xml');

function decodeXmlEntities(value) {
  return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function extractRawOutputText(data) {
  const envelope = String(data || '');
  const tags = ['outputXML', 'output'];
  for (const tag of tags) {
    const pattern = new RegExp(
      `<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}\\s*>`,
      'i'
    );
    const match = envelope.match(pattern);
    if (!match) continue;
    const rawValue = match[1];
    if (rawValue.startsWith('<![CDATA[') && rawValue.endsWith(']]>')) {
      return rawValue.slice(9, -3);
    }
    return decodeXmlEntities(rawValue);
  }
  return null;
}

function extractSoapOutput(data, operation) {
  const parsed = parseXml(data);
  const fault = findXmlNode(parsed, 'Fault');
  if (fault) {
    const code = findXmlValue(fault, 'faultcode') || 'SOAP_FAULT';
    const message = findXmlValue(fault, 'faultstring') || 'SOAP Fault sem mensagem';
    throw new Error(`SOAP_FAULT: ${code}: ${message}`);
  }
  // Extrai diretamente do envelope original para não normalizar espaços,
  // quebras de linha ou serialização do XML oficial.
  const rawOutput = extractRawOutputText(data);
  let output = rawOutput;
  if (!output) {
    output = findXmlValue(parsed, 'outputXML');
  }
  if (!output) {
    const response = findXmlNode(parsed, `${operation}Response`);
    output = findXmlValue(response, 'output') || findXmlValue(response, `${operation}Response`);
  }
  if (!output) throw new Error('SOAP_OUTPUT_MISSING: outputXML ausente.');
  if (rawOutput === null) output = decodeXmlEntities(output);
  parseXml(output);
  return output;
}

async function callSoapOperation({
  environment = 'production', operation = 'ConsultarNfseFaixa', cabecMsg,
  dadosMsg, certData = null, timeoutMs = 30000, transport = null
}) {
  const envConfig = CONFIG.ENDPOINTS[environment];
  if (!envConfig) throw new Error(`INVALID_ENVIRONMENT: ${environment}`);

  // Operações autorizadas no Web Service ABRASF 2.04 Ipatinga
  const allowedOperations = ['ConsultarNfseFaixa', 'ConsultarNfseServicoPrestado', 'ConsultarNfsePorRps', 'GerarNfse'];

  if (!allowedOperations.includes(operation)) {
    throw new Error(`SOAP_OPERATION_NOT_ALLOWED: Operacao ${operation} nao suportada.`);
  }

  // Kill switch operacional para operações de escrita (GerarNfse)
  if (operation === 'GerarNfse' && (process.env.NFE_ISSUE_KILL_SWITCH === 'true' || process.env.NFE_ISSUE_KILL_SWITCH === true)) {
    throw new Error('NFE_ISSUE_KILL_SWITCH_ACTIVE: Emissao bloqueada emergencialmente pelo kill switch.');
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
  const isHttps = parsedUrl.protocol === 'https:';
  const client = transport || (isHttps ? https : http);
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml;charset=utf-8',
      SOAPAction: `${namespace}#${operation}`,
      'Content-Length': Buffer.byteLength(soapEnvelope)
    },
    cert: certData.pemCert,
    key: certData.pemKey,
    // Validação estrita do certificado do servidor TLS (W3C / RFC 5280)
    rejectUnauthorized: true
  };

  return new Promise((resolve, reject) => {
    const req = client.request(envConfig.url, options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`SOAP_HTTP_ERROR_${res.statusCode}: ${sanitize(data.slice(0, 300))}`));
        }
        try {
          const outputXml = extractSoapOutput(data, operation);
          // outputXmlBytes é a representação UTF-8 exata do XML oficial
          // extraído do outputXML. Consumidores de documentos devem persistir
          // este buffer diretamente, sem parse/rebuild.
          resolve({
            statusCode: res.statusCode,
            outputXml,
            outputXmlBytes: Buffer.from(outputXml, 'utf8'),
            rawEnvelope: data
          });
        } catch (err) {
          reject(err);
        }
      });
    });

    if (typeof req.setTimeout === 'function') {
      req.setTimeout(timeoutMs, () => req.destroy(new Error('SOAP_TIMEOUT: Tempo limite esgotado')));
    }
    req.on('error', err => reject(new Error(`SOAP_TRANSPORT_ERROR: ${err.message}`)));
    req.write(soapEnvelope);
    req.end();
  });
}

module.exports = {
  extractSoapOutput,
  extractRawOutputText,
  callSoapOperation,
  decodeXmlEntities
};
