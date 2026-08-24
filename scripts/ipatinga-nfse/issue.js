'use strict';

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { CONFIG, sanitize } = require('./config');
const { readSheetValues, appendSheetValues, updateSheetValues } = require('./google');
const {
  ensureLedgerSheet,
  loadLedger,
  findLedgerEntry,
  allocateRpsAtomically,
  markSubmitting,
  markSubmittedAsyncProcessing,
  markIssued,
  markRejectedCorrectable,
  markUnknownAfterTimeout,
  markProviderInfraUnavailable,
  markFailedSafe,
  RPS_STATUS,
  RECONCILIATION_STATUS,
  MAX_ATTEMPTS
} = require('./ledger');
const { prepareDemand, demandRows, tomadorRows, patternRows, buildControlledCandidate } = require('./prepare');
const { validateXmlAgainstOfficialXsd } = require('./xsd-validator');
const { signXmlNode, verifyXmlSignature } = require('./xmldsig');
const { callSoapOperation } = require('./soap');
const { buildCabecalho, parseConsultarNfseResposta } = require('./abrasf');
const { getXmlNode, getXmlValue, findXmlNode, findXmlValue, ensureArray, parseXml } = require('./xml');

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isProviderInfraError(err) {
  if (!err) return false;
  const msg = String(err.message || err || '').toUpperCase();
  return msg.includes('WSDL') ||
         msg.includes('500') ||
         msg.includes('502') ||
         msg.includes('503') ||
         msg.includes('504') ||
         msg.includes('ENOTFOUND') ||
         msg.includes('ECONNREFUSED') ||
         msg.includes('CERT_HAS_EXPIRED') ||
         msg.includes('DEPTH_ZERO_SELF_SIGNED_CERT') ||
         msg.includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
}

function probeUrl(url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.get(url, { timeout: timeoutMs, rejectUnauthorized: true }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({
            url,
            accessible: res.statusCode >= 200 && res.statusCode < 400,
            statusCode: res.statusCode,
            bodySample: data.slice(0, 200)
          });
        });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ url, accessible: false, error: 'TIMEOUT' });
      });
      req.on('error', (err) => {
        resolve({ url, accessible: false, error: err.message });
      });
    } catch (e) {
      resolve({ url, accessible: false, error: e.message });
    }
  });
}

/**
 * Operação leve de probe de saúde real dos Web Services municipal
 */
async function probeProviderHealth({ certData = null } = {}, dependencies = {}) {
  const prodWsdlUrl = CONFIG.ENDPOINTS.production.wsdl;
  const homWsdlUrl = CONFIG.ENDPOINTS.homologation.wsdl;

  const [prodWsdl, homWsdl] = await Promise.all([
    probeUrl(prodWsdlUrl),
    probeUrl(homWsdlUrl)
  ]);

  let prodSoapRead = { accessible: false, status: 'NOT_CHECKED' };
  if (certData && certData.isValid && prodWsdl.accessible) {
    try {
      const soapCall = dependencies.callSoapOperation || callSoapOperation;
      const testXml = buildConsultarNfsePorRpsEnvio({ rpsNumero: '1', rpsSerie: 'A', rpsTipo: '1' });
      const res = await soapCall({
        environment: 'production',
        operation: 'ConsultarNfsePorRps',
        cabecMsg: buildCabecalho(),
        dadosMsg: testXml,
        certData
      });
      prodSoapRead = { accessible: true, statusCode: res.statusCode };
    } catch (err) {
      prodSoapRead = { accessible: false, error: err.message };
    }
  }

  const productionWsdlStatus = prodWsdl.accessible ? 'UP' : 'DOWN';
  const homologationWsdlStatus = homWsdl.accessible ? 'UP' : 'DOWN';
  const productionSoapReadStatus = prodSoapRead.accessible ? 'UP' : 'DOWN';

  return {
    operation: 'provider_health',
    status: (productionWsdlStatus === 'UP' || homologationWsdlStatus === 'UP') ? 'SUCCESS' : 'FAILED',
    PRODUCTION_WSDL: productionWsdlStatus,
    HOMOLOGATION_WSDL: homologationWsdlStatus,
    PRODUCTION_SOAP_READ: productionSoapReadStatus,
    details: {
      productionWsdl: prodWsdl,
      homologationWsdl: homWsdl,
      productionSoapRead: prodSoapRead
    },
    timestamp: new Date().toISOString()
  };
}

function buildConsultarNfsePorRpsEnvio({ rpsNumero, rpsSerie = 'A', rpsTipo = '1', cnpj = null, im = null }) {
  const cnpjClean = cnpj || CONFIG.PRESTADOR.CNPJ_DIGITS;
  const imClean = im || CONFIG.PRESTADOR.INSCRICAO_MUNICIPAL;

  return `<ConsultarNfseRpsEnvio xmlns="${CONFIG.ABRASF.SCHEMA_NAMESPACE}">` +
    `<IdentificacaoRps>` +
      `<Numero>${escapeXml(rpsNumero)}</Numero>` +
      `<Serie>${escapeXml(rpsSerie)}</Serie>` +
      `<Tipo>${escapeXml(rpsTipo)}</Tipo>` +
    `</IdentificacaoRps>` +
    `<Prestador>` +
      `<CpfCnpj><Cnpj>${escapeXml(cnpjClean)}</Cnpj></CpfCnpj>` +
      `<InscricaoMunicipal>${escapeXml(imClean)}</InscricaoMunicipal>` +
    `</Prestador>` +
  `</ConsultarNfseRpsEnvio>`;
}

function parseGerarNfseResposta(xmlString) {
  if (!xmlString) return { hasNfse: false, numero: null, codigoVerificacao: null, dataEmissao: null, mensagens: [], isAsyncAccepted: false };
  
  const parsed = parseXml(xmlString);
  const root = getXmlNode(parsed, ['GerarNfseResposta', 'tc:GerarNfseResposta']) || parsed;

  const compNfse = findXmlNode(root, 'CompNfse');
  const infNfse = compNfse ? findXmlNode(compNfse, 'InfNfse') : findXmlNode(root, 'InfNfse');

  const numero = infNfse ? findXmlValue(infNfse, 'Numero') : findXmlValue(root, 'NumeroNfse');
  const codigoVerificacao = infNfse ? findXmlValue(infNfse, 'CodigoVerificacao') : findXmlValue(root, 'CodigoVerificacao');
  const dataEmissao = infNfse ? findXmlValue(infNfse, 'DataEmissao') : findXmlValue(root, 'DataEmissao');

  const mensagens = [];

  // 1. ListaMensagemRetorno
  const listaMensagem = findXmlNode(root, 'ListaMensagemRetorno') || findXmlNode(root, 'ListaMensagensRetorno');
  if (listaMensagem) {
    const msgs = ensureArray(listaMensagem.MensagemRetorno || listaMensagem['tc:MensagemRetorno']);
    for (const m of msgs.filter(Boolean)) {
      mensagens.push({
        codigo: findXmlValue(m, 'Codigo') || findXmlValue(m, 'code'),
        mensagem: findXmlValue(m, 'Mensagem') || findXmlValue(m, 'message'),
        correcao: findXmlValue(m, 'Correcao') || findXmlValue(m, 'correction')
      });
    }
  }

  // 2. Mensagem direta ou ADN
  let isAsyncAccepted = false;
  const msgDireta = findXmlNode(root, 'Mensagem') || findXmlNode(root, 'Confirmacao');
  if (msgDireta) {
    const cod = findXmlValue(msgDireta, 'Codigo') || findXmlValue(msgDireta, 'Status') || '';
    const msg = findXmlValue(msgDireta, 'Mensagem') || (typeof msgDireta === 'string' ? msgDireta : '');
    if (cod || msg) {
      mensagens.push({ codigo: cod, mensagem: msg, correcao: '' });
      if (String(msg).toLowerCase().includes('solicita') && String(msg).toLowerCase().includes('recebida')) {
        isAsyncAccepted = true;
      }
    }
  }

  // 3. Busca recursiva genérica de MensagemRetorno se não achou nada
  if (mensagens.length === 0) {
    const mr = findXmlNode(root, 'MensagemRetorno');
    if (mr) {
      mensagens.push({
        codigo: findXmlValue(mr, 'Codigo'),
        mensagem: findXmlValue(mr, 'Mensagem'),
        correcao: findXmlValue(mr, 'Correcao')
      });
    }
  }

  return {
    hasNfse: Boolean(numero && codigoVerificacao),
    numero: numero ? String(numero).trim() : null,
    codigoVerificacao: codigoVerificacao ? String(codigoVerificacao).trim() : null,
    dataEmissao: dataEmissao ? String(dataEmissao).trim() : null,
    mensagens,
    isAsyncAccepted
  };
}

async function reconcileRps({ environment = 'production', requestId = null, itemIndex = 1, rpsNumero = null, rpsSerie = 'A', rpsTipo = '1', certData = null }, dependencies = {}) {
  if (!certData || !certData.loaded || !certData.isValid) {
    throw new Error('CERT_INVALID: Reconciliação requer certificado A1 válido.');
  }

  await ensureLedgerSheet(dependencies);
  const ledgerEntries = await loadLedger(dependencies);

  let ledgerEntry = null;
  if (requestId) {
    ledgerEntry = findLedgerEntry(ledgerEntries, { environment, requestId, itemIndex });
  } else if (rpsNumero) {
    ledgerEntry = ledgerEntries.find(e =>
      e.environment?.toLowerCase() === String(environment).toLowerCase() &&
      String(e.rps_numero) === String(rpsNumero)
    ) || null;
  }

  const targetRpsNum = ledgerEntry ? ledgerEntry.rps_numero : rpsNumero;
  const targetRpsSer = ledgerEntry ? ledgerEntry.rps_serie : rpsSerie;
  const targetRpsTip = ledgerEntry ? ledgerEntry.rps_tipo : rpsTipo;

  if (!targetRpsNum) {
    throw new Error('RECONCILE_TARGET_NOT_FOUND: Nenhum RPS especificado ou localizado no Ledger.');
  }

  const consultarRpsXml = buildConsultarNfsePorRpsEnvio({
    rpsNumero: targetRpsNum,
    rpsSerie: targetRpsSer,
    rpsTipo: targetRpsTip
  });

  const soapCall = dependencies.callSoapOperation || callSoapOperation;
  let queryRes = null;

  try {
    queryRes = await soapCall({
      environment,
      operation: 'ConsultarNfsePorRps',
      cabecMsg: buildCabecalho(),
      dadosMsg: consultarRpsXml,
      certData
    });
  } catch (err) {
    return {
      status: RECONCILIATION_STATUS.QUERY_FAILED,
      environment,
      requestId: ledgerEntry?.request_id || requestId,
      itemIndex: ledgerEntry?.item_index || itemIndex,
      rpsNumero: targetRpsNum,
      error: err.message
    };
  }

  let parsedQuery = null;
  try {
    parsedQuery = parseConsultarNfseResposta(queryRes.outputXml);
  } catch (err) {
    return {
      status: RECONCILIATION_STATUS.AMBIGUOUS,
      environment,
      requestId: ledgerEntry?.request_id || requestId,
      itemIndex: ledgerEntry?.item_index || itemIndex,
      rpsNumero: targetRpsNum,
      error: `PARSING_ERROR: ${err.message}`
    };
  }

  // 1. NFS-e Encontrada
  if (parsedQuery.notas && parsedQuery.notas.length > 0) {
    const nota = parsedQuery.notas[0];
    if (ledgerEntry) {
      ledgerEntry = await markIssued(ledgerEntry, {
        nfseNumero: nota.numero,
        nfseChave: nota.codigoVerificacao,
        dataEmissao: nota.dataEmissao
      }, dependencies);
    }
    return {
      status: RECONCILIATION_STATUS.ISSUED,
      environment,
      requestId: ledgerEntry?.request_id || requestId,
      itemIndex: ledgerEntry?.item_index || itemIndex,
      rpsNumero: targetRpsNum,
      rpsSerie: targetRpsSer,
      rpsTipo: targetRpsTip,
      nfseNumero: nota.numero,
      nfseChave: nota.codigoVerificacao,
      dataEmissao: nota.dataEmissao,
      tomador: nota.tomador,
      valorServicos: nota.valorServicos
    };
  }

  // 2. Mensagens do Provedor
  const msgs = parsedQuery.mensagens || [];
  const msgCodes = msgs.map(m => String(m.codigo || '').toUpperCase());
  const msgTexts = msgs.map(m => String(m.mensagem || ''));

  // Códigos de "RPS não encontrado / não cadastrado"
  const isNotFound = msgCodes.some(c => ['E4', 'E10', 'E159', 'E212', 'E182', 'E04'].includes(c)) ||
                     msgTexts.some(t => /nao encontrado|nao localizado|inexistente|sem dados/i.test(t));

  if (isNotFound) {
    return {
      status: RECONCILIATION_STATUS.RPS_NOT_FOUND_CONFIRMED,
      environment,
      requestId: ledgerEntry?.request_id || requestId,
      itemIndex: ledgerEntry?.item_index || itemIndex,
      rpsNumero: targetRpsNum,
      providerErrorCodes: msgCodes.join(', '),
      providerMessage: msgTexts.join('; ') || 'RPS nao encontrado no provedor fiscal'
    };
  }

  // Mensagens de "Lote/RPS em processamento"
  const isProcessing = msgTexts.some(t => /processamento|aguarde|adn|sefaz/i.test(t));
  if (isProcessing) {
    if (ledgerEntry && ledgerEntry.status !== RPS_STATUS.SUBMITTED_ASYNC_PROCESSING) {
      ledgerEntry = await markSubmittedAsyncProcessing(ledgerEntry, { providerMessage: msgTexts.join('; ') }, dependencies);
    }
    return {
      status: RECONCILIATION_STATUS.PROCESSING,
      environment,
      requestId: ledgerEntry?.request_id || requestId,
      itemIndex: ledgerEntry?.item_index || itemIndex,
      rpsNumero: targetRpsNum,
      providerMessage: msgTexts.join('; ')
    };
  }

  return {
    status: RECONCILIATION_STATUS.AMBIGUOUS,
    environment,
    requestId: ledgerEntry?.request_id || requestId,
    itemIndex: ledgerEntry?.item_index || itemIndex,
    rpsNumero: targetRpsNum,
    providerErrorCodes: msgCodes.join(', '),
    providerMessage: msgTexts.join('; ')
  };
}

/**
 * Emite NFS-e em ambiente especificado (production ou homologation)
 */
async function issueNfse({ requestId, itemIndex = 1, certData, dryRun = false }, dependencies = {}) {
  const environment = process.env.INPUT_ENVIRONMENT || 'production';

  // Kill Switch operacional
  if (process.env.NFE_ISSUE_KILL_SWITCH === 'true' || process.env.NFE_ISSUE_KILL_SWITCH === true) {
    throw new Error('NFE_ISSUE_KILL_SWITCH_ACTIVE: Emissao bloqueada emergencialmente pelo kill switch.');
  }

  if (!certData || !certData.loaded || !certData.isValid) {
    throw new Error('CERT_INVALID: Emissão requer certificado A1 válido.');
  }

  const read = dependencies.readSheetValues || readSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;

  if (!dryRun) {
    await ensureLedgerSheet(dependencies);
  }

  // 1. Consulta Ledger antes de qualquer processamento
  let ledgerEntries = await loadLedger(dependencies);
  let ledgerEntry = findLedgerEntry(ledgerEntries, {
    environment,
    requestId,
    itemIndex
  });

  // 2. Regra de Estados do Ledger
  if (ledgerEntry) {
    if (ledgerEntry.status === RPS_STATUS.ISSUED) {
      return {
        status: 'ALREADY_ISSUED',
        environment,
        requestId,
        itemIndex,
        rpsNumero: ledgerEntry.rps_numero,
        nfseNumero: ledgerEntry.nfse_numero,
        nfseChave: ledgerEntry.nfse_chave,
        gerarNfseCalls: 0,
        message: 'Nota já emitida anteriormente para este request_id e item_index (idempotente).'
      };
    }

    if (ledgerEntry.status === RPS_STATUS.FAILED_SAFE) {
      return {
        status: 'REVISAO_MANUAL',
        environment,
        requestId,
        itemIndex,
        rpsNumero: ledgerEntry.rps_numero,
        error: ledgerEntry.error,
        message: 'Registro em FAILED_SAFE requer intervenção/revisão manual; reemissão automática proibida.'
      };
    }

    if (ledgerEntry.status === RPS_STATUS.PROVIDER_INFRA_UNAVAILABLE) {
      // Reconciliação prévia obrigatória antes de retentar
      const reconcile = await reconcileRps({ environment, requestId, itemIndex, certData }, dependencies);
      if (reconcile.status === RECONCILIATION_STATUS.ISSUED) {
        return {
          status: 'ISSUED',
          environment,
          requestId,
          itemIndex,
          rpsNumero: reconcile.rpsNumero,
          nfseNumero: reconcile.nfseNumero,
          nfseChave: reconcile.nfseChave,
          dataEmissao: reconcile.dataEmissao,
          recoveredViaRpsQuery: true
        };
      }
      if (reconcile.status !== RECONCILIATION_STATUS.RPS_NOT_FOUND_CONFIRMED) {
        return {
          status: 'PROVIDER_INFRA_UNAVAILABLE',
          environment,
          requestId,
          itemIndex,
          rpsNumero: ledgerEntry.rps_numero,
          message: `Reconciliação retornou ${reconcile.status}. Provedor municipal continua instável ou com status inconclusivo.`
        };
      }
      // Se RPS_NOT_FOUND_CONFIRMED, prossegue com o mesmo RPS 101 sem alocar novo
    }

    if (ledgerEntry.status === RPS_STATUS.SUBMITTED_ASYNC_PROCESSING) {
      const reconcile = await reconcileRps({ environment, requestId, itemIndex, certData }, dependencies);
      if (reconcile.status === RECONCILIATION_STATUS.ISSUED) {
        return {
          status: 'ISSUED',
          environment,
          requestId,
          itemIndex,
          rpsNumero: reconcile.rpsNumero,
          nfseNumero: reconcile.nfseNumero,
          nfseChave: reconcile.nfseChave,
          dataEmissao: reconcile.dataEmissao,
          recoveredViaRpsQuery: true
        };
      }
      return {
        status: 'SUBMITTED_ASYNC_PROCESSING',
        environment,
        requestId,
        itemIndex,
        rpsNumero: ledgerEntry.rps_numero,
        message: 'Nota continua em processamento assíncrono pelo Sefaz/ADN. Reemissão proibida.'
      };
    }

    if (ledgerEntry.status === RPS_STATUS.REJECTED_CORRECTABLE) {
      const reconcile = await reconcileRps({ environment, requestId, itemIndex, certData }, dependencies);
      if (reconcile.status === RECONCILIATION_STATUS.ISSUED) {
        return {
          status: 'ISSUED',
          environment,
          requestId,
          itemIndex,
          rpsNumero: reconcile.rpsNumero,
          nfseNumero: reconcile.nfseNumero,
          nfseChave: reconcile.nfseChave,
          recoveredViaRpsQuery: true
        };
      }

      if (reconcile.status !== RECONCILIATION_STATUS.RPS_NOT_FOUND_CONFIRMED) {
        return {
          status: 'RECONCILIATION_REQUIRED',
          environment,
          requestId,
          itemIndex,
          rpsNumero: ledgerEntry.rps_numero,
          message: `Reconciliação retornou ${reconcile.status}. Reemissão segura não autorizada até confirmação determinística de não emissão.`
        };
      }

      if (Number(ledgerEntry.attempt_count || 0) >= MAX_ATTEMPTS) {
        await markFailedSafe(ledgerEntry, { error: `MAX_ATTEMPTS_EXCEEDED (${ledgerEntry.attempt_count})` }, dependencies);
        return {
          status: 'REVISAO_MANUAL',
          environment,
          requestId,
          itemIndex,
          rpsNumero: ledgerEntry.rps_numero,
          message: `Limite de ${MAX_ATTEMPTS} tentativas atingido para este item. Bloqueado para revisão manual.`
        };
      }
    }

    if (ledgerEntry.status === RPS_STATUS.UNKNOWN_AFTER_TIMEOUT || ledgerEntry.status === RPS_STATUS.SUBMITTING) {
      const reconcile = await reconcileRps({ environment, requestId, itemIndex, certData }, dependencies);
      if (reconcile.status === RECONCILIATION_STATUS.ISSUED) {
        return {
          status: 'ISSUED',
          environment,
          requestId,
          itemIndex,
          rpsNumero: reconcile.rpsNumero,
          nfseNumero: reconcile.nfseNumero,
          nfseChave: reconcile.nfseChave,
          recoveredViaRpsQuery: true
        };
      }
      if (ledgerEntry.status === RPS_STATUS.SUBMITTING) {
        ledgerEntry = await markUnknownAfterTimeout(ledgerEntry, { error: 'CRASH_WINDOW_RECOVERY_INCONCLUSIVE' }, dependencies);
      }
      return {
        status: 'SAFE_RETRY_REQUIRED',
        environment,
        requestId,
        itemIndex,
        rpsNumero: ledgerEntry.rps_numero,
        message: 'Envio anterior em estado ambíguo (SUBMITTING/TIMEOUT). Consulta por RPS não localizou nota emitida. Nenhuma reemissão automática executada.'
      };
    }
  }

  // 3. Prepara a demanda (se não for caso já emitido/bloqueado no ledger)
  let prepared;
  if (requestId.startsWith('fixture-homologation') || requestId.startsWith('fixture-controlada')) {
    prepared = buildControlledCandidate({ requestId, environment });
  } else {
    const [demandasRaw, tomadoresRaw, patternsRaw, notasRaw] = await Promise.all([
      read(spreadsheetId, `${CONFIG.SHEETS.TABS.DEMANDAS}!A:Z`),
      read(spreadsheetId, `${CONFIG.SHEETS.TABS.TOMADORES}!A:S`),
      read(spreadsheetId, `${CONFIG.SHEETS.TABS.PADROES}!A:X`),
      read(spreadsheetId, `${CONFIG.SHEETS.TABS.NOTAS}!A:X`)
    ]);

    prepared = prepareDemand({
      requestId,
      demandas: demandRows(demandasRaw),
      tomadores: tomadorRows(tomadoresRaw),
      patterns: patternRows(patternsRaw),
      notas: notasRaw
    });
  }

  if (prepared.validationStatus !== 'READY_TO_ISSUE' || !prepared.candidates.length) {
    throw new Error(`PREPARE_NOT_READY: ${prepared.blockingReasons.join(', ')}`);
  }

  const candidate = prepared.candidates[itemIndex - 1];
  if (!candidate) {
    throw new Error(`CANDIDATE_INDEX_OUT_OF_BOUNDS: index ${itemIndex}`);
  }

  if (!candidate.codigoMunicipioPrestacao) {
    throw new Error('PREPARE_NOT_READY: codigoMunicipioPrestacao indefinido para o tomador/padrão.');
  }

  if (!candidate.codigoMunicipioIncidenciaIss) {
    throw new Error('PREPARE_NOT_READY: codigoMunicipioIncidenciaIss indefinido para o tomador/padrão.');
  }

  // 4. Alocação Atômica do ALLOCATED (se ainda não existia)
  if (!ledgerEntry) {
    if (!dryRun) {
      ledgerEntry = await allocateRpsAtomically({
        environment,
        requestId,
        itemIndex,
        series: 'A',
        type: '1'
      }, dependencies);
    } else {
      ledgerEntry = {
        environment,
        request_id: requestId,
        item_index: String(itemIndex),
        rps_numero: '101',
        rps_serie: 'A',
        rps_tipo: '1',
        status: RPS_STATUS.ALLOCATED,
        allocated_at: new Date().toISOString(),
        attempt_count: 0
      };
    }
  }

  candidate.rpsNumero = ledgerEntry.rps_numero;
  candidate.rpsSerie = ledgerEntry.rps_serie;
  candidate.rpsTipo = ledgerEntry.rps_tipo;
  candidate.xmlId = `RPS${ledgerEntry.rps_numero}${ledgerEntry.rps_serie.replace(/[^A-Za-z0-9]/g, '')}`;

  // 5. Montagem do XML estrito com Tomador e Endereço Completo
  const itemLista = String(candidate.codigoTribNacional || '').split('.').slice(0, 2).join('.');
  const codMunPrestacao = candidate.codigoMunicipioPrestacao;
  const codMunIncidencia = candidate.codigoMunicipioIncidenciaIss;
  const issRetido = candidate.issRetido || '2';
  const exigibilidadeIss = candidate.exigibilidadeIss || '1';
  const nbsTag = candidate.nbs ? `<cNBS>${escapeXml(candidate.nbs.replace(/\D/g, ''))}</cNBS>` : '';
  const cnaeTag = candidate.codigoCnae ? `<CodigoCnae>${escapeXml(candidate.codigoCnae)}</CodigoCnae>` : '';

  let enderecoXml = '';
  if (candidate.enderecoTomador) {
    const end = candidate.enderecoTomador;
    const complTag = end.complemento ? `<Complemento>${escapeXml(end.complemento)}</Complemento>` : '';
    enderecoXml = `<Endereco>` +
      `<Endereco>${escapeXml(end.logradouro || end.endereco)}</Endereco>` +
      `<Numero>${escapeXml(end.numero)}</Numero>` +
      complTag +
      `<Bairro>${escapeXml(end.bairro)}</Bairro>` +
      `<CodigoMunicipio>${escapeXml(end.codigoMunicipio)}</CodigoMunicipio>` +
      `<Uf>${escapeXml(end.uf)}</Uf>` +
      `<Cep>${escapeXml(String(end.cep || '').replace(/\D/g, ''))}</Cep>` +
    `</Endereco>`;
  }

  let valoresXml = `<ValorServicos>${candidate.valor.toFixed(2)}</ValorServicos>`;
  if (candidate.valorDeducoes !== undefined && candidate.valorDeducoes !== null && candidate.valorDeducoes > 0) {
    valoresXml += `<ValorDeducoes>${Number(candidate.valorDeducoes).toFixed(2)}</ValorDeducoes>`;
  }
  if (candidate.valorPis !== undefined && candidate.valorPis !== null && candidate.valorPis > 0) {
    valoresXml += `<ValorPis>${Number(candidate.valorPis).toFixed(2)}</ValorPis>`;
  }
  if (candidate.valorCofins !== undefined && candidate.valorCofins !== null && candidate.valorCofins > 0) {
    valoresXml += `<ValorCofins>${Number(candidate.valorCofins).toFixed(2)}</ValorCofins>`;
  }
  if (candidate.valorInss !== undefined && candidate.valorInss !== null && candidate.valorInss > 0) {
    valoresXml += `<ValorInss>${Number(candidate.valorInss).toFixed(2)}</ValorInss>`;
  }
  if (candidate.valorIr !== undefined && candidate.valorIr !== null && candidate.valorIr > 0) {
    valoresXml += `<ValorIr>${Number(candidate.valorIr).toFixed(2)}</ValorIr>`;
  }
  if (candidate.valorCsll !== undefined && candidate.valorCsll !== null && candidate.valorCsll > 0) {
    valoresXml += `<ValorCsll>${Number(candidate.valorCsll).toFixed(2)}</ValorCsll>`;
  }
  if (candidate.outrasRetencoes !== undefined && candidate.outrasRetencoes !== null && candidate.outrasRetencoes > 0) {
    valoresXml += `<OutrasRetencoes>${Number(candidate.outrasRetencoes).toFixed(2)}</OutrasRetencoes>`;
  }
  if (candidate.valTotTributos !== undefined && candidate.valTotTributos !== null && candidate.valTotTributos > 0) {
    valoresXml += `<ValTotTributos>${Number(candidate.valTotTributos).toFixed(2)}</ValTotTributos>`;
  }
  if (candidate.valorIss !== undefined && candidate.valorIss !== null && candidate.valorIss > 0) {
    valoresXml += `<ValorIss>${Number(candidate.valorIss).toFixed(2)}</ValorIss>`;
  }
  if (candidate.aliquotaIss !== undefined && candidate.aliquotaIss !== null && candidate.aliquotaIss > 0) {
    valoresXml += `<Aliquota>${Number(candidate.aliquotaIss).toFixed(4)}</Aliquota>`;
  }

  const unsignedXml = `<GerarNfseEnvio xmlns="http://www.abrasf.org.br/nfse.xsd">` +
    `<Rps>` +
      `<InfDeclaracaoPrestacaoServico Id="${escapeXml(candidate.xmlId)}">` +
        `<Rps>` +
          `<IdentificacaoRps>` +
            `<Numero>${escapeXml(candidate.rpsNumero)}</Numero>` +
            `<Serie>${escapeXml(candidate.rpsSerie)}</Serie>` +
            `<Tipo>${escapeXml(candidate.rpsTipo)}</Tipo>` +
          `</IdentificacaoRps>` +
          `<DataEmissao>${escapeXml(candidate.dataEmissao)}</DataEmissao>` +
          `<Status>1</Status>` +
        `</Rps>` +
        `<Competencia>${escapeXml(candidate.competenciaData)}</Competencia>` +
        `<Servico>` +
          `<Valores>` +
            valoresXml +
          `</Valores>` +
          `<IssRetido>${escapeXml(issRetido)}</IssRetido>` +
          `<ItemListaServico>${escapeXml(itemLista)}</ItemListaServico>` +
          cnaeTag +
          `<CodigoTributacaoMunicipio>${escapeXml(candidate.codigoTribMunicipal)}</CodigoTributacaoMunicipio>` +
          `<Discriminacao>${escapeXml(candidate.descricao)}</Discriminacao>` +
          `<CodigoMunicipio>${escapeXml(codMunPrestacao)}</CodigoMunicipio>` +
          `<CodigoPais>1058</CodigoPais>` +
          `<ExigibilidadeISS>${escapeXml(exigibilidadeIss)}</ExigibilidadeISS>` +
          `<MunicipioIncidencia>${escapeXml(codMunIncidencia)}</MunicipioIncidencia>` +
          nbsTag +
        `</Servico>` +
        `<Prestador>` +
          `<CpfCnpj><Cnpj>${escapeXml(CONFIG.PRESTADOR.CNPJ_DIGITS)}</Cnpj></CpfCnpj>` +
          `<InscricaoMunicipal>${escapeXml(CONFIG.PRESTADOR.INSCRICAO_MUNICIPAL)}</InscricaoMunicipal>` +
        `</Prestador>` +
        `<TomadorServico>` +
          `<IdentificacaoTomador>` +
            `<CpfCnpj><Cnpj>${escapeXml(candidate.cnpjTomador)}</Cnpj></CpfCnpj>` +
          `</IdentificacaoTomador>` +
          `<RazaoSocial>${escapeXml(candidate.tomador)}</RazaoSocial>` +
          enderecoXml +
        `</TomadorServico>` +
        `<OptanteSimplesNacional>${escapeXml(CONFIG.PRESTADOR.OPTANTE_SIMPLES_NACIONAL)}</OptanteSimplesNacional>` +
        `<IncentivoFiscal>2</IncentivoFiscal>` +
      `</InfDeclaracaoPrestacaoServico>` +
    `</Rps>` +
  `</GerarNfseEnvio>`;

  // 6. Assina com XMLDSig W3C C14N
  const signedXml = signXmlNode({
    xml: unsignedXml,
    targetId: candidate.xmlId,
    pemKey: certData.pemKey,
    pemCert: certData.pemCert
  });

  const sigValid = verifyXmlSignature({ signedXml, pemCert: certData.pemCert });
  if (!sigValid) {
    throw new Error('XMLDSIG_VERIFICATION_FAILED: Assinatura XML gerada é criptograficamente inválida.');
  }

  const xsdValidation = await validateXmlAgainstOfficialXsd(signedXml, 'GerarNfseEnvio');
  if (!xsdValidation.valid) {
    throw new Error(`XSD_VALIDATION_FAILED: ${xsdValidation.errors.join('; ')}`);
  }

  const xmlSha256 = crypto.createHash('sha256').update(signedXml).digest('hex');

  if (dryRun) {
    return {
      status: 'DRY_RUN_SUCCESS',
      environment,
      requestId,
      itemIndex,
      rpsNumero: candidate.rpsNumero,
      rpsSerie: candidate.rpsSerie,
      rpsTipo: candidate.rpsTipo,
      xmlSha256,
      xsdValidation: 'VALIDATED_OFFICIAL_XSD',
      xmlSignature: 'VALIDATED_XMLDSIG_C14N',
      gerarNfseCalls: 0,
      externalWrites: 0
    };
  }

  // 7. Persiste SUBMITTING antes da chamada SOAP
  ledgerEntry = await markSubmitting(ledgerEntry, dependencies);

  // 8. Chamada SOAP GerarNfse
  const soapCall = dependencies.callSoapOperation || callSoapOperation;
  let responseXml = null;
  let timeoutOccurred = false;

  try {
    const soapRes = await soapCall({
      environment,
      operation: 'GerarNfse',
      cabecMsg: buildCabecalho(),
      dadosMsg: signedXml,
      certData
    });
    responseXml = soapRes.outputXml;
  } catch (err) {
    const errMsg = String(err.message || '').toUpperCase();
    if (errMsg.includes('TIMEOUT') || errMsg.includes('ECONNRESET') || errMsg.includes('TIMED OUT')) {
      timeoutOccurred = true;
    } else if (isProviderInfraError(err)) {
      ledgerEntry = await markProviderInfraUnavailable(ledgerEntry, { error: err.message }, dependencies);
      return {
        status: RPS_STATUS.PROVIDER_INFRA_UNAVAILABLE,
        environment,
        requestId,
        itemIndex,
        rpsNumero: candidate.rpsNumero,
        error: err.message,
        message: 'Servidor municipal de produção temporariamente indisponível (WSDL / HTTP 500). Estado preservado como PROVIDER_INFRA_UNAVAILABLE para recuperação automática sem alocação de novo RPS.'
      };
    } else {
      ledgerEntry = await markFailedSafe(ledgerEntry, { error: err.message }, dependencies);
      throw err;
    }
  }

  // 9. Tratamento de Timeout
  if (timeoutOccurred || !responseXml) {
    ledgerEntry = await markUnknownAfterTimeout(ledgerEntry, { error: 'TIMEOUT_ON_GERARNFSE' }, dependencies);
    const reconcile = await reconcileRps({ environment, requestId, itemIndex, certData }, dependencies);
    if (reconcile.status === RECONCILIATION_STATUS.ISSUED) {
      return {
        status: 'ISSUED',
        environment,
        requestId,
        itemIndex,
        rpsNumero: reconcile.rpsNumero,
        nfseNumero: reconcile.nfseNumero,
        nfseChave: reconcile.nfseChave,
        dataEmissao: reconcile.dataEmissao,
        recoveredViaRpsQuery: true
      };
    }
    throw new Error('TIMEOUT_UNCONFIRMED: Emissão ficou inconclusiva após timeout e consulta por RPS.');
  }

  // 10. Parse da Resposta Oficial
  const parsedGerar = parseGerarNfseResposta(responseXml);
  
  // Se veio retorno assíncrono (ADN) ou ainda sem dados síncronos da nota
  if (!parsedGerar.hasNfse) {
    if (parsedGerar.isAsyncAccepted) {
      ledgerEntry = await markSubmittedAsyncProcessing(ledgerEntry, { providerMessage: parsedGerar.mensagens[0]?.mensagem }, dependencies);
      
      // Polling curto inicial
      for (let attempt = 1; attempt <= 2; attempt++) {
        await new Promise(r => setTimeout(r, 2000));
        const reconcile = await reconcileRps({ environment, requestId, itemIndex, certData }, dependencies);
        if (reconcile.status === RECONCILIATION_STATUS.ISSUED) {
          return {
            status: 'ISSUED',
            environment,
            requestId,
            itemIndex,
            rpsNumero: reconcile.rpsNumero,
            nfseNumero: reconcile.nfseNumero,
            nfseChave: reconcile.nfseChave,
            dataEmissao: reconcile.dataEmissao,
            recoveredViaRpsQuery: true
          };
        }
      }

      return {
        status: 'SUBMITTED_ASYNC_PROCESSING',
        environment,
        requestId,
        itemIndex,
        rpsNumero: candidate.rpsNumero,
        rpsSerie: candidate.rpsSerie,
        rpsTipo: candidate.rpsTipo,
        message: 'Solicitação aceita e persistida como SUBMITTED_ASYNC_PROCESSING. Reconciliação posterior via RPS confirmará emissão definitiva.'
      };
    }

    const errorCodes = parsedGerar.mensagens.map(m => m.codigo).filter(Boolean).join(', ');
    const errorMsg = parsedGerar.mensagens.map(m => `[${m.codigo}] ${m.mensagem}`).join('; ') || 'RESPOSTA_SEM_NFSE';
    
    // Classificação de Erro determinístico
    ledgerEntry = await markRejectedCorrectable(ledgerEntry, {
      error: errorMsg,
      providerErrorCodes: errorCodes,
      providerMessage: errorMsg
    }, dependencies);
    
    throw new Error(`GERAR_NFSE_REJECTED: ${errorMsg}`);
  }

  ledgerEntry = await markIssued(ledgerEntry, {
    nfseNumero: parsedGerar.numero,
    nfseChave: parsedGerar.codigoVerificacao,
    dataEmissao: parsedGerar.dataEmissao
  }, dependencies);

  return {
    status: 'ISSUED',
    environment,
    requestId,
    itemIndex,
    rpsNumero: candidate.rpsNumero,
    rpsSerie: candidate.rpsSerie,
    rpsTipo: candidate.rpsTipo,
    nfseNumero: parsedGerar.numero,
    nfseChave: parsedGerar.codigoVerificacao,
    dataEmissao: parsedGerar.dataEmissao,
    mensagens: parsedGerar.mensagens
  };
}

module.exports = {
  escapeXml,
  isProviderInfraError,
  probeProviderHealth,
  buildConsultarNfsePorRpsEnvio,
  parseGerarNfseResposta,
  reconcileRps,
  issueNfse,
  issueHomologation: issueNfse
};
