'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { CONFIG, sanitize } = require('./config');
const { parseXml, getXmlValue, getXmlNode } = require('./xml');

/**
 * Envia uma requisição SOAP para o webservice da Prefeitura de Ipatinga
 */
async function callSoapOperation({
  environment = 'production',
  operation = 'ConsultarNfseFaixa',
  cabecMsg,
  dadosMsg,
  certData = null,
  timeoutMs = 30000
}) {
  const envConfig = CONFIG.ENDPOINTS[environment] || CONFIG.ENDPOINTS.production;
  const endpointUrl = envConfig.url;
  const namespace = envConfig.namespace;

  const soapEnvelope =
`<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:nfs="${namespace}">
  <soapenv:Header/>
  <soapenv:Body>
    <nfs:${operation}Request>
      <nfseCabecMsg><![CDATA[${cabecMsg}]]></nfseCabecMsg>
      <nfseDadosMsg><![CDATA[${dadosMsg}]]></nfseDadosMsg>
    </nfs:${operation}Request>
  </soapenv:Body>
</soapenv:Envelope>`;

  const parsedUrl = new URL(endpointUrl);
  const isHttps = parsedUrl.protocol === 'https:';

  const requestOptions = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (isHttps ? 443 : 80),
    path: parsedUrl.pathname + (parsedUrl.search || ''),
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(soapEnvelope, 'utf8'),
      'SOAPAction': `"nfs#${operation}"`,
      'User-Agent': 'DEXMED-NFSe-Client/1.0'
    },
    timeout: timeoutMs
  };

  // Se o certificado A1 estiver disponível para autenticação mTLS
  if (isHttps && certData && certData.pemCert && certData.pemKey) {
    requestOptions.cert = certData.pemCert;
    requestOptions.key = certData.pemKey;
    if (certData.pemCa) {
      requestOptions.ca = certData.pemCa;
    }
  }

  return new Promise((resolve, reject) => {
    const client = isHttps ? https : http;
    const req = client.request(requestOptions, (res) => {
      let data = '';
      res.setEncoding('utf8');

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          // Parse do Envelope SOAP
          const parsedSoap = parseXml(data);
          
          // Verifica se há SOAP Fault
          const fault = getXmlNode(parsedSoap, ['Fault', 'soap:Fault', 'soapenv:Fault']);
          if (fault) {
            const faultString = getXmlValue(fault, ['faultstring', 'faultcode']) || 'SOAP Fault desconhecido';
            return reject(new Error(`Erro SOAP da Prefeitura (${res.statusCode}): ${faultString}`));
          }

          // Extração do outputXML
          let outputXml = getXmlValue(parsedSoap, ['outputXML', 'outputXml', 'output']);
          
          if (!outputXml) {
            // Tenta localizar nós intermediários
            const body = getXmlNode(parsedSoap, ['Body', 'soap:Body', 'soapenv:Body']);
            if (body) {
              const respNode = getXmlNode(body, [`${operation}Response`, 'output', 'tns:output']);
              if (respNode) {
                outputXml = getXmlValue(respNode, ['outputXML', 'outputXml', 'output']) || JSON.stringify(respNode);
              }
            }
          }

          if (!outputXml) {
            // Se o retorno já for o próprio XML direto
            outputXml = data;
          }

          resolve({
            statusCode: res.statusCode,
            rawEnvelope: data,
            outputXml: outputXml.trim()
          });
        } catch (err) {
          reject(new Error('Falha ao processar resposta SOAP: ' + err.message));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout na comunicação com a Prefeitura de Ipatinga (${timeoutMs}ms)`));
    });

    req.on('error', (err) => {
      reject(new Error(`Erro de rede/TLS na conexão com a Prefeitura: ${sanitize(err.message)}`));
    });

    req.write(soapEnvelope);
    req.end();
  });
}

module.exports = {
  callSoapOperation
};
