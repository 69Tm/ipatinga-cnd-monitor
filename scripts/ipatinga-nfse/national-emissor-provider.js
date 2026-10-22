'use strict';

const https = require('https');
const { URL } = require('url');
const { XMLParser } = require('fast-xml-parser');
const { signXmlNode, verifyXmlSignature } = require('./xmldsig');
const { validateNationalDpsAgainstOfficialXsd } = require('./xsd-validator');
const { buildOfficialDpsId } = require('./national-ledger');
const { CONFIG } = require('./config');

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

/**
 * Formata data e hora para America/Sao_Paulo com offset -03:00 de forma timezone-safe
 */
function formatDateTimeSaoPaulo(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(d).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}-03:00`;
}

/**
 * Normaliza a Base URL removendo trailing slashes
 */
function normalizeBaseUrl(baseUrl, environment = 'production') {
  let candidate = '';
  if (baseUrl) {
    candidate = String(baseUrl).trim().replace(/\/+$/, '');
  } else {
    const normEnv = String(environment || '').toLowerCase();
    candidate = (normEnv === 'homologation' || normEnv === 'restricted')
      ? DEFAULT_RESTRICTED_URL
      : DEFAULT_PRODUCTION_URL;
  }
  if (!candidate.startsWith('https://')) {
    throw new Error('HTTPS_REQUIRED: Endpoints da NFS-e Nacional exigem HTTPS.');
  }
  return candidate;
}

/**
 * Escapa caracteres XML
 */
function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Constrói o XML oficial da DPS Nacional (leiaute v1.01) com validação estrita dos dados
 * Lança erro explícito NATIONAL_DPS_DATA_INCOMPLETE se faltar qualquer campo obrigatório.
 */
function buildNationalDpsXml({
  dpsNumero,
  dpsSerie = '1',
  ambiente = 2, // 1 = Produção, 2 = Homologação / Produção Restrita
  emissao = new Date(),
  competenciaData,
  prestador,
  tomador,
  servico,
  valores,
  certData = null
}) {
  // Validações estritas de dados obrigatórios — FAIL-CLOSED
  if (!dpsNumero) {
    throw new Error('NATIONAL_DPS_DATA_INCOMPLETE: dpsNumero é obrigatório.');
  }

  if (!prestador || !prestador.cnpj) {
    throw new Error('NATIONAL_DPS_DATA_INCOMPLETE: prestador.cnpj é obrigatório.');
  }
  const prestCnpj = String(prestador.cnpj).replace(/\D/g, '');
  if (prestCnpj.length !== 14) {
    throw new Error(`NATIONAL_DPS_DATA_INCOMPLETE: prestador.cnpj inválido (${prestCnpj}).`);
  }
  const prestMun = String(prestador.codigoMunicipio || CONFIG.PRESTADOR.CODIGO_MUNICIPIO_IPATINGA || '').replace(/\D/g, '');
  if (prestMun.length !== 7) {
    throw new Error(`NATIONAL_DPS_DATA_INCOMPLETE: prestador.codigoMunicipio deve ter 7 dígitos (${prestMun}).`);
  }
  const prestIm = String(prestador.inscricaoMunicipal || CONFIG.PRESTADOR.INSCRICAO_MUNICIPAL || '').trim();
  const prestNome = String(prestador.razaoSocial || CONFIG.PRESTADOR.RAZAO_SOCIAL || '').trim();

  if (!tomador || !tomador.cnpj) {
    throw new Error('NATIONAL_DPS_DATA_INCOMPLETE: tomador.cnpj é obrigatório.');
  }
  const tomaCnpj = String(tomador.cnpj).replace(/\D/g, '');
  if (tomaCnpj.length !== 14 && tomaCnpj.length !== 11) {
    throw new Error(`NATIONAL_DPS_DATA_INCOMPLETE: tomador.cnpj/cpf inválido (${tomaCnpj}).`);
  }
  const tomaNome = String(tomador.razaoSocial || '').trim();
  if (!tomaNome) {
    throw new Error('NATIONAL_DPS_DATA_INCOMPLETE: tomador.razaoSocial é obrigatório.');
  }

  const tomaLogr = String(tomador.logradouro || '').trim();
  const tomaNro = String(tomador.numero || '').trim();
  const tomaBairro = String(tomador.bairro || '').trim();
  const tomaMun = String(tomador.codigoMunicipio || '').replace(/\D/g, '');
  const tomaCep = String(tomador.cep || '').replace(/\D/g, '');

  if (!tomaLogr || !tomaNro || !tomaBairro || tomaMun.length !== 7 || tomaCep.length !== 8) {
    throw new Error(`NATIONAL_DPS_DATA_INCOMPLETE: Dados de endereço do tomador incompletos (logradouro='${tomaLogr}', numero='${tomaNro}', bairro='${tomaBairro}', cMun='${tomaMun}', cep='${tomaCep}').`);
  }

  if (!servico) {
    throw new Error('NATIONAL_DPS_DATA_INCOMPLETE: Grupo servico é obrigatório.');
  }
  const locPrestMun = String(servico.codigoMunicipioPrestacao || '').replace(/\D/g, '');
  if (locPrestMun.length !== 7) {
    throw new Error(`NATIONAL_DPS_DATA_INCOMPLETE: servico.codigoMunicipioPrestacao deve ter 7 dígitos (${locPrestMun}).`);
  }
  const rawTribNac = String(servico.codigoTribNacional || servico.codigoTributacaoNacional || '').replace(/\D/g, '');
  if (rawTribNac.length < 4 || rawTribNac.length > 6) {
    throw new Error(`NATIONAL_DPS_DATA_INCOMPLETE: servico.codigoTribNacional inválido (${rawTribNac}).`);
  }
  const cTribNac = rawTribNac.padEnd(6, '0');
  const cTribMun = servico.codigoTribMunicipal || servico.codigoTributacaoMunicipal ? String(servico.codigoTribMunicipal || servico.codigoTributacaoMunicipal).trim() : '';
  const xDescServ = String(servico.descricao || servico.discriminacao || '').trim();
  if (!xDescServ) {
    throw new Error('NATIONAL_DPS_DATA_INCOMPLETE: servico.descricao é obrigatório.');
  }
  const cNbs = servico.nbs ? String(servico.nbs).replace(/\D/g, '') : '';

  if (!valores) {
    throw new Error('NATIONAL_DPS_DATA_INCOMPLETE: Grupo valores é obrigatório.');
  }
  const numValor = Number(valores.valorServicos ?? valores.valorServico);
  if (isNaN(numValor) || numValor <= 0) {
    throw new Error(`NATIONAL_DPS_DATA_INCOMPLETE: valores.valorServicos inválido (${numValor}).`);
  }
  const vServ = numValor.toFixed(2);

  let pAliqTag = '';
  const rawAliq = valores.aliquotaIss ?? valores.aliquota;
  if (rawAliq !== undefined && rawAliq !== null && rawAliq !== '' && !isNaN(Number(rawAliq)) && Number(rawAliq) > 0) {
    pAliqTag = `\n          <pAliq>${Number(rawAliq).toFixed(2)}</pAliq>`;
  }

  const rawRet = String(valores.issRetido ?? '1').trim();
  const issRetido = (rawRet === '2' || rawRet === 'true' || rawRet === 'SIM') ? '2' : '1';

  // Competência fiscal: AAAA-MM-DD
  if (!competenciaData || !/^\d{4}-\d{2}-\d{2}$/.test(competenciaData)) {
    throw new Error(`NATIONAL_DPS_DATA_INCOMPLETE: competenciaData deve estar no formato AAAA-MM-DD (${competenciaData}).`);
  }
  const dCompet = competenciaData;

  const dhEmi = formatDateTimeSaoPaulo(emissao);
  const numDpsStr = String(dpsNumero).trim();
  const serieDpsStr = String(dpsSerie || '1').trim();

  // Constrói ID oficial de 45 posições
  const idStr = buildOfficialDpsId({
    codMun: prestMun,
    tipoInscricao: '1',
    inscricaoFederal: prestCnpj,
    serie: serieDpsStr,
    numero: numDpsStr
  });

  const cTribMunTag = cTribMun ? `\n        <cTribMun>${escapeXml(cTribMun)}</cTribMun>` : '';
  const cNbsTag = cNbs ? `\n        <cNBS>${escapeXml(cNbs)}</cNBS>` : '';
  const imTag = prestIm ? `\n      <IM>${escapeXml(prestIm)}</IM>` : '';
  const prestNomeTag = prestNome ? `\n      <xNome>${escapeXml(prestNome)}</xNome>` : '';

  let xml = `<?xml version="1.0" encoding="utf-8"?>
<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">
  <infDPS Id="${idStr}">
    <tpAmb>${ambiente}</tpAmb>
    <dhEmi>${dhEmi}</dhEmi>
    <verAplic>1.0.0</verAplic>
    <serie>${escapeXml(serieDpsStr)}</serie>
    <nDPS>${escapeXml(numDpsStr)}</nDPS>
    <dCompet>${dCompet}</dCompet>
    <tpEmit>1</tpEmit>
    <cLocEmi>${prestMun}</cLocEmi>
    <prest>
      <CNPJ>${prestCnpj}</CNPJ>${imTag}${prestNomeTag}
      <regTrib>
        <opSimpNac>3</opSimpNac>
        <regEspTrib>0</regEspTrib>
      </regTrib>
    </prest>
    <toma>
      <CNPJ>${tomaCnpj}</CNPJ>
      <xNome>${escapeXml(tomaNome)}</xNome>
      <end>
        <endNac>
          <cMun>${tomaMun}</cMun>
          <CEP>${tomaCep}</CEP>
        </endNac>
        <xLgr>${escapeXml(tomaLogr)}</xLgr>
        <nro>${escapeXml(tomaNro)}</nro>
        <xBairro>${escapeXml(tomaBairro)}</xBairro>
      </end>
    </toma>
    <serv>
      <locPrest>
        <cLocPrestacao>${locPrestMun}</cLocPrestacao>
      </locPrest>
      <cServ>
        <cTribNac>${cTribNac}</cTribNac>${cTribMunTag}
        <xDescServ>${escapeXml(xDescServ)}</xDescServ>${cNbsTag}
      </cServ>
    </serv>
    <valores>
      <vServPrest>
        <vServ>${vServ}</vServ>
      </vServPrest>
      <trib>
        <tribMun>
          <tribISSQN>1</tribISSQN>
          <tpRetISSQN>${issRetido}</tpRetISSQN>${pAliqTag}
        </tribMun>
        <totTrib>
          <indTotTrib>0</indTotTrib>
        </totTrib>
      </trib>
    </valores>
  </infDPS>
</DPS>`.trim();

  // Assinatura digital com XMLDSig W3C C14N — FAIL-CLOSED
  if (certData) {
    if (!certData.pemKey || !certData.pemCert) {
      throw new Error('NATIONAL_XMLDSIG_FAILED: Chave privada ou certificado PEM ausente para assinatura da DPS.');
    }
    try {
      xml = signXmlNode({
        xml,
        targetId: idStr,
        pemKey: certData.pemKey,
        pemCert: certData.pemCert
      });
    } catch (errSig) {
      throw new Error(`NATIONAL_XMLDSIG_FAILED: Falha ao assinar XML da DPS (${errSig.message}).`);
    }

    const verifyResult = verifyXmlSignature({ signedXml: xml, pemCert: certData.pemCert });
    if (!verifyResult) {
      throw new Error('NATIONAL_XMLDSIG_VERIFY_FAILED: Assinatura XML da DPS não passou na verificação criptográfica.');
    }
  }

  return { dpsId: idStr, xml };
}

function buildNationalSubmitRequest({ dpsXml, baseUrl = DEFAULT_PRODUCTION_URL }) {
  if (!String(dpsXml || '').trim()) throw new Error('NATIONAL_DPS_XML_REQUIRED');
  const normBase = normalizeBaseUrl(baseUrl);
  const endpointUrl = `${normBase}/nfse`;
  return {
    method: 'POST',
    url: endpointUrl,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Accept': 'application/xml, text/xml, application/json'
    },
    body: String(dpsXml),
    tls: { clientCertificateRequired: true, rejectUnauthorized: true }
  };
}

function buildNationalNfseReadRequest({ accessKey, baseUrl = DEFAULT_PRODUCTION_URL }) {
  if (!String(accessKey || '').trim()) throw new Error('NATIONAL_NFSE_ACCESS_KEY_REQUIRED');
  const normBase = normalizeBaseUrl(baseUrl);
  const key = String(accessKey || '').replace(/\D/g, '');
  return {
    method: 'GET',
    url: `${normBase}/nfse/${key}`,
    headers: {
      'Accept': 'application/xml, text/xml, application/json'
    },
    tls: { clientCertificateRequired: true, rejectUnauthorized: true }
  };
}

function buildNationalDpsReadRequest({ dpsId, method = 'GET', baseUrl = DEFAULT_PRODUCTION_URL }) {
  if (!String(dpsId || '').trim()) throw new Error('NATIONAL_DPS_ID_REQUIRED');
  const normBase = normalizeBaseUrl(baseUrl);
  return {
    method: String(method).toUpperCase(),
    url: `${normBase}/dps/${dpsId}`,
    headers: {
      'Accept': 'application/xml, text/xml, application/json'
    },
    tls: { clientCertificateRequired: true, rejectUnauthorized: true }
  };
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
        statusCode,
        success: true,
        chaveAcesso,
        nfseNumero: numero,
        dhEmi,
        protocolo: nProt,
        xml: text
      };
    }

    // 2. Erros ou Mensagens de Rejeição
    const errosNode = parsed.erros || parsed.ListaMensagemRetorno || parsed.mensagens || parsed.error;
    if (errosNode) {
      const rawList = Array.isArray(errosNode) ? errosNode : (errosNode.erro || errosNode.MensagemRetorno || [errosNode]);
      const list = Array.isArray(rawList) ? rawList : [rawList];
      const errors = list.map(item => ({
        codigo: String(item.codigo || item.code || item['@_codigo'] || '').trim(),
        descricao: String(item.descricao || item.mensagem || item.message || JSON.stringify(item)).trim()
      }));

      return {
        status: 'REJECTED',
        statusCode,
        success: false,
        errors,
        rawXml: text
      };
    }

    if (text.includes('<chNFSe>') || text.includes('infNFSe')) {
      const chMatch = text.match(/<chNFSe>(\d+)<\/chNFSe>/);
      const numMatch = text.match(/<nNFSe>(\d+)<\/nNFSe>/);
      return {
        status: 'ISSUED_RAW',
        statusCode,
        success: true,
        chaveAcesso: chMatch ? chMatch[1] : '',
        nfseNumero: numMatch ? numMatch[1] : '',
        xml: text
      };
    }

    return {
      status: 'UNKNOWN_STRUCTURE',
      statusCode,
      success: false,
      rawBody: text
    };
  } catch (parseErr) {
    return {
      status: 'PARSE_ERROR',
      statusCode,
      success: false,
      error: parseErr.message,
      rawBody: text
    };
  }
}

/**
 * Cliente HTTP mTLS nativo com suporte estrito a TLS 1.2
 */
function executeHttpRequest({ method, url, headers = {}, body = null, certData = null, timeout = 30000 }) {
  const parsedUrl = new URL(url);
  const isHttps = parsedUrl.protocol === 'https:';
  if (!isHttps) {
    throw new Error('SEC_TRANSPORT: Comunicação com a NFS-e Nacional exige HTTPS/TLS.');
  }

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || 443,
    path: parsedUrl.pathname + parsedUrl.search,
    method: String(method).toUpperCase(),
    headers: { ...headers },
    timeout,
    minVersion: 'TLSv1.2'
  };

  if (certData && certData.pemKey && certData.pemCert) {
    options.key = certData.pemKey;
    options.cert = certData.pemCa ? `${certData.pemCert}\n${certData.pemCa}` : certData.pemCert;
    options.rejectUnauthorized = true;
  }

  if (body) {
    const payload = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body;
    options.headers['Content-Length'] = payload.length;
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
 * Fábrica do Provedor Nacional NFS-e
 */
function createNationalIssuerProvider(options = {}) {
  const environment = options.environment || 'production';
  const effectiveBaseUrl = normalizeBaseUrl(options.baseUrl, environment);
  const dependencies = options.dependencies || {};
  const transport = options.transport || dependencies.transport || dependencies.executeHttpRequest || executeHttpRequest;

  return Object.freeze({
    provider: 'NATIONAL_ISSUER',
    environment,
    baseUrl: effectiveBaseUrl,

    /**
     * Envia DPS ao Emissor Nacional (POST /nfse) com validação XSD e exatamente-once
     */
    async submit({ dpsXml, dpsId, certData, dryRun = false, timeout = 30000 } = {}) {
      if (!dpsXml || !String(dpsXml).trim()) {
        throw new Error('NATIONAL_DPS_XML_REQUIRED: XML da DPS é obrigatório para submissão.');
      }
      if (dryRun) {
        return {
          status: 'DRY_RUN_SUCCESS',
          environment,
          dpsId,
          provider: 'NATIONAL_ISSUER',
          newProviderWrites: 0
        };
      }

      // Validação XSD prévia ao envio — FAIL-CLOSED
      const xsdCheck = await validateNationalDpsAgainstOfficialXsd(dpsXml);
      if (!xsdCheck.valid) {
        throw new Error(`NATIONAL_DPS_XSD_VALIDATION_FAILED: ${xsdCheck.errors.join('; ')}`);
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
        const errCodes = parsed.errors.map(e => e.codigo).join(',');
        const errMsg = parsed.errors.map(e => `${e.codigo}: ${e.descricao}`).join(' | ');
        return {
          status: 'REJECTED_CORRECTABLE',
          environment,
          dpsId,
          errorCodes: errCodes,
          message: errMsg,
          rawErrors: parsed.errors,
          statusCode: httpRes.statusCode,
          newProviderWrites: 1
        };
      }

      throw new Error(`NATIONAL_SUBMIT_HTTP_${httpRes.statusCode}: ${httpRes.body.slice(0, 500)}`);
    },

    /**
     * Consulta NFS-e pela chave de acesso (GET /nfse/{chaveAcesso})
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
          xml: res.body,
          statusCode: 200
        };
      }

      if (res.statusCode === 404) {
        return { status: 'NOT_FOUND', accessKey, statusCode: 404 };
      }

      return { status: 'QUERY_ERROR', accessKey, statusCode: res.statusCode, body: res.body };
    },

    /**
     * Consulta NFS-e pelo ID da DPS (GET /dps/{id})
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
  formatDateTimeSaoPaulo,
  normalizeBaseUrl,
  buildNationalDpsXml,
  buildNationalSubmitRequest,
  buildNationalNfseReadRequest,
  buildNationalDpsReadRequest,
  parseNationalSubmitResponse,
  executeHttpRequest,
  createNationalIssuerProvider
};
