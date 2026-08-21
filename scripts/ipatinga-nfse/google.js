'use strict';

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { CONFIG } = require('./config');

let authClient = null;

function getAuth() {
  if (authClient) return authClient;

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON não configurado no ambiente.');
  }

  let credentials;
  try {
    credentials = JSON.parse(saJson);
  } catch (err) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON inválido ou corrompido: ' + err.message);
  }

  authClient = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file'
    ]
  });

  return authClient;
}

function getSheetsClient() {
  const auth = getAuth();
  return google.sheets({ version: 'v4', auth });
}

function getDriveClient() {
  const auth = getAuth();
  return google.drive({ version: 'v3', auth });
}

/**
 * Baixa arquivo do Google Drive para buffer ou caminho temporário
 */
async function downloadDriveFile(fileId, destinationPath = null) {
  if (!fileId) throw new Error('File ID do Drive não fornecido.');
  const drive = getDriveClient();

  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: destinationPath ? 'stream' : 'arraybuffer' }
  );

  if (destinationPath) {
    return new Promise((resolve, reject) => {
      const dest = fs.createWriteStream(destinationPath);
      res.data
        .on('end', () => resolve(destinationPath))
        .on('error', err => reject(err))
        .pipe(dest);
    });
  }

  return Buffer.from(res.data);
}

/**
 * Obtém metadados de um arquivo do Google Drive
 */
async function getDriveFileMetadata(fileId) {
  if (!fileId) throw new Error('File ID do Drive não fornecido.');
  const drive = getDriveClient();
  const res = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size, modifiedTime, createdTime'
  });
  return res.data;
}

/**
 * Lê dados de uma aba da planilha
 */
async function readSheetValues(spreadsheetId, range) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  });
  return res.data.values || [];
}

/**
 * Atualiza dados em uma aba da planilha
 */
async function updateSheetValues(spreadsheetId, range, values, valueInputOption = 'USER_ENTERED') {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption,
    requestBody: { values }
  });
  return res.data;
}

/**
 * Acrescenta linhas no final da aba
 */
async function appendSheetValues(spreadsheetId, range, values, valueInputOption = 'USER_ENTERED') {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption,
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });
  return res.data;
}

/**
 * Executa múltiplos updates em lote (batchUpdate)
 */
async function batchUpdateSheetValues(spreadsheetId, data, valueInputOption = 'USER_ENTERED') {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption,
      data
    }
  });
  return res.data;
}

module.exports = {
  getAuth,
  getSheetsClient,
  getDriveClient,
  downloadDriveFile,
  getDriveFileMetadata,
  readSheetValues,
  updateSheetValues,
  appendSheetValues,
  batchUpdateSheetValues
};
