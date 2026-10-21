'use strict';

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SPREADSHEET_ID = '1UHIo_2GiwIr4847y_AsPX3ZQHujaUOMkD-EE0uBEJcs';
const SHEET_NAME = 'CNDs';
const FILE_ID = '1IoRMVuhOpXMKutLVmfOMQQB0yeY__cbV';
const FOLDER_ID = '16Dw9pUbpv_ViCP6a2MAgUbW1h37t3859';
const PDF_NAME = 'DEXMED - Certidao Falencia Concordata TJMG - validade 2027-01-21.pdf';

function getAuth() {
  const sa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!sa) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON missing');
  return new google.auth.GoogleAuth({
    credentials: JSON.parse(sa),
    scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets']
  });
}

async function run() {
  const authClient = getAuth();
  const drive = google.drive({ version: 'v3', auth: authClient });
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  const pdfPath = path.resolve(__dirname, 'falencia.pdf');
  if (!fs.existsSync(pdfPath)) {
    throw new Error('falencia.pdf not found at ' + pdfPath);
  }

  console.log('[1/3] Atualizando arquivo no Google Drive...');
  let driveFileId = FILE_ID;
  try {
    const updateRes = await drive.files.update({
      fileId: FILE_ID,
      requestBody: { name: PDF_NAME },
      media: { mimeType: 'application/pdf', body: fs.createReadStream(pdfPath) },
      fields: 'id, name, webViewLink',
      supportsAllDrives: true
    });
    console.log(`[Drive] Arquivo existente atualizado in-place: ${updateRes.data.name} (${updateRes.data.id})`);
    driveFileId = updateRes.data.id;
  } catch (err) {
    console.warn(`[Drive] In-place update failed (${err.message}), criando novo arquivo na pasta...`);
    const createRes = await drive.files.create({
      requestBody: { name: PDF_NAME, parents: [FOLDER_ID] },
      media: { mimeType: 'application/pdf', body: fs.createReadStream(pdfPath) },
      fields: 'id, name, webViewLink',
      supportsAllDrives: true
    });
    console.log(`[Drive] Novo arquivo criado: ${createRes.data.name} (${createRes.data.id})`);
    driveFileId = createRes.data.id;
  }

  console.log('[2/3] Localizando linha da Certidão Falência/Concordata na planilha...');
  const range = `${SHEET_NAME}!A1:P20`;
  const getRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const rows = getRes.data.values || [];

  let targetRow = -1;
  for (let i = 1; i < rows.length; i++) {
    const tipo = String(rows[i][2] || '').toLowerCase();
    if (tipo.includes('falência') || tipo.includes('falencia')) {
      targetRow = i + 1; // 1-indexed
      break;
    }
  }

  if (targetRow === -1) {
    throw new Error('Linha Falência/Concordata não encontrada na aba CNDs');
  }
  console.log(`[Sheets] Linha encontrada: ${targetRow}`);

  console.log('[3/3] Atualizando dados na planilha CNDs...');
  const fileUrl = `https://drive.google.com/file/d/${driveFileId}/view`;
  const now = new Date();
  const formatIso = d => d.toISOString().slice(0, 10);

  // Colunas: E=Emissão, F=Validade, G=Status (fórmula), H=Arquivo (fórmula), I=ID Drive, J=Controle, K=Observações, N=Provedor, O=Última tentativa, P=Resultado
  const updateRange = `${SHEET_NAME}!E${targetRow}:P${targetRow}`;
  const values = [[
    '21/10/2026',
    '21/01/2027',
    `=IF(F${targetRow}="";"";IF(F${targetRow}<TODAY();"VENCIDA";IF(F${targetRow}<=TODAY()+15;"VENCE ≤15d";"VÁLIDA")))`,
    `=HYPERLINK("${fileUrl}";"Abrir PDF")`,
    driveFileId,
    '2610-2120-2700-0673-4664',
    'Certidão Cível de Falência e Concordata Negativa emitida via TJMG RUPE em 21/10/2026 às 20:27, válida por 3 meses.',
    '',
    '',
    'TJMG RUPE Oficial',
    '21/10/2026 20:27',
    'Emitida com sucesso'
  ]];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: updateRange,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values }
  });

  console.log('✅ Planilha e Google Drive atualizados com sucesso!');
}

run().catch(err => {
  console.error('❌ Falha:', err);
  process.exit(1);
});
