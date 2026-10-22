'use strict';

const https = require('https');
const { URL } = require('url');
const { XMLParser } = require('fast-xml-parser');
const { signXmlNode } = require('./xmldsig');

const DEFAULT_PRODUCTION_URL = 'https://adn.nfse.gov.br/contribuintes';
const DEFAULT_RESTRICTED_URL = 'https://adn.producaorestrita.nfse.gov.br/contribuintes';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false
});

function normalizeBaseUrl(value, environment = 'production') {
  if (!value) {
    return environment === 'production' ? DEFAULT_PRODUCTION_URL : DEFAULT_RESTRICTED_URL;
  }
  const parsed = new URL(String(value));
  if (parsed.protocol !== 'https:') throw new Error('NATIONAL_ISSUER_HTTPS_REQUIRED');
  return parsed.toString().replace(/\/$/, '');
}

/**
 * Constrói o XML da DPS Nacional conforme o padrão SEFIN / ADN
 */
function buildNationalDpsXml({
  dpsId,
  ambiente = 2, // 1 = Produção, 2 = Produção Restrita / Homologação
  emissao = new Date(),
  competencia = new Date(),
  prestador,
  tomador,
  servico,
  valores,
  regimeTributario = { opSimpNac: 1 },
  certData = null
}) {
  const idStr = String(dpsId || `DPS313130723297500${Date.now()}`);
  const dhEmi = (emissao instanceof Date ? emissao : new Date(emissao)).toISOString().slice(0, 19) + '-03:00';
  const dCompet = (competencia instanceof Date ? competencia : new Date(competencia)).toISOString().slice(0, 10);

  const prestCnpj = String(prestador?.cnpj || '31302407000105').replace(/\D/g, '');
  const prestIm = String(prestador?.inscricaoMunicipal || '23297500').trim();
  const prestMun = String(prestador?.codigoMunicipio || '3131307').trim();

  const tomaCnpj = String(tomador?.cnpj || '').replace(/\D/g, '');
  const tomaNome = String(tomador?.razaoSocial || '').trim();
  const tomaMun = String(tomador?.codigoMunicipio || '3128006').trim();
  const tomaCep = String(tomador?.cep || '39740000').replace(/\D/g, '');
  const tomaLogr = String(tomador?.logradouro || 'CAPITAO BERNARDO').trim();
  const tomaNro = String(tomador?.numero || '257').trim();
  const tomaBairro = String(tomador?.bairro || 'CENTRO').trim();
  const tomaUf = String(tomador?.uf || 'MG').trim();

  const locPrestMun = String(servico?.codigoMunicipioPrestacao || '3128006').trim();
  const cTribNac = String(servico?.codigoTributacaoNacional || '04.03.01').trim();
  const cTribMun = String(servico?.codigoTributacaoMunicipal || '403').trim();
  const xDescServ = String(servico?.discriminacao || 'Serviços médicos').trim();
  const cNbs = String(servico?.nbs || '123011900').replace(/\D/g, '');

  const vServ = Number(valores?.valorServico || 0).toFixed(2);
  const pAliq = valores?.aliquota ? Number(valores.aliquota).toFixed(2) : '0.00';
  const vIss = valores?.valorIss ? Number(valores.valorIss).toFixed(2) : '0.00';
  const issRetido = Number(valores?.issRetido || 2); // 1 = Sim, 2 = Não

  let xml = `<?xml version="1.0" encoding="utf-8"?>
<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">
  <infDPS Id="${idStr}">
    <tpAmb>${ambiente}</tpAmb>
    <dhEmi>${dhEmi}</dhEmi>
    <verAplic>DEXMED_FISCAL_1.0</verAplic>
    <dCompet>${dCompet}</dCompet>
    <prest>
      <CNPJ>${prestCnpj}</CNPJ>
      <IM>${prestIm}</IM>
      <cMun>${prestMun}</cMun>
    </prest>
    <toma>
      <CNPJ>${tomaCnpj}</CNPJ>
      <xNome>${tomaNome}</xNome>
      <ender>
        <endNac>
          <cMun>${tomaMun}</cMun>
          <CEP>${tomaCep}</CEP>
          <xLgr>${tomaLogr}</xLgr>
          <nro>${tomaNro}</nro>
          <xBairro>${tomaBairro}</xBairro>
          <UF>${tomaUf}</UF>
        </endNac>
      </ender>
    </toma>
    <serv>
      <locPrest>
        <cMun>${locPrestMun}</cMun>
      </locPrest>
      <cServ>
        <cTribNac>${cTribNac}</cTribNac>
        <cTribMun>${cTribMun}</cTribMun>
        <xDescServ>${xDescServ}</xDescServ>
        <cNBS>${cNbs}</cNBS>
      </cServ>
    </serv>
    <valores>
      <vServPrest>
        <vServ>${vServ}</vServ>
      </vServPrest>
      <trib>
        <tribMun>
          <tribISSQN>1</tribISSQN>
          <pAliq>${pAliq}</pAliq>
          <vISSQN>${vIss}</vISSQN>
          <tpRetISSQN>${issRetido}</tpRetISSQN>
        </tribMun>
      </trib>
    </valores>
    <regTrib>
      <opSimpNac>${regimeTributario.opSimpNac || 1}</opSimpNac>
    </regTrib>
  </infDPS>
</DPS>`.trim();

  if (certData && certData.pemKey && certData.pemCert) {
    try {
      xml = signXmlNode({
        xml,
        targetId: idStr,
        pemKey: certData.pemKey,
        pemCert: certData.pemCert
      });
    } catch (err) {
      // Se falhar a assinatura, mantém o xml gerado para fail-closed ou validação de erro
    }
  }

  return { dpsId: idStr, xml };
}

/**
 * Transporte HTTP/HTTPS real com suporte a mTLS e controle de versão TLS
 */
async function executeHttpRequest({
  method = 'GET',
  url,
  headers = {},
  body = null,
  certData = null,
  timeout = 30000
}) {
  const parsedUrl = new URL(url);
  const options = {
    protocol: parsedUrl.protocol,
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: method.toUpperCase(),
    headers: {
      'User-Agent': 'DEXMED-Fiscal-Engine/1.0',
      ...headers
    },
    timeout: timeout,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2'
  };

  if (certData) {
    if (certData.pemCert && certData.pemKey) {
      options.cert = certData.pemCert;
      options.key = certData.pemKey;
    } else if (certData.pfx) {
      options.pfx = certData.pfx;
      if (certData.passphrase) options.passphrase = certData.passphrase;
    }
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const rawBytes = Buffer.concat(chunks);
        const bodyStr = rawBytes.toString('utf-8');
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: bodyStr,
          rawBytes
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      const err = new Error(`HTTP_TIMEOUT: Requisição para ${parsedUrl.hostname} excedeu ${timeout}ms.`);
      err.code = 'ETIMEDOUT';
      reject(err);
    });

    req.on('error', err => {
      reject(err);
    });

    if (body) {
      req.write(typeof body === 'string' ? body : Buffer.from(body));
    }
    req.end();
  });
}

/**
 * Parsing da resposta síncrona de emissão da NFS-e Nacional
 */
function parseNationalSubmitResponse(responseBody, statusCode) {
  const text = String(responseBody || '').trim();
  if (!text) {
    return {
      status: 'EMPTY_RESPONSE',
      statusCode,
      success: false,
      error: 'RESPOSTA_VAZIA_DO_PROVEDOR'
    };
  }

  try {
    const parsed = xmlParser.parse(text);
    
    // 1. Caso de Sucesso: NFS-e emitida
    const nfseNode = parsed.NFSe || parsed.nfse || parsed.GerarNfseResposta?.ListaNfse?.CompNfse?.Nfse;
    if (nfseNode) {
      const infNfse = nfseNode.infNFSe || nfseNode.InfNfse || nfseNode;
      const chaveAcesso = String(infNfse.chNFSe || infNfse['@_Id'] || '').replace(/\D/g, '');
      const numero = String(infNfse.nNFSe || infNfse.numero || '').trim();
      const dhEmi = String(infNfse.dhEmi || infNfse.dataEmissao || '').trim();
      const nProt = String(infNfse.nProt || infNfse.protocolo || '').trim();

      return {
        status: 'ISSUED',
        success: true,
        statusCode,
        chaveAcesso,
        nfseNumero: numero,
        dhEmi,
        protocolo: nProt,
        xml: text
      };
    }

    // 2. Caso de Rejeição de Negócio / Erros Fiscais da SEFIN
    const errosNode = parsed.mensagens || parsed.erros || parsed.GerarNfseResposta?.ListaMensagemRetorno;
    if (errosNode) {
      const msgs = [];
      const list = Array.isArray(errosNode.mensagem) ? errosNode.mensagem : [errosNode.mensagem || errosNode];
      list.forEach(m => {
        if (m) {
          msgs.push({
            codigo: String(m.codigo || m.cMsg || m['@_codigo'] || '').trim(),
            mensagem: String(m.mensagem || m.xMsg || m['#text'] || '').trim()
          });
        }
      });

      return {
        status: 'REJECTED',
        success: false,
        statusCode,
        errors: msgs,
        xml: text
      };
    }

    // 3. Resposta em formato genérico ou JSON
    if (statusCode === 200 || statusCode === 201) {
      return {
        status: 'ISSUED_RAW',
        success: true,
        statusCode,
        xml: text
      };
    }

    return {
      status: 'PROVIDER_ERROR',
      success: false,
      statusCode,
      raw: text
    };
  } catch (err) {
    return {
      status: 'PARSE_ERROR',
      success: false,
      statusCode,
      error: err.message,
      raw: text
    };
  }
}

function buildNationalSubmitRequest({ dpsXml, baseUrl = DEFAULT_PRODUCTION_URL }) {
  if (!String(dpsXml || '').trim()) throw new Error('NATIONAL_DPS_XML_REQUIRED');
  return {
    method: 'POST',
    url: `${normalizeBaseUrl(baseUrl)}/nfse`,
    headers: { Accept: 'application/xml', 'Content-Type': 'application/xml; charset=utf-8' },
    body: String(dpsXml),
    tls: { clientCertificateRequired: true, rejectUnauthorized: true }
  };
}

function buildNationalNfseReadRequest({ accessKey, baseUrl = DEFAULT_PRODUCTION_URL }) {
  if (!String(accessKey || '').trim()) throw new Error('NATIONAL_NFSE_ACCESS_KEY_REQUIRED');
  return {
    method: 'GET',
    url: `${normalizeBaseUrl(baseUrl)}/nfse/${encodeURIComponent(String(accessKey).trim())}`,
    headers: { Accept: 'application/xml' },
    tls: { clientCertificateRequired: true, rejectUnauthorized: true }
  };
}

function buildNationalDpsReadRequest({ dpsId, method = 'GET', baseUrl = DEFAULT_PRODUCTION_URL }) {
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

/**
 * Cria o provider oficial do Emissor Nacional com transporte HTTP e mTLS
 */
function createNationalIssuerProvider({
  baseUrl = DEFAULT_PRODUCTION_URL,
  environment = 'production',
  transport = executeHttpRequest
} = {}) {
  const effectiveBaseUrl = normalizeBaseUrl(baseUrl, environment);

  return Object.freeze({
    name: 'NATIONAL_ISSUER',
    baseUrl: effectiveBaseUrl,
    environment,

    buildSubmitRequest: options => buildNationalSubmitRequest({ ...options, baseUrl: effectiveBaseUrl }),
    buildNfseReadRequest: options => buildNationalNfseReadRequest({ ...options, baseUrl: effectiveBaseUrl }),
    buildDpsReadRequest: options => buildNationalDpsReadRequest({ ...options, baseUrl: effectiveBaseUrl }),
    buildDpsXml: options => buildNationalDpsXml(options),

    /**
     * Submissão síncrona da DPS para geração da NFS-e Nacional
     */
    async submit({ dpsXml, dpsId, certData, dryRun = false, timeout = 30000 }) {
      if (!dpsXml || !String(dpsXml).trim()) throw new Error('NATIONAL_DPS_XML_REQUIRED');
      
      // Safety gate em produção: exige flag explícita caso não seja simulação/dryRun
      const isProduction = effectiveBaseUrl.includes('adn.nfse.gov.br') && !effectiveBaseUrl.includes('producaorestrita');
      if (isProduction && !dryRun && process.env.NATIONAL_PRODUCTION_WRITE_ENABLED !== 'true') {
        throw new Error('NATIONAL_PRODUCTION_WRITE_DISABLED: Emissão em produção bloqueada por trava de segurança.');
      }

      if (dryRun) {
        return {
          status: 'DRY_RUN_SUCCESS',
          environment,
          dpsId,
          gerarNfseCalls: 0,
          newDps: 0,
          newRps: 0,
          newNfse: 0,
          providerWrites: 0
        };
      }

      const reqOptions = buildNationalSubmitRequest({ dpsXml, baseUrl: effectiveBaseUrl });
      let httpRes;

      try {
        httpRes = await transport({
          method: reqOptions.method,
          url: reqOptions.url,
          headers: reqOptions.headers,
          body: reqOptions.body,
          certData,
          timeout
        });
      } catch (transportErr) {
        // EXACTLY-ONCE RECOVERY: Em caso de timeout após envio, consulta a DPS antes de falhar
        if (dpsId && (transportErr.code === 'ETIMEDOUT' || transportErr.message.includes('TIMEOUT'))) {
          try {
            const recoveryCheck = await this.headDps({ dpsId, certData });
            if (recoveryCheck.exists) {
              const dpsDetails = await this.getDps({ dpsId, certData });
              return {
                status: 'RECONCILED_AFTER_TIMEOUT',
                environment,
                dpsId,
                chaveAcesso: dpsDetails.chaveAcesso,
                nfseNumero: dpsDetails.nfseNumero,
                reconciled: true,
                newProviderWrites: 1
              };
            }
          } catch (_) {
            // Se a verificação também falhar, reporta timeout com instrução de reconciliação
          }
        }
        throw transportErr;
      }

      const parsed = parseNationalSubmitResponse(httpRes.body, httpRes.statusCode);
      if (parsed.status === 'ISSUED' || parsed.status === 'ISSUED_RAW') {
        return {
          status: 'ISSUED',
          environment,
          dpsId,
          chaveAcesso: parsed.chaveAcesso,
          nfseNumero: parsed.nfseNumero,
          protocolo: parsed.protocolo,
          dhEmi: parsed.dhEmi,
          xmlOficial: parsed.xml,
          statusCode: httpRes.statusCode,
          newProviderWrites: 1
        };
      }

      if (parsed.status === 'REJECTED') {
        return {
          status: 'REJECTED_FISCAL',
          environment,
          dpsId,
          errors: parsed.errors,
          statusCode: httpRes.statusCode,
          xml: parsed.xml,
          newProviderWrites: 1
        };
      }

      return {
        status: parsed.status || 'PROVIDER_ERROR',
        environment,
        dpsId,
        statusCode: httpRes.statusCode,
        raw: httpRes.body,
        newProviderWrites: 1
      };
    },

    /**
     * Consulta NFS-e existente por Chave de Acesso (50 dígitos)
     */
    async getNfse({ accessKey, certData, timeout = 15000 }) {
      const req = buildNationalNfseReadRequest({ accessKey, baseUrl: effectiveBaseUrl });
      const res = await transport({
        method: req.method,
        url: req.url,
        headers: req.headers,
        certData,
        timeout
      });

      if (res.statusCode === 200) {
        return {
          status: 'FOUND',
          accessKey,
          statusCode: 200,
          xml: res.body
        };
      }

      if (res.statusCode === 404) {
        return {
          status: 'NOT_FOUND',
          accessKey,
          statusCode: 404
        };
      }

      return {
        status: 'QUERY_ERROR',
        accessKey,
        statusCode: res.statusCode,
        body: res.body
      };
    },

    /**
     * Recupera chave e dados da NFS-e correspondente a uma DPS informada
     */
    async getDps({ dpsId, certData, timeout = 15000 }) {
      const req = buildNationalDpsReadRequest({ dpsId, method: 'GET', baseUrl: effectiveBaseUrl });
      const res = await transport({
        method: req.method,
        url: req.url,
        headers: req.headers,
        certData,
        timeout
      });

      if (res.statusCode === 200) {
        const parsed = parseNationalSubmitResponse(res.body, res.statusCode);
        return {
          status: 'FOUND',
          dpsId,
          chaveAcesso: parsed.chaveAcesso,
          nfseNumero: parsed.nfseNumero,
          xml: res.body,
          statusCode: 200
        };
      }

      if (res.statusCode === 404) {
        return { status: 'NOT_FOUND', dpsId, statusCode: 404 };
      }

      return { status: 'QUERY_ERROR', dpsId, statusCode: res.statusCode, body: res.body };
    },

    /**
     * Verifica de forma leve se a DPS já gerou NFS-e (HEAD /dps/{id})
     */
    async headDps({ dpsId, certData, timeout = 10000 }) {
      const req = buildNationalDpsReadRequest({ dpsId, method: 'HEAD', baseUrl: effectiveBaseUrl });
      const res = await transport({
        method: req.method,
        url: req.url,
        headers: req.headers,
        certData,
        timeout
      });

      return {
        exists: res.statusCode === 200,
        statusCode: res.statusCode,
        dpsId
      };
    }
  });
}

module.exports = {
  DEFAULT_PRODUCTION_URL,
  DEFAULT_RESTRICTED_URL,
  normalizeBaseUrl,
  buildNationalDpsXml,
  buildNationalSubmitRequest,
  buildNationalNfseReadRequest,
  buildNationalDpsReadRequest,
  parseNationalSubmitResponse,
  executeHttpRequest,
  createNationalIssuerProvider
};
