'use strict';

const assert = require('assert');
const { preflight } = require('../main');

console.log('Running test-preflight.js...');

async function run() {
  const mockDeps = {
    getSpreadsheetMetadata: async () => ({ sheets: [{ properties: { title: 'Notas' } }] }),
    checkCertificateAccess: async () => ({ accessible: true, name: 'cert.pfx', sizeBytes: 5000 }),
    loadCertificate: async () => ({
      isValid: true,
      certificateCnpj: '31302407000105',
      notAfter: new Date(Date.now() + 86400000)
    }),
    inspectWsdl: async (url) => ({ success: true, accessible: true, httpStatus: 200, statusCode: 200, operations: ['GerarNfse'] })
  };

  process.env.NFE_CERT_PASSWORD = 'mock-password';
  const res = await preflight({ environment: 'homologation' }, mockDeps);

  assert.strictEqual(res.status, 'SUCCESS');
  assert.strictEqual(res.googleServiceAccount, true);
  assert.strictEqual(res.sheetsAccess, true);
  assert.strictEqual(res.pfxAccessibleOnDrive, true);
  assert.strictEqual(res.pfxPasswordConfigured, true);
  assert.strictEqual(res.pfxValidated, true);
  assert.strictEqual(res.productionWsdlAccessible, true);
  assert.strictEqual(res.homologationWsdlAccessible, true);
  assert.strictEqual(res.errors.length, 0);

  delete process.env.NFE_CERT_PASSWORD;
  console.log('✓ test-preflight.js PASSED');
}

module.exports = run();
