'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { CONFIG } = require('./config');
const { readSheetValues, appendSheetValues, updateSheetValues, getSpreadsheetMetadata, createSheetIfNotExists, uploadDriveBuffer } = require('./google');
const { ensureLedgerSheet, loadLedger, findLedgerEntry } = require('./ledger');
const { buildCabecalho, parseConsultarNfseResposta } = require('./abrasf');
const { callSoapOperation } = require('./soap');
const { buildConsultarNfsePorRpsEnvio } = require('./issue');

function persistOfficialRecoveryArtifact({ buffer, fileName, metadata }) {
  if (process.env.GITHUB_ACTIONS !== 'true') return null;

  const outputDir = path.join(__dirname, 'report', 'official-documents');
  fs.mkdirSync(outputDir, { recursive: true });
  const xmlPath = path.join(outputDir, fileName);
  const metadataPath = path.join(outputDir, `${fileName}.json`);
  fs.writeFileSync(xmlPath, buffer, { mode: 0o600 });
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
  return { xmlPath, metadataPath };
}

/**
 * Envia requisição HTTP POST seguindo redirects (necessário para Apps Script 302 echo)
 */
function httpRequestWithRedirects(targetUrl, options, postData, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) {
      return reject(new Error('TOO_MANY_REDIRECTS: Limite de redirecionamentos excedido.'));
    }

    const urlObj = new URL(targetUrl);
    const client = urlObj.protocol === 'https:' ? https : http;
    const reqOptions = {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'POST',
      headers: {
        ...options.headers,
        ...(options.method === 'POST' ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      }
    };

    const req = client.request(reqOptions, (res) => {
      // Se for redirect 301, 302, 303, 307, 308
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, targetUrl).toString();
        // Para 302/303 do Google Apps Script, o redirect para echo deve ser GET sem postData
        return resolve(httpRequestWithRedirects(redirectUrl, { method: 'GET', headers: {} }, '', maxRedirects - 1));
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data
        });
      });
    });

    req.on('error', reject);
    if (options.method === 'POST' && postData) {
      req.write(postData);
    }
    req.end();
  });
}

/**
 * Envia callback autenticado por HMAC-SHA256 para o Apps Script
 */
async function sendOfficialDocumentCallback({
  callbackUrl,
  callbackSecret,
  requestId,
  itemIndex,
  rpsNumero,
  nfseNumero,
  codigoVerificacao,
  rawOfficialBytes,
  sha256,
  fileName
}, dependencies = {}) {
  if (!callbackUrl || !callbackSecret) {
    throw new Error('CALLBACK_CONFIG_MISSING: callbackUrl ou callbackSecret não fornecido.');
  }

  const timestamp = Date.now().toString();
  const nonce = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const xmlBase64 = rawOfficialBytes.toString('base64');

  const payload = {
    action: 'nfse_document_callback',
    request_id: String(requestId),
    item_index: String(itemIndex),
    rps_numero: String(rpsNumero),
    nfse_numero: String(nfseNumero),
    codigo_verificacao: String(codigoVerificacao),
    tipo: 'NFSE_XML',
    source: 'CONSULTAR_NFSE_POR_RPS',
    sha256: String(sha256),
    file_name: fileName,
    xml_base64: xmlBase64,
    timestamp,
    nonce
  };

  const initialBodyStr = JSON.stringify(payload);
  const bodySha256 = crypto.createHash('sha256').update(initialBodyStr, 'utf8').digest('hex');
  payload.body_sha256 = bodySha256;

  const canonicalString = `${timestamp}\n${nonce}\n${bodySha256}`;
  const signature = crypto.createHmac('sha256', callbackSecret).update(canonicalString, 'utf8').digest('hex');
  payload.signature = signature;

  const postData = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'X-NFSE-Timestamp': timestamp,
    'X-NFSE-Nonce': nonce,
    'X-NFSE-Signature': signature
  };

  if (dependencies.httpPost) {
    return await dependencies.httpPost({ url: callbackUrl, headers, postData, payload });
  }

  const httpRes = await httpRequestWithRedirects(callbackUrl, { method: 'POST', headers }, postData);
  let resBody;
  try {
    resBody = JSON.parse(httpRes.data);
  } catch (err) {
    throw new Error(`CALLBACK_HTTP_RESPONSE_NOT_JSON (Status ${httpRes.statusCode}): ${httpRes.data.slice(0, 200)}`);
  }

  return {
    statusCode: httpRes.statusCode,
    body: resBody
  };
}

/**
 * Garante a existência da aba Documentos na planilha com o cabeçalho correto.
 */
async function ensureDocumentosSheet(dependencies = {}) {
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tabName = CONFIG.SHEETS.TABS.DOCUMENTOS || 'Documentos';
  const meta = await (dependencies.getSpreadsheetMetadata || getSpreadsheetMetadata)(spreadsheetId);
  const exists = (meta.sheets || []).some(s =>
    (s.properties?.title || '').toLowerCase() === tabName.toLowerCase()
  );

  if (!exists) {
    await (dependencies.createSheetIfNotExists || createSheetIfNotExists)(spreadsheetId, tabName);
    const append = dependencies.appendSheetValues || appendSheetValues;
    await append(spreadsheetId, `${tabName}!A1:K1`, [
      ['request_id', 'item_index', 'rps_numero', 'nfse_numero', 'tipo', 'source', 'drive_file_id', 'sha256', 'status', 'created_at', 'error']
    ]);
  }
}

/**
 * Busca documento NFS-e oficial via ConsultarNfsePorRps exclusivamente,
 * preserva os bytes oficiais recebidos, calcula SHA-256 e armazena no Drive e Sheets via Callback Autenticado.
 */
async function fetchOfficialNfseDocument({
  requestId,
  itemIndex = 1,
  environment = 'production',
  certData = null,
  dryRun = false
}, dependencies = {}) {
  if (!certData || !certData.loaded || !certData.isValid) {
    throw new Error('CERT_INVALID: fetch_document requer certificado A1 válido.');
  }
  if (!requestId) {
    throw new Error('REQUEST_ID_REQUIRED: fetch_document requer parâmetro request_id.');
  }

  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const read = dependencies.readSheetValues || readSheetValues;
  const tabName = CONFIG.SHEETS.TABS.DOCUMENTOS || 'Documentos';

  // 1. Resolver RPS pelo ledger usando request_id + item_index
  await (dependencies.ensureLedgerSheet || ensureLedgerSheet)(dependencies);
  const ledgerEntries = await (dependencies.loadLedger || loadLedger)(dependencies);
  const ledgerEntry = findLedgerEntry(ledgerEntries, { environment, requestId, itemIndex });

  if (!ledgerEntry || !ledgerEntry.rps_numero) {
    throw new Error(`RPS_NOT_FOUND_FOR_DEMAND: Nenhum RPS resolvido no Ledger para request_id=${requestId}, item_index=${itemIndex}`);
  }

  const targetRpsNum = ledgerEntry.rps_numero;
  const targetRpsSer = ledgerEntry.rps_serie;
  const targetRpsTip = ledgerEntry.rps_tipo;

  // Idempotência estrita: se já estiver READY com ID válido, não reprocessa
  if (!dryRun) {
    await ensureDocumentosSheet(dependencies);
    const existingRows = await read(spreadsheetId, `${tabName}!A:K`);
    for (let idx = 1; idx < (existingRows || []).length; idx++) {
      const row = existingRows[idx];
      if (
        String(row[0] || '').trim() === String(requestId).trim() &&
        String(row[1] || '1').trim() === String(itemIndex).trim() &&
        String(row[4] || '').trim() === 'NFSE_XML' &&
        String(row[8] || '').trim() === 'READY' &&
        String(row[6] || '').trim() &&
        !String(row[6]).startsWith('OFFICIAL_BYTES_VALIDATED_')
      ) {
        return {
          success: true,
          status: 'ALREADY_READY',
          operation: 'fetch_document',
          environment,
          requestId,
          itemIndex,
          rpsNumero: String(row[2] || targetRpsNum),
          nfseNumero: String(row[3] || ''),
          driveFileId: String(row[6]),
          sha256: String(row[7] || ''),
          source: 'CONSULTAR_NFSE_POR_RPS',
          idempotentReplay: true
        };
      }
    }
  }

  // 2. Chamada estrita e exclusiva a ConsultarNfsePorRps
  const consultarRpsXml = buildConsultarNfsePorRpsEnvio({
    rpsNumero: targetRpsNum,
    rpsSerie: targetRpsSer,
    rpsTipo: targetRpsTip
  });

  const soapCall = dependencies.callSoapOperation || callSoapOperation;
  const queryRes = await soapCall({
    environment,
    operation: 'ConsultarNfsePorRps',
    cabecMsg: buildCabecalho(),
    dadosMsg: consultarRpsXml,
    certData
  });

  if (!queryRes || (!queryRes.outputXml && !queryRes.outputXmlBytes)) {
    throw new Error('CONSULTAR_NFSE_POR_RPS_EMPTY_RESPONSE: Provedor retornou resposta vazia.');
  }

  // 3. Salvar os BYTES OFICIAIS sem parse->rebuild
  const rawOfficialBytes = Buffer.isBuffer(queryRes.outputXmlBytes)
    ? Buffer.from(queryRes.outputXmlBytes)
    : Buffer.from(queryRes.outputXml, 'utf8');
  const officialXml = rawOfficialBytes.toString('utf8');
  const sha256 = crypto.createHash('sha256').update(rawOfficialBytes).digest('hex');

  // 4. Parse da resposta apenas para extração de metadados e validação
  const parsed = parseConsultarNfseResposta(officialXml);
  if (!parsed.notas || parsed.notas.length === 0) {
    const errorMsg = (parsed.mensagens && parsed.mensagens.map(m => `[${m.codigo}] ${m.mensagem}`).join('; ')) || 'NFS-e não encontrada na resposta do provedor';
    throw new Error(`OFFICIAL_NFSE_NOT_FOUND: ${errorMsg}`);
  }

  const nota = parsed.notas[0];
  const nfseNumero = String(nota.numero || '').trim();
  const codigoVerificacao = String(nota.codigoVerificacao || '').trim();

  // Validação estrita dos dados oficiais
  if (!nfseNumero) {
    throw new Error('OFFICIAL_NFSE_MISSING_NUMBER: Número da NFS-e ausente na resposta oficial.');
  }

  const fileName = `NFSE-${nfseNumero}-DEXMED-${codigoVerificacao || 'OFFICIAL'}-OFFICIAL.xml`;

  if (dryRun) {
    return {
      status: 'DRY_RUN_SUCCESS',
      operation: 'fetch_document',
      environment,
      requestId,
      itemIndex,
      rpsNumero: targetRpsNum,
      nfseNumero,
      codigoVerificacao,
      cnpjTomador: nota.cnpjTomador,
      valorServicos: nota.valorServicos,
      sha256,
      fileName,
      dryRun: true
    };
  }

  // 5. Armazenamento do Documento Oficial
  // Prioridade: Callback Autenticado Apps Script -> DriveApp (User Quota)
  const callbackUrl = dependencies.callbackUrl || process.env.NFSE_DOCUMENT_CALLBACK_URL || CONFIG.CALLBACK?.URL;
  const callbackSecret = dependencies.callbackSecret || process.env.NFSE_DOCUMENT_CALLBACK_SECRET || CONFIG.CALLBACK?.SECRET;

  let driveFileId = '';
  let callbackResult = null;

  if (callbackUrl && callbackSecret) {
    try {
      const cbRes = await (dependencies.sendOfficialDocumentCallback || sendOfficialDocumentCallback)({
        callbackUrl,
        callbackSecret,
        requestId,
        itemIndex,
        rpsNumero: targetRpsNum,
        nfseNumero,
        codigoVerificacao,
        rawOfficialBytes,
        sha256,
        fileName
      }, dependencies);

      if (!cbRes || !cbRes.body || !cbRes.body.ok || cbRes.body.status !== 'READY' || !cbRes.body.drive_file_id) {
        const errMsg = (cbRes && cbRes.body && cbRes.body.error) || `CALLBACK_INVALID_RESPONSE: Status ${cbRes?.statusCode}`;
        throw new Error(errMsg);
      }

      if (cbRes.body.sha256 && cbRes.body.sha256.toLowerCase() !== sha256.toLowerCase()) {
        throw new Error(`SHA_CALLBACK_MISMATCH: Provedor ${sha256} != Callback ${cbRes.body.sha256}`);
      }

      driveFileId = cbRes.body.drive_file_id;
      callbackResult = cbRes.body;
    } catch (cbErr) {
      const errorText = `DRIVE_CALLBACK_FAILED: ${String(cbErr.message || cbErr).slice(0, 300)}`;
      let recoveryArtifact = null;
      try {
        recoveryArtifact = await (dependencies.persistOfficialRecoveryArtifact || persistOfficialRecoveryArtifact)({
          buffer: rawOfficialBytes,
          fileName,
          metadata: {
            request_id: String(requestId),
            item_index: String(itemIndex),
            rps_numero: String(targetRpsNum),
            nfse_numero: String(nfseNumero),
            codigo_verificacao: String(codigoVerificacao),
            source: 'CONSULTAR_NFSE_POR_RPS',
            sha256
          }
        });
      } catch (artifactErr) {
        console.log('[WARN] Falha ao preservar artefato documental de recuperação: ' + artifactErr.message);
      }

      const docRowsOnError = await read(spreadsheetId, `${tabName}!A:K`);
      let errorRowIndex = -1;
      for (let idx = 1; idx < (docRowsOnError || []).length; idx++) {
        const row = docRowsOnError[idx];
        if (String(row[0] || '').trim() === String(requestId).trim() &&
            String(row[1] || '1').trim() === String(itemIndex).trim() &&
            String(row[4] || '').trim() === 'NFSE_XML') {
          errorRowIndex = idx + 1;
          break;
        }
      }
      const errorRow = [
        requestId, String(itemIndex), String(targetRpsNum), String(nfseNumero),
        'NFSE_XML', 'CONSULTAR_NFSE_POR_RPS', '', sha256, 'ERROR',
        new Date().toISOString(), errorText + (recoveryArtifact ? ' | RECOVERY_ARTIFACT_AVAILABLE' : '')
      ];
      if (errorRowIndex > 0) {
        await (dependencies.updateSheetValues || updateSheetValues)(spreadsheetId, `${tabName}!A${errorRowIndex}:K${errorRowIndex}`, [errorRow]);
      } else {
        await (dependencies.appendSheetValues || appendSheetValues)(spreadsheetId, `${tabName}!A:K`, [errorRow]);
      }
      throw new Error(errorText);
    }
  } else {
    // Fallback apenas para uploadDriveBuffer direto caso não haja callback configurado
    const upload = dependencies.uploadDriveBuffer || uploadDriveBuffer;
    const folderId = CONFIG.DRIVE.FOLDER_ID || '16Dw9pUbpv_ViCP6a2MAgUbW1h37t3859';
    try {
      const driveFile = await upload(rawOfficialBytes, fileName, 'application/xml', folderId);
      driveFileId = driveFile && driveFile.id;
      if (!driveFileId) throw new Error('DRIVE_UPLOAD_MISSING_FILE_ID');
    } catch (driveErr) {
      const errorText = `DRIVE_UPLOAD_FAILED: ${String(driveErr.message || driveErr).slice(0, 300)}`;
      let recoveryArtifact = null;
      try {
        recoveryArtifact = await (dependencies.persistOfficialRecoveryArtifact || persistOfficialRecoveryArtifact)({
          buffer: rawOfficialBytes,
          fileName,
          metadata: {
            request_id: String(requestId),
            item_index: String(itemIndex),
            rps_numero: String(targetRpsNum),
            nfse_numero: String(nfseNumero),
            codigo_verificacao: String(codigoVerificacao),
            source: 'CONSULTAR_NFSE_POR_RPS',
            sha256
          }
        });
      } catch (artifactErr) {
        console.log('[WARN] Falha ao preservar artefato documental de recuperação: ' + artifactErr.message);
      }
      const docRowsOnError = await read(spreadsheetId, `${tabName}!A:K`);
      let errorRowIndex = -1;
      for (let idx = 1; idx < (docRowsOnError || []).length; idx++) {
        const row = docRowsOnError[idx];
        if (String(row[0] || '').trim() === String(requestId).trim() &&
            String(row[1] || '1').trim() === String(itemIndex).trim() &&
            String(row[4] || '').trim() === 'NFSE_XML') {
          errorRowIndex = idx + 1;
          break;
        }
      }
      const errorRow = [
        requestId, String(itemIndex), String(targetRpsNum), String(nfseNumero),
        'NFSE_XML', 'CONSULTAR_NFSE_POR_RPS', '', sha256, 'ERROR',
        new Date().toISOString(), errorText + (recoveryArtifact ? ' | RECOVERY_ARTIFACT_AVAILABLE' : '')
      ];
      if (errorRowIndex > 0) {
        await (dependencies.updateSheetValues || updateSheetValues)(spreadsheetId, `${tabName}!A${errorRowIndex}:K${errorRowIndex}`, [errorRow]);
      } else {
        await (dependencies.appendSheetValues || appendSheetValues)(spreadsheetId, `${tabName}!A:K`, [errorRow]);
      }
      throw new Error(errorText);
    }
  }

  // 6. Se o callback já gravou na aba Documentos e Demandas, apenas confirma;
  // Caso contrário, persiste diretamente na planilha
  if (!callbackResult) {
    const docRows = await read(spreadsheetId, `${tabName}!A:K`);
    let existingRowIndex = -1;

    if (docRows && docRows.length > 1) {
      for (let idx = 1; idx < docRows.length; idx++) {
        const r = docRows[idx];
        const rReqId = String(r[0] || '').trim();
        const rItemIdx = String(r[1] || '1').trim();
        const rTipo = String(r[4] || '').trim();
        if (rReqId === String(requestId).trim() && rItemIdx === String(itemIndex).trim() && rTipo === 'NFSE_XML') {
          existingRowIndex = idx + 1; // 1-based row index
          break;
        }
      }
    }

    const nowIso = new Date().toISOString();
    const docDataRow = [
      requestId,
      String(itemIndex),
      String(targetRpsNum),
      String(nfseNumero),
      'NFSE_XML',
      'CONSULTAR_NFSE_POR_RPS',
      driveFileId,
      sha256,
      'READY',
      nowIso,
      ''
    ];

    if (existingRowIndex > 0) {
      const update = dependencies.updateSheetValues || updateSheetValues;
      await update(spreadsheetId, `${tabName}!A${existingRowIndex}:K${existingRowIndex}`, [docDataRow]);
    } else {
      const append = dependencies.appendSheetValues || appendSheetValues;
      await append(spreadsheetId, `${tabName}!A:K`, [docDataRow]);
    }

    // 7. Atualizar Demandas se encontrada
    try {
      const demandasRows = await read(spreadsheetId, `${CONFIG.SHEETS.TABS.DEMANDAS}!A:O`);
      if (demandasRows && demandasRows.length > 1) {
        for (let dIdx = 1; dIdx < demandasRows.length; dIdx++) {
          const dRow = demandasRows[dIdx];
          if (String(dRow[2] || '').trim() === String(requestId).trim()) {
            const dRowIndex = dIdx + 1;
            const update = dependencies.updateSheetValues || updateSheetValues;
            await update(spreadsheetId, `${CONFIG.SHEETS.TABS.DEMANDAS}!M${dRowIndex}:N${dRowIndex}`, [
              ['DOCUMENTS_READY', nowIso]
            ]);
            break;
          }
        }
      }
    } catch (eDem) {
      console.log('[WARN] Falha ao atualizar estado na aba Demandas: ' + eDem.message);
    }
  }

  return {
    success: true,
    status: 'SUCCESS',
    operation: 'fetch_document',
    environment,
    requestId,
    itemIndex,
    rpsNumero: targetRpsNum,
    nfseNumero,
    codigoVerificacao,
    cnpjTomador: nota.cnpjTomador,
    valorServicos: nota.valorServicos,
    driveFileId,
    sha256,
    source: 'CONSULTAR_NFSE_POR_RPS',
    fileName,
    bufferSize: rawOfficialBytes.length,
    callbackExecuted: !!callbackResult
  };
}

module.exports = {
  ensureDocumentosSheet,
  fetchOfficialNfseDocument,
  sendOfficialDocumentCallback,
  persistOfficialRecoveryArtifact
};
