'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { countPending, run } = require('../pending-check');

const headers = ['environment', 'request_id', 'item_index', 'rps_numero', 'rps_serie', 'rps_tipo', 'status'];
const privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const env = { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'unit@example.invalid', private_key: privateKey }),
  NFE_SPREADSHEET_ID: 'unit-sheet', GITHUB_OUTPUT: 'unit-output' };
const json = value => ({ ok: true, json: async () => value });
const mock = second => async url => url.includes('/token') ? json({ access_token: 'unit-token' }) : second;

test('conta apenas estados recuperáveis em produção; ledger só com cabeçalho é zero legítimo', () => {
  const row = (environment, status) => [environment, 'request', '1', '101', 'A', '1', status];
  assert.equal(countPending([headers]), 0);
  assert.equal(countPending([headers, row('production', 'UNKNOWN_AFTER_TIMEOUT'),
    row('production', 'SUBMITTED_ASYNC_PROCESSING'), row('production', 'PROVIDER_INFRA_UNAVAILABLE'),
    row('homologation', 'UNKNOWN_AFTER_TIMEOUT'), row('production', 'ISSUED'), row('production', 'FAILED_SAFE')]), 3);
});

test('só publica pending_count após resposta autenticada e schema válido', async () => {
  const writes = [];
  assert.equal(await run(env, mock(json({ values: [headers] })), (...args) => writes.push(args)), 0);
  assert.deepEqual(writes, [['unit-output', 'pending_count=0\n']]);
});

test('credenciais ausentes, inválidas e configuração ausente abortam sem publicar zero', async () => {
  for (const candidate of [{ ...env, GOOGLE_SERVICE_ACCOUNT_JSON: '' },
    { ...env, GOOGLE_SERVICE_ACCOUNT_JSON: 'private-secret-invalid-json' },
    { ...env, NFE_SPREADSHEET_ID: '' }, { ...env, GITHUB_OUTPUT: '' }]) {
    const writes = [];
    await assert.rejects(run(candidate, () => assert.fail('rede não deve ser chamada'), (...args) => writes.push(args)));
    assert.deepEqual(writes, []);
  }
});

test('401/403/500, JSON inválido, erro de transporte e schema vazio não viram sucesso', async () => {
  const failures = [
    async () => ({ ok: false, status: 401 }),
    async () => json({ error: 'private-oauth-error' }),
    mock({ ok: false, status: 403 }), mock({ ok: false, status: 500 }),
    mock({ ok: true, json: async () => { throw new Error('private-response'); } }),
    mock(json({})), mock(json({ values: [] })), mock(json({ values: [['wrong', ...headers.slice(1)]] })),
    async () => { throw new Error('private-request-with-token'); },
    async url => { if (url.includes('/token')) return json({ access_token: 'unit-token' }); throw new Error('timeout'); }
  ];
  for (const fetchImpl of failures) {
    const writes = [];
    await assert.rejects(run(env, fetchImpl, (...args) => writes.push(args)), error => {
      assert.match(error.message, /^(GOOGLE_|RPS_)[A-Z_]+$/);
      assert.ok(!error.message.includes('private'));
      return true;
    });
    assert.deepEqual(writes, []);
  }
});

test('CLI falha com exit 1, saída sanitizada e nenhum output para credenciais ausentes', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dexmed-pending-test-'));
  const output = path.join(folder, 'output');
  try {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../pending-check.js')], {
      env: { ...process.env, GOOGLE_SERVICE_ACCOUNT_JSON: '', GITHUB_OUTPUT: output }, encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /GOOGLE_CREDENTIALS_MISSING/);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
