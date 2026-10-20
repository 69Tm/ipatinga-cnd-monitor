'use strict';

// Gate REST sem dependências: falha de leitura nunca significa ledger vazio.
const crypto = require('node:crypto');
const fs = require('node:fs');

const ELIGIBLE = new Set(['PROVIDER_INFRA_UNAVAILABLE', 'SUBMITTED_ASYNC_PROCESSING', 'UNKNOWN_AFTER_TIMEOUT']);
const HEADERS = ['environment', 'request_id', 'item_index', 'rps_numero', 'rps_serie', 'rps_tipo', 'status'];

function countPending(rows) {
  if (!Array.isArray(rows) || !Array.isArray(rows[0]) ||
      HEADERS.some((header, index) => rows[0][index] !== header)) {
    throw new Error('RPS_SCHEMA_INVALID');
  }
  let count = 0;
  for (const row of rows.slice(1)) {
    if (!Array.isArray(row)) throw new Error('RPS_SCHEMA_INVALID');
    if (String(row[0] || '').trim().toLowerCase() === 'production' &&
        ELIGIBLE.has(String(row[6] || '').trim())) count++;
  }
  return count;
}

async function readJson(fetchImpl, url, options, stage) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(30000) });
  } catch (_) {
    throw new Error(stage + '_TRANSPORT_ERROR');
  }
  if (!response.ok) throw new Error(stage + '_HTTP_ERROR');
  try {
    return await response.json();
  } catch (_) {
    throw new Error(stage + '_JSON_INVALID');
  }
}

async function checkPending(env = process.env, fetchImpl = fetch) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_CREDENTIALS_MISSING');
  if (!env.NFE_SPREADSHEET_ID) throw new Error('NFE_SPREADSHEET_ID_MISSING');
  let sa;
  let jwt;
  try {
    sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (!sa.client_email || !sa.private_key) throw new Error();
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claim = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
      aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now
    })).toString('base64url');
    const unsigned = header + '.' + claim;
    jwt = unsigned + '.' + crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');
  } catch (_) {
    throw new Error('GOOGLE_CREDENTIALS_INVALID');
  }
  const token = await readJson(fetchImpl, 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString()
  }, 'GOOGLE_TOKEN');
  if (!token || typeof token.access_token !== 'string' || !token.access_token) {
    throw new Error('GOOGLE_TOKEN_INVALID');
  }
  const sheet = await readJson(fetchImpl,
    'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(env.NFE_SPREADSHEET_ID) + '/values/RPS!A:G',
    { headers: { Authorization: 'Bearer ' + token.access_token } }, 'GOOGLE_SHEETS');
  return countPending(sheet && sheet.values);
}

async function run(env = process.env, fetchImpl = fetch, write = fs.appendFileSync) {
  if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT_MISSING');
  const count = await checkPending(env, fetchImpl);
  write(env.GITHUB_OUTPUT, 'pending_count=' + count + '\n');
  return count;
}

if (require.main === module) {
  run().then(count => console.log('[INFO] Itens pendentes em produção: ' + count)).catch(error => {
    // Apenas códigos controlados: nunca imprimir respostas OAuth, JWT ou credenciais.
    const code = /^(GOOGLE_|NFE_|GITHUB_|RPS_)[A-Z_]+$/.test(error.message) ? error.message : 'PENDING_CHECK_FAILED';
    console.error('[ERROR] ' + code);
    process.exitCode = 1;
  });
}

module.exports = { countPending, checkPending, run };
