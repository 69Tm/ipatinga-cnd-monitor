'use strict';

const assert = require('assert');
const { buildSyncRanges, syncNfse } = require('../sync');

console.log('Running test-sync.js...');

function ranges(options) {
  return buildSyncRanges(options).map(({ from, to }) => [from, to]);
}

assert.deepStrictEqual(ranges({ mode: 'full', toNumber: 150 }), [[1, 50], [51, 100], [101, 150]]);
assert.deepStrictEqual(ranges({ mode: 'full', toNumber: 123 }), [[1, 50], [51, 100], [101, 123]]);
assert.deepStrictEqual(ranges({ mode: 'full', fromNumber: 37, toNumber: 83 }), [[37, 83]]);
assert.deepStrictEqual(ranges({ mode: 'full', fromNumber: 37, toNumber: 83, batchSize: 20 }), [[37, 56], [57, 76], [77, 83]]);
assert.deepStrictEqual(ranges({ mode: 'full', fromNumber: 42, toNumber: 42 }), [[42, 42]]);
assert.deepStrictEqual(ranges({ mode: 'full', fromNumber: 50, toNumber: 51 }), [[50, 51]]);
assert.deepStrictEqual(ranges({ mode: 'incremental', maxKnown: 100, overlap: 10, incrementalForward: 50 }), [[91, 140], [141, 150]]);
assert.deepStrictEqual(ranges({ mode: 'incremental', maxKnown: 5, overlap: 10, incrementalForward: 5 }), [[1, 10]]);
assert.throws(() => buildSyncRanges({ mode: 'full', fromNumber: 51, toNumber: 50 }), /INVALID_SYNC_RANGE/);
assert.throws(() => buildSyncRanges({ mode: 'full', fromNumber: 0, toNumber: 1 }), /INVALID_SYNC_RANGE/);
assert.throws(() => buildSyncRanges({ mode: 'full' }), /SYNC_RANGE_END_REQUIRED/);
for (const range of buildSyncRanges({ mode: 'full', toNumber: 1000 })) assert.ok(range.from <= range.to);

const validCert = { loaded: true, isValid: true, pemCert: 'cert', pemKey: 'key' };
const emptyExisting = () => ({ byNumber: new Map(), byChave: new Map(), byCnpjNumero: new Map() });
const parsed = notas => ({ success: true, notas, mensagens: [] });

async function testSyncCollection() {
  let soapCalls = 0;
  let upsertCalls = 0;
  let received = null;
  const summary = await syncNfse(
    { mode: 'full', toNumber: 150, certData: validCert },
    {
      loadExistingNotas: emptyExisting,
      callSoapOperation: async () => ({ statusCode: 200, outputXml: '<ok/>' }),
      parseConsultarNfseResposta: () => {
        soapCalls++;
        return parsed([{ numero: String(soapCalls), chaveAcesso: `K${soapCalls}`, cnpjTomador: '1' }]);
      },
      upsertNotas: async notas => { upsertCalls++; received = notas; return { totalProcessed: notas.length }; }
    }
  );
  assert.strictEqual(soapCalls, 3);
  assert.strictEqual(upsertCalls, 1);
  assert.strictEqual(received.length, 3);
  assert.strictEqual(summary.status, 'SUCCESS');
  assert.strictEqual(summary.completedRanges.length, 3);
}

async function testEmptyAndDuplicates() {
  let upsertValue;
  await syncNfse(
    { mode: 'full', toNumber: 100, certData: validCert, dryRun: true },
    {
      loadExistingNotas: emptyExisting,
      callSoapOperation: async () => ({ statusCode: 200, outputXml: '<ok/>' }),
      parseConsultarNfseResposta: (() => {
        let call = 0;
        return () => ++call === 1 ? parsed([{ numero: '10', chaveAcesso: 'same' }]) : parsed([{ numero: '10', chaveAcesso: 'same' }]);
      })(),
      upsertNotas: async (notas, _id, dryRun) => { upsertValue = { notas, dryRun }; return { totalProcessed: notas.length, dryRun }; }
    }
  );
  assert.strictEqual(upsertValue.notas.length, 1);
  assert.strictEqual(upsertValue.dryRun, true);
}

async function assertFailureWithoutUpsert(failingCall, totalRanges) {
  let calls = 0;
  let upsertCalls = 0;
  await assert.rejects(
    syncNfse(
      { mode: 'full', toNumber: totalRanges * 50, certData: validCert },
      {
        loadExistingNotas: emptyExisting,
        callSoapOperation: async () => {
          calls++;
          if (calls === failingCall) throw new Error('SOAP_FAULT: teste');
          return { statusCode: 200, outputXml: '<ok/>' };
        },
        parseConsultarNfseResposta: () => parsed([]),
        upsertNotas: async () => { upsertCalls++; }
      }
    ),
    error => error.code === 'PARTIAL_SYNC_FAILED' && error.syncSummary.completedRanges.length === failingCall - 1
  );
  assert.strictEqual(upsertCalls, 0);
}

async function testDynamicFullTerminationAcrossGap() {
  let calls = 0;
  let received;
  const notesByCall = [
    [{ numero: '10', chaveAcesso: 'K10' }],
    [],
    [{ numero: '120', chaveAcesso: 'K120' }],
    [],
    []
  ];
  const summary = await syncNfse(
    { mode: 'full', certData: validCert, emptyRangesToStop: 2 },
    {
      loadExistingNotas: emptyExisting,
      callSoapOperation: async () => ({ statusCode: 200, outputXml: '<ok/>' }),
      parseConsultarNfseResposta: () => parsed(notesByCall[calls++] || []),
      upsertNotas: async notas => { received = notas; return { totalProcessed: notas.length }; }
    }
  );
  assert.strictEqual(calls, 5);
  assert.deepStrictEqual(summary.actualRanges.map(r => [r.from, r.to]), [[1, 50], [51, 100], [101, 150], [151, 200], [201, 250]]);
  assert.strictEqual(summary.highestObserved, 120);
  assert.strictEqual(summary.terminationReason, 'EMPTY_RANGES_AFTER_HIGHEST_2');
  assert.deepStrictEqual(received.map(n => n.numero), ['10', '120']);
}

async function testDynamicFullWithNoResults() {
  let calls = 0;
  const summary = await syncNfse(
    { mode: 'full', certData: validCert, emptyRangesToStop: 3 },
    {
      loadExistingNotas: emptyExisting,
      callSoapOperation: async () => { calls++; return { statusCode: 200, outputXml: '<ok/>' }; },
      parseConsultarNfseResposta: () => parsed([]),
      upsertNotas: async notas => ({ totalProcessed: notas.length })
    }
  );
  assert.strictEqual(calls, 3);
  assert.strictEqual(summary.totalApi, 0);
  assert.strictEqual(summary.terminationReason, 'EMPTY_RANGES_AFTER_HIGHEST_3');
}

async function testBusinessErrorClassification() {
  let upsertCalls = 0;
  await assert.rejects(
    syncNfse(
      { mode: 'full', toNumber: 50, certData: validCert },
      {
        loadExistingNotas: emptyExisting,
        callSoapOperation: async () => ({ statusCode: 200, outputXml: '<ok/>' }),
        parseConsultarNfseResposta: () => ({
          success: false,
          notas: [],
          mensagens: [{ codigo: 'E999', mensagem: 'Erro de negocio' }]
        }),
        upsertNotas: async () => { upsertCalls++; }
      }
    ),
    /ABRASF_BUSINESS_ERROR.*E999/
  );
  assert.strictEqual(upsertCalls, 0);
}

async function run() {
  await testSyncCollection();
  await testEmptyAndDuplicates();
  await testDynamicFullTerminationAcrossGap();
  await testDynamicFullWithNoResults();
  await testBusinessErrorClassification();
  await assertFailureWithoutUpsert(2, 3);
  await assertFailureWithoutUpsert(3, 3);
  await assert.rejects(syncNfse({ certData: { loaded: true, isValid: false } }), /CERTIFICATE_NOT_READY/);
  console.log('✓ test-sync.js PASSED');
}

module.exports = run();
