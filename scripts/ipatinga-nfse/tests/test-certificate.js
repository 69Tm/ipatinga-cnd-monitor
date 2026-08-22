'use strict';

const assert = require('assert');
const forge = require('node-forge');
const { publicKeysMatch, extractCertificateCnpj, validateExtendedKeyUsage } = require('../certificate');

console.log('Running test-certificate.js...');
const first = forge.pki.rsa.generateKeyPair({ bits: 512, e: 0x10001 });
const second = forge.pki.rsa.generateKeyPair({ bits: 512, e: 0x10001 });
assert.strictEqual(publicKeysMatch(first.publicKey, first.privateKey), true);
assert.strictEqual(publicKeysMatch(first.publicKey, second.privateKey), false);

const fakeCert = {
  subject: { attributes: [{ type: '2.16.76.1.3.3', value: '31.302.407/0001-05' }] },
  extensions: []
};
assert.strictEqual(extractCertificateCnpj(fakeCert), '31302407000105');
assert.strictEqual(extractCertificateCnpj({ subject: { attributes: [] }, extensions: [] }), null);
assert.deepStrictEqual(validateExtendedKeyUsage({ extensions: [] }), { present: false, compatible: true });
assert.deepStrictEqual(validateExtendedKeyUsage({ extensions: [{ name: 'extKeyUsage', clientAuth: true }] }), { present: true, compatible: true });
assert.throws(() => validateExtendedKeyUsage({ extensions: [{ name: 'extKeyUsage', serverAuth: true }] }), /CERT_EKU_INCOMPATIBLE/);
console.log('✓ test-certificate.js PASSED');
