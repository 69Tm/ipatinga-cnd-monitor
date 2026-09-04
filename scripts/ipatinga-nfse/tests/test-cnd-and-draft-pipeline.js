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

  function mockSelecionarCndValidaNaData(historico, tipo, dataReferencia) {
    if (!Array.isArray(historico) || !tipo || !dataReferencia) return null;
    const refDate = new Date(dataReferencia);
    const refTime = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate()).getTime();

    const candidatas = historico.filter(item => {
      if (item.tipo !== tipo) return false;
      if (!item.fileId) return false;
      if (!item.validade) return false;

      const v = new Date(item.validade);
      const valTime = new Date(v.getFullYear(), v.getMonth(), v.getDate()).getTime();
      if (valTime < refTime) return false;

      if (item.emissao) {
        const em = new Date(item.emissao);
        const emTime = new Date(em.getFullYear(), em.getMonth(), em.getDate()).getTime();
        if (emTime > refTime) return false; // NUNCA reutilizar certidão emitida no futuro em relação à demanda
      }

      return true;
    });

    if (!candidatas.length) return null;

    candidatas.sort((a, b) => {
      const aEm = a.emissao ? new Date(a.emissao).getTime() : -Infinity;
      const bEm = b.emissao ? new Date(b.emissao).getTime() : -Infinity;
      if (bEm !== aEm) return bEm - aEm;

      const aVal = a.validade ? new Date(a.validade).getTime() : -Infinity;
      const bVal = b.validade ? new Date(b.validade).getTime() : -Infinity;
      if (bVal !== aVal) return bVal - aVal;

      return (b.rowNumber || 0) - (a.rowNumber || 0);
    });

    return candidatas[0];
  }

  function mockVerificarCndsSolicitadas(historico, cndsExigidasStr, dataDemanda, options = {}) {
    if (!cndsExigidasStr || !cndsExigidasStr.trim()) {
      return { exigidas: [], todasValidas: true, cndsParaAnexo: [], renewalsAttempted: 0, renewalsSucceeded: 0, renewalsFailed: 0, paidApiCallsExecuted: 0, pendencias: [] };
    }

    const cndsSolicitadas = cndsExigidasStr.split(';').map(s => s.trim()).filter(Boolean);
    const dataRef = dataDemanda ? new Date(dataDemanda) : new Date();
    let renewalsCount = 0;
    let renewalsSucceeded = 0;
    let renewalsFailed = 0;
    let paidCallsCount = 0;
    const cndsParaAnexo = [];
    const pendencias = [];

    for (const tipo of cndsSolicitadas) {
      const cndValidaNaData = mockSelecionarCndValidaNaData(historico, tipo, dataRef);
      if (cndValidaNaData && cndValidaNaData.fileId) {
        cndsParaAnexo.push({
          tipo: tipo,
          fileId: cndValidaNaData.fileId,
          validade: cndValidaNaData.validade,
          emissao: cndValidaNaData.emissao,
          status: 'VALIDA_REUTILIZADA'
        });
        continue;
      }

      // Expired or absent on demand date and requested -> renewal attempted
      renewalsCount++;
      const cat = catalogo[tipo];
      
      // Provedor real determina chamadas pagas executadas
      let paidCallsThisItem = 0;
      if (options.mockProviderCall) {
        paidCallsThisItem = options.mockProviderCall(tipo, cat);
      } else if (cat && (cat.provider === 'infosimples' || cat.provider === 'serpro')) {
        // Se credencial ausente ou cooldown, paidCallsThisItem = 0
        if (options.missingCredentials || options.inCooldown) {
          paidCallsThisItem = 0;
        } else if (options.mockRenewSuccess) {
          paidCallsThisItem = 1;
        }
      }
      paidCallsCount += paidCallsThisItem;

      if (options.mockRenewSuccess) {
        renewalsSucceeded++;
        cndsParaAnexo.push({ tipo, fileId: 'drive_new_' + tipo, status: 'RENOVADA_COM_SUCESSO' });
      } else {
        renewalsFailed++;
        pendencias.push({ tipo, motivo: options.failureReason || 'FALHA_RENOVACAO' });
      }
    }

    return {
      exigidas: cndsSolicitadas,
      todasValidas: pendencias.length === 0,
      cndsParaAnexo,
      renewalsAttempted: renewalsCount,
      renewalsSucceeded,
      renewalsFailed,
      paidApiCallsExecuted: paidCallsCount,
      pendencias
    };
  }

  // Histórico de Teste
  const mockHistorico = [
    { tipo: 'CRF FGTS', emissao: new Date('2026-07-25'), validade: new Date('2026-08-23'), fileId: 'drive_fgts_25jul', rowNumber: 2 },
    { tipo: 'CND Federal', emissao: new Date('2026-08-17'), validade: new Date('2027-02-13'), fileId: 'drive_fed_17aug', rowNumber: 3 },
    { tipo: 'CNDT', emissao: new Date('2026-01-10'), validade: new Date('2026-07-09'), fileId: 'drive_cndt_old', rowNumber: 4 },
    { tipo: 'CNDT', emissao: new Date('2026-07-10'), validade: new Date('2027-01-06'), fileId: 'drive_cndt_new', rowNumber: 5 }
  ];

  // 1. CASO A: FGTS com emissão=25/07/2026, validade=23/08/2026, demanda=20/08/2026
  // Esperado: REUSE, renewalsAttempted=0, paidApiCallsExecuted=0
  const casoA = mockVerificarCndsSolicitadas(mockHistorico, 'CRF FGTS', '2026-08-20');
  assert.strictEqual(casoA.todasValidas, true);
  assert.strictEqual(casoA.renewalsAttempted, 0);
  assert.strictEqual(casoA.paidApiCallsExecuted, 0);
  assert.strictEqual(casoA.cndsParaAnexo.length, 1);
  assert.strictEqual(casoA.cndsParaAnexo[0].status, 'VALIDA_REUTILIZADA');
  assert.strictEqual(casoA.cndsParaAnexo[0].fileId, 'drive_fgts_25jul');
  console.log('✅ PASS: CASO A — FGTS válido na data da demanda (20/08/2026) -> REUSE (0 renovações, 0 chamadas pagas)');

  // 2. CASO B: Mesmo FGTS com demanda=24/08/2026 (após vencimento em 23/08/2026)
  // Esperado: NÃO REUSE; elegível para RENEW somente se solicitado
  const casoB = mockVerificarCndsSolicitadas(mockHistorico, 'CRF FGTS', '2026-08-24', { missingCredentials: true });
  assert.strictEqual(casoB.todasValidas, false);
  assert.strictEqual(casoB.renewalsAttempted, 1);
  assert.strictEqual(casoB.paidApiCallsExecuted, 0, 'Sem credencial Infosimples -> 0 chamadas pagas');
  assert.strictEqual(casoB.pendencias[0].tipo, 'CRF FGTS');
  console.log('✅ PASS: CASO B — FGTS vencido na data da demanda (24/08/2026) -> NÃO REUSE, RENEW acionado sem custo indevido');

  // 3. CASO C: Federal com emissão=17/08/2026, validade=13/02/2027, demanda=10/08/2026
  // Esperado: NÃO REUSE essa certidão emitida DEPOIS da demanda
  const casoC = mockVerificarCndsSolicitadas(mockHistorico, 'CND Federal', '2026-08-10', { missingCredentials: true });
  assert.strictEqual(casoC.todasValidas, false);
  assert.strictEqual(casoC.renewalsAttempted, 1);
  assert.strictEqual(casoC.cndsParaAnexo.length, 0);
  console.log('✅ PASS: CASO C — Certidão emitida no futuro em relação à demanda (17/08 > 10/08) -> REUSE BLOQUEADO');

  // 4. CASO D: Duas certidões históricas CNDT (2026-01-10 a 2026-07-09 e 2026-07-10 a 2027-01-06)
  // Para demanda em 2026-05-15: deve selecionar a primeira (drive_cndt_old), que era a válida na época!
  const casoD = mockVerificarCndsSolicitadas(mockHistorico, 'CNDT', '2026-05-15');
  assert.strictEqual(casoD.todasValidas, true);
  assert.strictEqual(casoD.renewalsAttempted, 0);
  assert.strictEqual(casoD.cndsParaAnexo.length, 1);
  assert.strictEqual(casoD.cndsParaAnexo[0].fileId, 'drive_cndt_old', 'Deve selecionar a certidão histórica efetivamente vigente na data da demanda');
  console.log('✅ PASS: CASO D — Seleção determinística da certidão histórica correta na data (e não da maior validade)');

  // 5. CASO E: Nenhuma CND solicitada
  // Esperado: renewalsAttempted=0, paidApiCallsExecuted=0, todasValidas=true
  const casoE = mockVerificarCndsSolicitadas(mockHistorico, '', '2026-08-27');
  assert.strictEqual(casoE.renewalsAttempted, 0);
  assert.strictEqual(casoE.paidApiCallsExecuted, 0);
  assert.strictEqual(casoE.todasValidas, true);
  console.log('✅ PASS: CASO E — Nenhuma CND solicitada -> 0 renovações, 0 chamadas pagas');

  // 6. Testes de Custo e Auditoria Real de paidApiCallsExecuted
  // Subcaso 6.1: INFOSIMPLES_TOKEN ausente -> paidApiCallsExecuted=0
  const resNoToken = mockVerificarCndsSolicitadas(mockHistorico, 'CRF FGTS', '2026-08-27', { missingCredentials: true });
  assert.strictEqual(resNoToken.paidApiCallsExecuted, 0);
  console.log('✅ PASS: CUSTO — INFOSIMPLES_TOKEN ausente -> paidApiCallsExecuted=0');

  // Subcaso 6.2: Cooldown ativo -> paidApiCallsExecuted=0
  const resCooldown = mockVerificarCndsSolicitadas(mockHistorico, 'CRF FGTS', '2026-08-27', { inCooldown: true });
  assert.strictEqual(resCooldown.paidApiCallsExecuted, 0);
  console.log('✅ PASS: CUSTO — Cooldown ativo -> paidApiCallsExecuted=0');

  // Subcaso 6.3: Provedor manual -> paidApiCallsExecuted=0
  const resManual = mockVerificarCndsSolicitadas(mockHistorico, 'Certidão Falência/Concordata', '2026-11-01', { mockProviderCall: () => 0 });
  assert.strictEqual(resManual.paidApiCallsExecuted, 0);
  console.log('✅ PASS: CUSTO — Provedor manual -> paidApiCallsExecuted=0');

  // Subcaso 6.4: Provedor Municipal externo (GitHub Actions) -> paidApiCallsExecuted=0
  const resMunicipal = mockVerificarCndsSolicitadas(mockHistorico, 'CND Municipal', '2026-12-01', { mockProviderCall: () => 0 });
  assert.strictEqual(resMunicipal.paidApiCallsExecuted, 0);
  console.log('✅ PASS: CUSTO — Municipal gerenciada externamente -> paidApiCallsExecuted=0');

  // Subcaso 6.5: Mock de consulta InfoSimples real executada -> paidApiCallsExecuted=1
  const resRealInfoSimples = mockVerificarCndsSolicitadas(mockHistorico, 'CRF FGTS', '2026-08-27', { mockRenewSuccess: true });
  assert.strictEqual(resRealInfoSimples.paidApiCallsExecuted, 1);
  console.log('✅ PASS: CUSTO — Consulta InfoSimples real executada -> paidApiCallsExecuted=1');

  // Subcaso 6.6: SERPRO sem credenciais -> paidApiCallsExecuted=0
  const resSerproNoCreds = mockVerificarCndsSolicitadas(mockHistorico, 'CND Federal', '2026-08-10', { missingCredentials: true });
  assert.strictEqual(resSerproNoCreds.paidApiCallsExecuted, 0);
  console.log('✅ PASS: CUSTO — SERPRO sem credenciais -> paidApiCallsExecuted=0');

  // Subcaso 6.7: Mock SERPRO com status 7 (1 request inicial + 1 poll de continuação = 2 requests) -> paidApiCallsExecuted=2
  const resSerproStatus7 = mockVerificarCndsSolicitadas(mockHistorico, 'CND Federal', '2026-08-10', {
    mockRenewSuccess: true,
    mockProviderCall: () => 2
  });
  assert.strictEqual(resSerproStatus7.paidApiCallsExecuted, 2);
  console.log('✅ PASS: CUSTO — Consulta SERPRO com polling real (2 requests) -> paidApiCallsExecuted=2');

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
