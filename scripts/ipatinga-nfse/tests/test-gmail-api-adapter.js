'use strict';

const assert = require('assert');

console.log('Running test-gmail-api-adapter.js...');

const mockApiMessage = {
  id: '1a03a322587f4bba',
  threadId: '1a03a322587f4bba_th',
  internalDate: '1724610799000',
  payload: {
    headers: [
      { name: 'From', value: 'PSF SEMG <saudesemg@gmail.com>' },
      { name: 'To', value: 'saudesemg@gmail.com' },
      { name: 'Subject', value: '[NFE-E2E-PROD] Solicitação de emissão de Nota Fiscal' }
    ],
    mimeType: 'text/plain',
    body: {
      data: Buffer.from('Gentileza emitir nota fiscal.\n\nReferente a Plantões Médicos P.S SUS no Mês: 08/2026 - R$ 10,00.\n\nTESTE E2E GMAIL → NFS-e REAL EM PRODUÇÃO.').toString('base64url')
    }
  }
};

function parseGmailApiMessageMock(apiMsg) {
  const headersList = (apiMsg.payload && apiMsg.payload.headers) || [];
  const headers = {};
  headersList.forEach(h => {
    headers[h.name.toLowerCase()] = h.value;
  });

  let plainBody = '';
  if (apiMsg.payload && apiMsg.payload.body && apiMsg.payload.body.data) {
    plainBody = Buffer.from(apiMsg.payload.body.data, 'base64url').toString('utf8');
  }

  const internalDateMs = Number(apiMsg.internalDate) || Date.now();
  const dateObj = new Date(internalDateMs);

  return {
    getId: () => apiMsg.id,
    getThreadId: () => apiMsg.threadId,
    getFrom: () => headers['from'] || '',
    getTo: () => headers['to'] || '',
    getSubject: () => headers['subject'] || '',
    getDate: () => dateObj,
    getPlainBody: () => plainBody
  };
}

const wrapper = parseGmailApiMessageMock(mockApiMessage);
assert.strictEqual(wrapper.getId(), '1a03a322587f4bba');
assert.strictEqual(wrapper.getSubject(), '[NFE-E2E-PROD] Solicitação de emissão de Nota Fiscal');
assert.strictEqual(wrapper.getFrom(), 'PSF SEMG <saudesemg@gmail.com>');
assert(wrapper.getPlainBody().includes('08/2026 - R$ 10,00'));
assert.strictEqual(wrapper.getDate().getTime(), 1724610799000);

console.log('✅ test-gmail-api-adapter.js passed');
