'use strict';

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const pdfParse = require('pdf-parse');

const CONTROL_SPREADSHEET_ID = process.env.CONTROL_SPREADSHEET_ID || '1UHIo_2GiwIr4847y_AsPX3ZQHujaUOMkD-EE0uBEJcs';
const CONTROL_SHEET_NAME = process.env.CONTROL_SHEET_NAME || 'CNDs';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

function normaliza(v = '') {
  return String(v)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function digits(v = '') {
  return String(v).replace(/\D/g, '');
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function parseBrDate(v = '') {
  const m = String(v).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12)) : null;
}

function isoDate(d) {
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

function daysUntil(d) {
  if (!d) return null;
  const n = new Date();
  const t = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 12));
  return Math.ceil((d.getTime() - t.getTime()) / 86400000);
}

function folderId(v = '') {
  const s = String(v).trim();
  if (/^[\w-]{20,}$/.test(s)) return s;
  const m = s.match(/\/folders\/([\w-]+)/);
  if (!m) throw new Error('DRIVE_FOLDER_ID inválido');
  return m[1];
}

function auth() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Secret ausente: GOOGLE_SERVICE_ACCOUNT_JSON');
  let credentials;
  try {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON não é JSON válido');
  }
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets']
  });
}

async function getControlRow(cnpj) {
  const a = auth();
  const sheets = google.sheets({ version: 'v4', auth: a });
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: CONTROL_SPREADSHEET_ID,
    range: `${CONTROL_SHEET_NAME}!A1:P200`
  });
  const rows = r.data.values || [];
  const target = digits(cnpj);

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const hasCnpj = row.some(cell => digits(cell) === target);
    const rowText = row.map(normaliza).join(' ');
    const isMunicipal = rowText.includes('municipal') || rowText.includes('ipatinga');

    if (hasCnpj && isMunicipal) {
      return {
        sheets,
        rowNumber: i + 1,
        spreadsheetId: CONTROL_SPREADSHEET_ID,
        sheetName: CONTROL_SHEET_NAME,
        values: row,
        validade: row[5] || '',
        status: row[6] || ''
      };
    }
  }
  throw new Error('Linha CND Municipal da DEXMED não encontrada na planilha');
}

function gate(row, force = false) {
  if (force) return { shouldRun: true, reason: 'Execução manual forçada' };
  const d = parseBrDate(row.validade);
  if (!d) return { shouldRun: true, reason: 'Validade ausente/inválida' };
  const left = daysUntil(d);
  if (left <= 15) return { shouldRun: true, reason: `Janela de renovação: ${left} dia(s) restantes`, days: left };
  return { shouldRun: false, reason: `Ainda válida por ${left} dia(s); fora da janela de 15 dias`, days: left };
}

async function readImageGemini(buffer, maxAttempts = 3) {
  const key = process.env.GEMINI_KEY;
  if (!key) throw new Error('Secret ausente: GEMINI_KEY');
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(key)}`;
  let last = '';

  for (let i = 1; i <= maxAttempts; i++) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: 'Você é um especialista em OCR de alta precisão para captchas numéricos da Prefeitura de Ipatinga. A imagem contém EXATAMENTE 4 dígitos numéricos (apenas algarismos de 0 a 9). Não há letras. Desconsidere ruídos, pontilhados, linhas de interferência e variações de tamanho de fonte entre os dígitos. Identifique atentamente os 4 números da esquerda para a direita e retorne EXCLUSIVAMENTE os 4 dígitos numéricos (ex: 8483), sem espaços, letras, pontuações ou explicações.' },
            { inline_data: { mime_type: 'image/png', data: buffer.toString('base64') } }
          ]
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 16 }
      })
    });

    const txt = await res.text();
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${txt.slice(0, 300)}`);
    const data = JSON.parse(txt);
    last = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    
    // Normalização e correção de caracteres comuns confundidos pelo OCR
    let code = last.trim();
    const charMap = { 'O': '0', 'o': '0', 'D': '0', 'I': '1', 'i': '1', 'l': '1', '|': '1', 'Z': '2', 'z': '2', 'S': '5', 's': '5', 'G': '6', 'b': '6', 'B': '8' };
    code = code.split('').map(c => charMap[c] || c).join('');
    code = code.replace(/[^0-9]/g, '').trim();

    if (/^[0-9]{4}$/.test(code)) return { code, attempt: i };
  }
  throw new Error(`Gemini não retornou 4 dígitos numéricos válidos. Última resposta: ${last}`);
}

async function sendBark({ title, body, level = 'timeSensitive', url = null, call = 0 }) {
  const key = process.env.BARK_KEY;
  if (!key) throw new Error('Secret ausente: BARK_KEY');
  const res = await fetch(`https://api.day.app/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ title, body, group: 'CND Municipal Ipatinga', level, call, ...(url ? { url } : {}) })
  });
  if (!res.ok) throw new Error(`Bark HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function sendEmail({ subject, text, attachmentPath = null }) {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  const to = process.env.ALERT_EMAIL;
  if (!user || !pass || !to) throw new Error('Secrets SMTP_USER/SMTP_PASSWORD/ALERT_EMAIL ausentes');

  const tr = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  await tr.sendMail({
    from: `"Monitor CND Ipatinga" <${user}>`,
    to,
    subject,
    text,
    attachments: attachmentPath ? [{ filename: path.basename(attachmentPath), path: attachmentPath }] : []
  });
}

async function pdfText(file) {
  const parsed = await pdfParse(fs.readFileSync(file));
  return parsed.text || '';
}

function extractCert(text) {
  const s = String(text).replace(/\s+/g, ' ');
  const n = s.match(/(?:N[ºo°]?|n[uú]mero)\s*:?\s*(\d+)\s*\/\s*(\d{4})/i);
  const v = s.match(/(?:VALIDADE\s+AT[ÉE]|V[AÁ]LIDA\s+AT[ÉE](?:\s+O\s+DIA)?|VALIDADE)\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i);
  const c = s.match(/(?:C[oó]digo\s+de\s+Controle(?:\s+da\s+Certid[aã]o)?(?:\/N[uú]mero)?|C[oó]digo\s+de\s+Autenticidade|Chave(?:\s+de\s+Autentica[cç][aã]o)?)\s*:?\s*([A-Za-z0-9.-]+)/i);
  return {
    numero: n ? `${n[1]}/${n[2]}` : null,
    validade: v ? v[1] : null,
    codigoControle: c ? c[1] : null
  };
}

function validateCert(text, cnpj) {
  const n = normaliza(text);
  const d = digits(text);
  const failed = [];
  if (!d.includes(digits(cnpj))) failed.push('CNPJ');
  if (!n.includes('dexmed')) failed.push('razão social (DEXMED)');
  if (!(n.includes('negativa') || n.includes('nao possui debitos') || n.includes('certidao'))) failed.push('negativa');
  if (!n.includes('ipatinga')) failed.push('Ipatinga');
  if (failed.length) throw new Error(`PDF não passou na validação: ${failed.join(', ')}`);
}

async function uploadPdf(file, folder) {
  const a = auth();
  const drive = google.drive({ version: 'v3', auth: a });
  return (await drive.files.create({
    requestBody: { name: path.basename(file), parents: [folderId(folder)] },
    media: { mimeType: 'application/pdf', body: fs.createReadStream(file) },
    fields: 'id,name,webViewLink'
  })).data;
}

async function updateControl(rowInfo, { emissao, validade, driveFile, numero, codigoControle, result }) {
  const url = driveFile.webViewLink || `https://drive.google.com/file/d/${driveFile.id}/view`;
  const values = [[
    emissao,
    validade,
    'VÁLIDA',
    `=HYPERLINK("${url}";"Abrir PDF")`,
    driveFile.id,
    [numero ? `Nº ${numero}` : null, codigoControle].filter(Boolean).join(' | '),
    'Negativa de débitos de tributos municipais; renovada automaticamente.',
    'https://ipatinga.meumunicipio.online/tributario/servlet/hwpcgeracertidaonegativa',
    'SIM — ≤15d',
    'GitHub Actions + Playwright + Gemini',
    new Date().toISOString(),
    result
  ]];
  await rowInfo.sheets.spreadsheets.values.update({
    spreadsheetId: rowInfo.spreadsheetId,
    range: `${rowInfo.sheetName}!E${rowInfo.rowNumber}:P${rowInfo.rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values }
  });
  return url;
}

function ghOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  else console.log(`${name}=${value}`);
}

function runUrl() {
  return process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;
}

function saveReport(report, dir) {
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'run-summary.json'), JSON.stringify(report, null, 2));
  const l = [
    '# CND Municipal Ipatinga — resumo',
    '',
    `- **Timestamp:** ${report.timestamp}`,
    `- **Status:** ${report.status}`,
    `- **Modo:** ${report.mode}`,
    `- **Renovação necessária:** ${report.shouldRun ? 'SIM' : 'NÃO'}`,
    `- **Motivo:** ${report.reason || ''}`,
    `- **Validade atual:** ${report.currentValidity || ''}`,
    `- **Imagem lida:** ${report.imageRecognized ? 'SIM' : 'NÃO'}`,
    `- **Pesquisa concluída:** ${report.searchOk ? 'SIM' : 'NÃO'}`,
    `- **Certidão gerada:** ${report.generated ? 'SIM' : 'NÃO'}`,
    `- **PDF validado:** ${report.pdfValidated ? 'SIM' : 'NÃO'}`,
    `- **Drive:** ${report.driveUrl || 'não enviado'}`,
    `- **Bark:** ${report.alerts?.bark || 'não executado'}`,
    `- **E-mail:** ${report.alerts?.email || 'não executado'}`
  ];
  if (report.newCertificate) {
    l.push(
      '',
      '## Nova certidão',
      '',
      `- **Número:** ${report.newCertificate.numero || ''}`,
      `- **Emissão:** ${report.newCertificate.emissao || ''}`,
      `- **Validade:** ${report.newCertificate.validade || ''}`,
      `- **Código:** ${report.newCertificate.codigoControle || ''}`
    );
  }
  if (report.error) {
    l.push('', '## Erro', '', '```text', report.error, '```');
  }
  fs.writeFileSync(path.join(dir, 'run-summary.md'), l.join('\n'));
}

async function alerts(report, success, attachmentPath = null) {
  const certificate = report.newCertificate || {};
  const title = success ? 'CND Municipal renovada' : 'Falha na CND Municipal';
  const body = success
    ? `Certidão ${certificate.numero || ''} — validade ${certificate.validade || ''}`
    : `A execução falhou: ${report.error || 'erro não informado'}`;

  try {
    await sendBark({ title, body, level: success ? 'timeSensitive' : 'active', url: report.driveUrl || runUrl() });
    report.alerts.bark = 'SENT';
  } catch (error) {
    report.alerts.bark = `FAILED: ${error.message}`;
  }

  try {
    await sendEmail({
      subject: title,
      text: `${body}\n\nRelatório: ${runUrl() || 'execução local'}`,
      attachmentPath
    });
    report.alerts.email = 'SENT';
  } catch (error) {
    report.alerts.email = `FAILED: ${error.message}`;
  }
}

module.exports = {
  normaliza,
  digits,
  ensureDir,
  parseBrDate,
  isoDate,
  getControlRow,
  gate,
  readImageGemini,
  sendBark,
  sendEmail,
  pdfText,
  extractCert,
  validateCert,
  uploadPdf,
  updateControl,
  alerts,
  ghOutput,
  runUrl,
  saveReport
};
