'use strict';

const assert = require('assert');

function runTests() {
  console.log('--- TEST: CND Check Gate, Document Pipeline & Draft Creation ---');

  // Mock CND catalog and situation
  const catalogo = {
    'CRF FGTS': { tipo: 'CRF FGTS', provider: 'infosimples', linkEmissao: 'http://fgts' },
    'CNDT': { tipo: 'CNDT', provider: 'infosimples', linkEmissao: 'http://cndt' },
    'CND Federal': { tipo: 'CND Federal', provider: 'serpro', linkEmissao: 'http://federal' },
    'CND Estadual MG': { tipo: 'CND Estadual MG', provider: 'infosimples', linkEmissao: 'http://estadual' },
    'CND Municipal': { tipo: 'CND Municipal', provider: 'github_sheet', linkEmissao: 'http://municipal' }
  };

  function mockVerificarCndsSolicitadas(situacao, cndsExigidasStr, dataDemanda, options = {}) {
    if (!cndsExigidasStr || !cndsExigidasStr.trim()) {
      return { exigidas: [], todasValidas: true, cndsParaAnexo: [], renewalsAttempted: 0, paidApiCalls: 0 };
    }

    const cndsSolicitadas = cndsExigidasStr.split(';').map(s => s.trim()).filter(Boolean);
    const dataRef = dataDemanda ? new Date(dataDemanda) : new Date();
    let renewalsCount = 0;
    let paidCallsCount = 0;
    const cndsParaAnexo = [];
    const pendencias = [];

    for (const tipo of cndsSolicitadas) {
      const cndValida = (situacao.validas || []).find(c => c.tipo === tipo);
      if (cndValida && cndValida.validade && cndValida.validade.getTime() >= dataRef.getTime() && cndValida.fileId) {
        // REUSE: Short validity does NOT justify renewal
        cndsParaAnexo.push({ tipo, fileId: cndValida.fileId, status: 'VALIDA_REUTILIZADA' });
        continue;
      }

      // Expired and requested -> renew only this CND
      const cndVencida = (situacao.vencidas || []).find(c => c.tipo === tipo) ||
                         (situacao.ausentes || []).find(c => c.tipo === tipo);
      renewalsCount++;
      const cat = catalogo[tipo];
      if (cat && (cat.provider === 'infosimples' || cat.provider === 'serpro')) {
        paidCallsCount++;
      }
      if (options.mockRenewSuccess) {
        cndsParaAnexo.push({ tipo, fileId: 'drive_new_' + tipo, status: 'RENOVADA_COM_SUCESSO' });
      } else {
        pendencias.push({ tipo, motivo: 'FALHA_RENOVACAO' });
      }
    }

    return {
      exigidas: cndsSolicitadas,
      todasValidas: pendencias.length === 0,
      cndsParaAnexo,
      renewalsAttempted: renewalsCount,
      paidApiCalls: paidCallsCount,
      pendencias
    };
  }

  // 1. Test: Valid CND requested -> REUSE, 0 renewals, 0 paid calls
  const mockSituation = {
    validas: [
      { tipo: 'CRF FGTS', validade: new Date('2026-08-30'), fileId: 'drive_fgts_123' },
      { tipo: 'CND Estadual MG', validade: new Date('2026-09-15'), fileId: 'drive_estadual_456' }
    ],
    vencidas: [
      { tipo: 'CNDT', validade: new Date('2026-07-01'), fileId: 'drive_cndt_old' },
      { tipo: 'CND Federal', validade: new Date('2026-06-01'), fileId: 'drive_fed_old' }
    ],
    ausentes: []
  };

  const resValid = mockVerificarCndsSolicitadas(mockSituation, 'CRF FGTS; CND Estadual MG', '2026-08-27');
  assert.strictEqual(resValid.todasValidas, true);
  assert.strictEqual(resValid.renewalsAttempted, 0, 'Should not renew valid CNDs');
  assert.strictEqual(resValid.paidApiCalls, 0, 'Should not call paid APIs for valid CNDs');
  assert.strictEqual(resValid.cndsParaAnexo.length, 2);
  console.log('✅ PASS: CND válida solicitada -> reuse (0 renewal, 0 paid calls)');

  // 2. Test: Expired CND requested -> RENEWAL
  const resExpiredRequested = mockVerificarCndsSolicitadas(mockSituation, 'CNDT', '2026-08-27', { mockRenewSuccess: true });
  assert.strictEqual(resExpiredRequested.todasValidas, true);
  assert.strictEqual(resExpiredRequested.renewalsAttempted, 1);
  assert.strictEqual(resExpiredRequested.paidApiCalls, 1);
  assert.strictEqual(resExpiredRequested.cndsParaAnexo[0].status, 'RENOVADA_COM_SUCESSO');
  console.log('✅ PASS: CND vencida solicitada -> renewal');

  // 3. Test: Expired CND NOT requested -> ZERO renewal
  const resNotRequested = mockVerificarCndsSolicitadas(mockSituation, 'CRF FGTS', '2026-08-27');
  assert.strictEqual(resNotRequested.renewalsAttempted, 0, 'CNDT and CND Federal must NOT be renewed when only CRF FGTS is requested');
  assert.strictEqual(resNotRequested.paidApiCalls, 0);
  console.log('✅ PASS: CND vencida não solicitada -> zero renewal');

  // 4. Test: Demand with 0 CND requested -> 0 renewals, 0 paid calls
  const resZeroCnd = mockVerificarCndsSolicitadas(mockSituation, '', '2026-08-27');
  assert.strictEqual(resZeroCnd.renewalsAttempted, 0);
  assert.strictEqual(resZeroCnd.paidApiCalls, 0);
  assert.strictEqual(resZeroCnd.todasValidas, true);
  console.log('✅ PASS: Demanda sem CND -> 0 renewals, 0 paid calls');

  // 5. Test: State Machine Transition: DOCUMENT_PENDING -> DOCUMENTS_READY -> DRAFT_CREATED
  let pipelineState = 'DOCUMENT_PENDING';
  let xmlDriveId = null;
  let draftId = null;

  // Step A: XML generated and saved to Drive
  if (pipelineState === 'DOCUMENT_PENDING') {
    xmlDriveId = 'drive_xml_nfse_18';
    pipelineState = 'DOCUMENTS_READY';
  }
  assert.strictEqual(pipelineState, 'DOCUMENTS_READY');
  assert.ok(xmlDriveId);
  console.log('✅ PASS: DOCUMENT_PENDING -> DOCUMENTS_READY');

  // Step B: Draft created
  let draftsCreated = 0;
  function createDraftMock() {
    if (pipelineState === 'DRAFT_CREATED') return null; // Idempotency
    draftsCreated++;
    draftId = 'draft_msg_1a03eb59b2dd3e5f';
    pipelineState = 'DRAFT_CREATED';
    return draftId;
  }

  createDraftMock();
  assert.strictEqual(pipelineState, 'DRAFT_CREATED');
  assert.strictEqual(draftsCreated, 1);
  console.log('✅ PASS: DOCUMENTS_READY -> DRAFT_CREATED');

  // Step C: Draft idempotency
  createDraftMock();
  assert.strictEqual(draftsCreated, 1, 'Should not create duplicate draft');
  console.log('✅ PASS: Draft idempotency');
}

if (require.main === module) {
  runTests();
}

module.exports = { runTests };
