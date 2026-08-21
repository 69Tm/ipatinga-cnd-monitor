'use strict';

const assert = require('assert');
const { sanitize } = require('../config');

console.log('Running test-sync.js...');

// 1. Sanitization of Secrets
const testObj = {
  msg: 'Erro ao conectar password=SuperSecretPassword com cert',
  key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----'
};
const sanitized = sanitize(testObj);
assert.ok(!sanitized.msg.includes('SuperSecretPassword'));
assert.ok(!sanitized.key.includes('MIIEowIBAAKCAQEA'));
assert.ok(sanitized.key.includes('***REDACTED PRIVATE KEY***'));

console.log('✓ test-sync.js PASSED');
