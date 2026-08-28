'use strict';

const crypto = require('crypto');
const { CONFIG } = require('./config');
const { readSheetValues, appendSheetValues, updateSheetValues, getSpreadsheetMetadata, createSheetIfNotExists, uploadDriveBuffer } = require('./google');
const { ensureLedgerSheet, loadLedger, findLedgerEntry } = require('./ledger');
const { buildCabecalho, parseConsultarNfseResposta } = require('./abrasf');
const { callSoapOperation } = require('./soap');
const { buildConsultarNfsePorRpsEnvio } = require('./issue');

/**
 * Garante a existência da aba Documentos na planilha com o cabeçalho correto.
 */
async function ensureDocumentosSheet(dependencies = {}) {
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tabName = CONFIG.SHEETS.TABS.DOCUMENTOS || 'Documentos';
  const meta = await (dependencies.getSpreadsheetMetadata || getSpreadsheetMetadata)(spreadsheetId);
  const exists = (meta.sheets || []).some(s => {
    const title = (s.properties?.title || '').toLowerCase();
    return title === tabName.toLowerCase() || title === 'documentos' || title === 'documentos nfs-e';
  });

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
 * preserva os bytes oficiais recebidos, calcula SHA-256 e armazena no Drive e Sheets.
 */
async function fetchOfficialNfseDocument({
  requestId,
  itemIndex = 1,
  environment = 'production',
  fromNumber = null,
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

  const targetRpsNum = ledgerEntry ? ledgerEntry.rps_numero : (fromNumber || null);
  const targetRpsSer = ledgerEntry ? ledgerEntry.rps_serie : 'A';
  const targetRpsTip = ledgerEntry ? ledgerEntry.rps_tipo : '1';

  if (!targetRpsNum) {
    throw new Error(`RPS_NOT_FOUND_FOR_DEMAND: Nenhum RPS resolvido no Ledger para request_id=${requestId}, item_index=${itemIndex}`);
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

  if (!queryRes || !queryRes.outputXml) {
    throw new Error('CONSULTAR_NFSE_POR_RPS_EMPTY_RESPONSE: Provedor retornou resposta vazia.');
  }

  // 3. Salvar os BYTES OFICIAIS sem parse->rebuild
  const rawOfficialBytes = Buffer.from(queryRes.outputXml, 'utf8');
  const sha256 = crypto.createHash('sha256').update(rawOfficialBytes).digest('hex');

  // 4. Parse da resposta apenas para extração de metadados e validação
  const parsed = parseConsultarNfseResposta(queryRes.outputXml);
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

  // 5. Upload do buffer oficial para o Drive
  const upload = dependencies.uploadDriveBuffer || uploadDriveBuffer;
  const folderId = CONFIG.DRIVE.FOLDER_ID || '16Dw9pUbpv_ViCP6a2MAgUbW1h37t3859';
  const driveFile = await upload(rawOfficialBytes, fileName, 'application/xml', folderId);
  const driveFileId = driveFile.id;

  // 6. Persistência idempotente na aba Documentos
  await ensureDocumentosSheet(dependencies);
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
          // Col M (13) = DOCUMENTS_READY, Col N (14) = Timestamp
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
    bufferSize: rawOfficialBytes.length
  };
}

module.exports = {
  ensureDocumentosSheet,
  fetchOfficialNfseDocument
};
