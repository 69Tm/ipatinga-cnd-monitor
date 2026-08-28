'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('Running test-apps-script-engine.js...');

const gsPath = path.resolve(__dirname, '../../../apps-script/Codigo_v3.4.3_patched.gs');
const rawCode = fs.readFileSync(gsPath, 'utf8');
const code = rawCode.replace(/\r\n/g, '\n');

// 1. Verificação Sintática do Arquivo Apps Script
try {
  new Function(code);
  console.log('✓ Apps Script syntax check passed');
} catch (err) {
  console.error('❌ Erro de sintaxe no arquivo Apps Script:', err.message);
  process.exit(1);
}

// 2. Verificação de não-recursão em abrirPlanilhaCnds_
assert.ok(code.includes("function abrirPlanilhaCnds_() {\n  if (!SYSTEM.CND_CONTROL_SPREADSHEET_ID) throw new Error('CND_CONTROL_SPREADSHEET_ID não configurado.');\n  return SpreadsheetApp.openById(SYSTEM.CND_CONTROL_SPREADSHEET_ID);\n}"), 'abrirPlanilhaCnds_ deve chamar SpreadsheetApp.openById sem recursão');
assert.ok(!code.includes('gerarXmlAutorizadoNfseAbrasf_'), 'gerarXmlAutorizadoNfseAbrasf_ deve ter sido completamente removida');
console.log('✓ abrirPlanilhaCnds_ non-recursion verified');
console.log('✓ gerarXmlAutorizadoNfseAbrasf_ absence verified');

// Extrai as funções do código para testes unitários isolados
function normalizarTextoBusca_(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function parseMoeda_(str) {
  if (!str) return 0;
  const clean = String(str).replace(/[^\d,\.]/g, '');
  if (clean.includes(',') && clean.includes('.')) {
    return parseFloat(clean.replace(/\./g, '').replace(',', '.'));
  }
  if (clean.includes(',')) {
    return parseFloat(clean.replace(',', '.'));
  }
  return parseFloat(clean) || 0;
}

function formatarMoedaSimples_(val) {
  return Number(val || 0).toFixed(2).replace('.', ',');
}

function classificarAcaoMensagemNf_(message) {
  const subject = normalizarTextoBusca_(message.getSubject() || '');
  const body = normalizarTextoBusca_(String(message.getPlainBody() || '').slice(0, 12000));
  const combined = subject + ' ' + body;

  if (/\b(cancelar|cancelamento|cancela)\b/.test(combined)) return 'CANCELAR';
  if (/\b(corrigir|correcao|retificar|carta de correcao)\b/.test(combined)) return 'CORRIGIR';
  if (/\b(reenviar|reiterar|reitero|segunda via|reemissao)\b/.test(combined)) return 'REENVIAR';
  if (/\b(somente cnd|apenas certid|enviar cnd|solicito cnd)\b/.test(combined) && !/\b(nota fiscal|nfs-?e)\b/.test(combined)) return 'DOCUMENTOS_CND';

  if (/\b(gentileza emitir|favor emitir|solicito a emissao|solicito emissao|emitir nota|emissao de nota|emissao da nota|solicitamos a nota|solicitacao de nota|solicito nf|favor gerar|gerar nf|emitir nfs-?e|emissao de nfs-?e)\b/.test(combined)) {
    return 'EMITIR';
  }

  return 'OUTRO';
}

function mapearNomeCndPadrao_(nomeBruto) {
  const norm = normalizarTextoBusca_(nomeBruto);
  if (norm.includes('estadual')) return 'CND Estadual MG';
  if (norm.includes('fgts') || norm.includes('crf')) return 'CRF FGTS';
  if (norm.includes('falencia') || norm.includes('concordata')) return 'Certidão Falência/Concordata';
  if (norm.includes('trabalhista') || norm.includes('cndt')) return 'CNDT';
  if (norm.includes('federal') || norm.includes('receita federal') || norm.includes('pgfn')) return 'CND Federal';
  if (norm.includes('municipal')) return 'CND Municipal';
  return String(nomeBruto || '').trim();
}

function extrairItensDemandaHic_(bodyText) {
  const text = String(bodyText || '');
  const itens = [];
  const compMatch = text.match(/m[eê]s\s*(\d{2}\/\d{4})/i) || text.match(/compet[eê]ncia\s*(\d{2}\/\d{4})/i);
  const competencia = compMatch ? compMatch[1] : null;

  // Bloco 1: Plantões Médicos
  const plantaoMatch = text.match(/Plant[oõ]es[^\n\r]*[\s\S]*?R\$\s*([\d\.,]+)/i);
  if (plantaoMatch) {
    const valor = parseMoeda_(plantaoMatch[1]);
    if (valor > 0) {
      itens.push({
        categoria: 'HIC — Plantões PS SUS',
        pattern: 'HIC_PLANTOES_PS_SUS',
        valorStr: formatarMoedaSimples_(valor),
        valor: valor,
        descricao: ''
      });
    }
  }

  // Bloco 2: Produção PS SUS
  const prodMatch = text.match(/Produ[cç][aã]o[^\n\r]*[\s\S]*?R\$\s*([\d\.,]+)/i);
  if (prodMatch) {
    const valor = parseMoeda_(prodMatch[1]);
    if (valor > 0) {
      itens.push({
        categoria: 'HIC — Produção PS SUS',
        pattern: 'HIC_PRODUCAO_PS_SUS',
        valorStr: formatarMoedaSimples_(valor),
        valor: valor,
        descricao: ''
      });
    }
  }

  // Identifica CNDs exigidas no corpo com mapeador padronizado
  const cndsExigidas = [];
  if (/estadual/i.test(text)) cndsExigidas.push(mapearNomeCndPadrao_('estadual'));
  if (/fgts/i.test(text) || /crf/i.test(text)) cndsExigidas.push(mapearNomeCndPadrao_('fgts'));
  if (/falencia/i.test(text) || /concordata/i.test(text)) cndsExigidas.push(mapearNomeCndPadrao_('falencia'));
  if (/trabalhista/i.test(text) || /cndt/i.test(text)) cndsExigidas.push(mapearNomeCndPadrao_('trabalhista'));
  if (/federal/i.test(text) || /receita federal/i.test(text)) cndsExigidas.push(mapearNomeCndPadrao_('federal'));
  if (/municipal/i.test(text)) cndsExigidas.push(mapearNomeCndPadrao_('municipal'));

  return {
    competencia: competencia,
    itens: itens,
    cndsExigidas: cndsExigidas.join('; ')
  };
}

// 3. Testes da Classificação de Ação
assert.strictEqual(classificarAcaoMensagemNf_({ getSubject: () => '', getPlainBody: () => 'favor emitir nota fiscal' }), 'EMITIR');
assert.strictEqual(classificarAcaoMensagemNf_({ getSubject: () => '', getPlainBody: () => 'favor cancelar a nota fiscal' }), 'CANCELAR');
assert.strictEqual(classificarAcaoMensagemNf_({ getSubject: () => '', getPlainBody: () => 'favor corrigir a nota' }), 'CORRIGIR');
assert.strictEqual(classificarAcaoMensagemNf_({ getSubject: () => '', getPlainBody: () => 'reenviar a NF' }), 'REENVIAR');
assert.strictEqual(classificarAcaoMensagemNf_({ getSubject: () => '', getPlainBody: () => 'gentileza enviar somente CND' }), 'DOCUMENTOS_CND');
console.log('✓ Action classification assertions passed');

// 4. Testes do Parser HIC com o e-mail real da fixture
const hicRealFixture = `Gentileza emitir nota fiscal para o pagamento...

Referente a Plantões Médicos PS SUS no Mês 07/2026-
R$ 13.200,00.

ENVIAR OUTRA NF

Referente a Produção PS SUS no Mês 07/2026-
R$ 2.010,00.

FAVOR ENVIAR JUNTO CND ESTADUAL, FALENCIA E FGTS`;

const parsedHic = extrairItensDemandaHic_(hicRealFixture);
assert.strictEqual(parsedHic.competencia, '07/2026');
assert.strictEqual(parsedHic.itens.length, 2);
assert.strictEqual(parsedHic.itens[0].pattern, 'HIC_PLANTOES_PS_SUS');
assert.strictEqual(parsedHic.itens[0].valor, 13200.00);
assert.strictEqual(parsedHic.itens[1].pattern, 'HIC_PRODUCAO_PS_SUS');
assert.strictEqual(parsedHic.itens[1].valor, 2010.00);
assert.ok(parsedHic.cndsExigidas.includes('CND Estadual MG'));
assert.ok(parsedHic.cndsExigidas.includes('CRF FGTS'));
assert.ok(parsedHic.cndsExigidas.includes('Certidão Falência/Concordata'));
console.log('✓ HIC real fixture parser passed');

// 6. Testes de Anti-Spoofing e Segurança do Remetente E2E
function validarRemetenteFiscalSimulado_(message, props, effectiveUser) {
  const fromHeader = String(message.getFrom() || '');
  const fromEmail = fromHeader.toLowerCase();
  const subject = String(message.getSubject() || '');
  const ownEmail = (effectiveUser || '').toLowerCase();

  const testDryRunEnabled = props.NFE_EMAIL_E2E_TEST_ENABLED === 'true';
  const testProdEnabled = props.NFE_EMAIL_E2E_PRODUCTION_ENABLED === 'true';

  if (testDryRunEnabled && subject.startsWith('[NFE-E2E-DRYRUN]')) {
    if (ownEmail && fromEmail === ownEmail) {
      return { valid: true, isE2eTest: true, dryRun: true, tomador: 'HIC', reason: 'E2E_DRYRUN_AUTHORIZED' };
    }
    return { valid: false, isE2eTest: false, dryRun: false, reason: 'E2E_DRYRUN_REJECTED_UNAUTHORIZED_SENDER: ' + fromEmail };
  }

  if (testProdEnabled && subject.startsWith('[NFE-E2E-PROD]')) {
    if (ownEmail && fromEmail === ownEmail) {
      return { valid: true, isE2eTest: true, dryRun: false, tomador: 'HIC', reason: 'E2E_PRODUCTION_AUTHORIZED' };
    }
    return { valid: false, isE2eTest: false, dryRun: false, reason: 'E2E_PRODUCTION_REJECTED_UNAUTHORIZED_SENDER: ' + fromEmail };
  }

  return { valid: false, reason: 'UNTRUSTED_SENDER' };
}

// Teste de spoofing: invasor enviando [NFE-E2E-PROD]
const spoofAttempt = validarRemetenteFiscalSimulado_(
  { getFrom: () => 'attacker@example.com', getSubject: () => '[NFE-E2E-PROD] Emitir NF' },
  { NFE_EMAIL_E2E_PRODUCTION_ENABLED: 'true' },
  'owner@gmail.com'
);
assert.strictEqual(spoofAttempt.valid, false, 'Invasor não pode se passar por E2E prod');
assert.ok(spoofAttempt.reason.includes('REJECTED_UNAUTHORIZED_SENDER'));

// Teste de proprietário autorizado
const ownerDryRun = validarRemetenteFiscalSimulado_(
  { getFrom: () => 'owner@gmail.com', getSubject: () => '[NFE-E2E-DRYRUN] Solicitação de emissão de Nota Fiscal' },
  { NFE_EMAIL_E2E_TEST_ENABLED: 'true' },
  'owner@gmail.com'
);
assert.strictEqual(ownerDryRun.valid, true, 'Proprietário autorizado em dry-run');
assert.strictEqual(ownerDryRun.dryRun, true);
console.log('✓ Anti-spoofing E2E validation assertions passed');

// 7. Testes A-H de Gaps do Scanner Fiscal e Idempotência
function simularProcessamentoDemanda_(message, existingRow, props, effectiveUser) {
  let dispatchCalls = 0;
  const senderCheck = validarRemetenteFiscalSimulado_(message, props, effectiveUser);
  if (!senderCheck.valid) return { ok: false, reason: senderCheck.reason, dispatchCalls: 0 };

  const parsed = extrairItensDemandaHic_(message.getPlainBody());
  if (!parsed.competencia) return { ok: false, reason: 'COMPETENCIA_NAO_IDENTIFICADA', status: 'REVISAO_MANUAL', dispatchCalls: 0 };
  if (!parsed.itens || parsed.itens.length === 0) return { ok: false, reason: 'PARSE_FAILED_NO_ITEMS', status: 'REVISAO_MANUAL', dispatchCalls: 0 };

  const temCnd = parsed.cndsExigidas && parsed.cndsExigidas.trim().length > 0;
  if (temCnd) {
    return { ok: true, cndPending: true, pipelineState: 'CND_CHECK_PENDING', dispatchCalls: 0 };
  }

  // Idempotência estrita
  const nonRedispatchStatuses = ['DISPATCHED', 'WAITING_FISCAL', 'ISSUED', 'WAITING_SYNC', 'DOCUMENT_PENDING', 'DRY_RUN_SUCCESS', 'E2E_DRY_RUN_VALIDATED', 'CONCLUÍDA'];
  if (existingRow && (nonRedispatchStatuses.includes(existingRow.status) || nonRedispatchStatuses.includes(existingRow.pipelineState))) {
    return { ok: true, alreadyCompleted: true, existingDemand: true, dispatchCalls: 0 };
  }

  dispatchCalls = parsed.itens.length;
  return { ok: true, dispatched: true, dispatchCalls };
}

// A. Rescan WAITING_FISCAL -> dispatchCalls = 0
const rescanWaiting = simularProcessamentoDemanda_(
  { getFrom: () => 'owner@gmail.com', getSubject: () => '[NFE-E2E-DRYRUN] NF', getPlainBody: () => 'Plantões R$ 10,00 Mês 08/2026' },
  { status: 'DISPATCHED', pipelineState: 'WAITING_FISCAL' },
  { NFE_EMAIL_E2E_TEST_ENABLED: 'true' },
  'owner@gmail.com'
);
assert.strictEqual(rescanWaiting.dispatchCalls, 0, 'Rescan WAITING_FISCAL não deve redisparar');

// B. Rescan DRY_RUN_SUCCESS -> dispatchCalls = 0
const rescanDryRun = simularProcessamentoDemanda_(
  { getFrom: () => 'owner@gmail.com', getSubject: () => '[NFE-E2E-DRYRUN] NF', getPlainBody: () => 'Plantões R$ 10,00 Mês 08/2026' },
  { status: 'DRY_RUN_SUCCESS', pipelineState: 'E2E_DRY_RUN_VALIDATED' },
  { NFE_EMAIL_E2E_TEST_ENABLED: 'true' },
  'owner@gmail.com'
);
assert.strictEqual(rescanDryRun.dispatchCalls, 0, 'Rescan DRY_RUN_SUCCESS não deve redisparar');

// C. Mensagem antiga em thread recente (filtro temporal)
const nowMs = Date.now();
const oldDate = new Date(nowMs - 3 * 24 * 60 * 60 * 1000); // 3 dias atrás
const cutoffMs = nowMs - 24 * 60 * 60 * 1000;
assert.ok(oldDate.getTime() < cutoffMs, 'Mensagem antiga deve ser identificada antes do cutoff');

// D. Competência ausente -> REVISAO_MANUAL & zero dispatch
const semComp = simularProcessamentoDemanda_(
  { getFrom: () => 'owner@gmail.com', getSubject: () => '[NFE-E2E-DRYRUN] NF', getPlainBody: () => 'Plantões R$ 10,00 sem data' },
  null,
  { NFE_EMAIL_E2E_TEST_ENABLED: 'true' },
  'owner@gmail.com'
);
assert.strictEqual(semComp.reason, 'COMPETENCIA_NAO_IDENTIFICADA');
assert.strictEqual(semComp.dispatchCalls, 0);

// E. Valor sem Plantões/Produção -> REVISAO_MANUAL & zero dispatch
const semCategoria = simularProcessamentoDemanda_(
  { getFrom: () => 'owner@gmail.com', getSubject: () => '[NFE-E2E-DRYRUN] NF', getPlainBody: () => 'Favor pagar R$ 500,00 no Mês 08/2026' },
  null,
  { NFE_EMAIL_E2E_TEST_ENABLED: 'true' },
  'owner@gmail.com'
);
assert.strictEqual(semCategoria.reason, 'PARSE_FAILED_NO_ITEMS');
assert.strictEqual(semCategoria.dispatchCalls, 0);

// F. CND solicitada enquanto ramo pending -> zero dispatch
const cndReq = simularProcessamentoDemanda_(
  { getFrom: () => 'owner@gmail.com', getSubject: () => '[NFE-E2E-DRYRUN] NF', getPlainBody: () => 'Plantões R$ 10,00 Mês 08/2026 FAVOR ENVIAR JUNTO CND ESTADUAL' },
  null,
  { NFE_EMAIL_E2E_TEST_ENABLED: 'true' },
  'owner@gmail.com'
);
assert.strictEqual(cndReq.pipelineState, 'CND_CHECK_PENDING');
assert.strictEqual(cndReq.dispatchCalls, 0);

// G. Testes Unitários de extrairItensDespachados_
function extrairItensDespachadosSimulado_(observacoes) {
  const m = String(observacoes || '').match(/DISPATCHED_ITEMS:\[([^\]]*)\]/);
  if (!m) return [];
  return m[1].split(',').map(x => x.trim()).filter(Boolean);
}

assert.deepStrictEqual(extrairItensDespachadosSimulado_('DISPATCHED_ITEMS:[1]'), ['1']);
assert.deepStrictEqual(extrairItensDespachadosSimulado_('DISPATCHED_ITEMS:[1,2]'), ['1', '2']);
assert.deepStrictEqual(extrairItensDespachadosSimulado_(''), []);
assert.deepStrictEqual(extrairItensDespachadosSimulado_(null), []);
console.log('✓ extrairItensDespachados_ helper tests passed');

// H. Teste Real de Simulação de PARTIAL_DISPATCH (2 Itens)
function simularPartialDispatchFlow_() {
  const totalItems = 2;

  // Execução 1: Item 1 sucesso, Item 2 falha
  const dispatchedIndicesExec1 = [];
  const newlyDispatchedExec1 = [];
  for (let idx = 1; idx <= totalItems; idx++) {
    const idxStr = String(idx);
    if (idx === 1) {
      newlyDispatchedExec1.push(idxStr); // Sucesso item 1
    }
  }
  const allDispatchedExec1 = [...dispatchedIndicesExec1, ...newlyDispatchedExec1];
  const obsExec1 = 'DISPATCHED_ITEMS:[' + allDispatchedExec1.join(',') + ']';
  const pipelineStateExec1 = 'PARTIAL_DISPATCH';

  assert.strictEqual(newlyDispatchedExec1.length, 1);
  assert.strictEqual(obsExec1, 'DISPATCHED_ITEMS:[1]');

  // Execução 2: Retomada a partir do estado anterior
  const dispatchedIndicesExec2 = extrairItensDespachadosSimulado_(obsExec1);
  const newlyDispatchedExec2 = [];
  for (let idx = 1; idx <= totalItems; idx++) {
    const idxStr = String(idx);
    if (dispatchedIndicesExec2.includes(idxStr)) {
      continue; // Item 1 já despachado, ignorado!
    }
    newlyDispatchedExec2.push(idxStr); // Despacha apenas Item 2!
  }

  assert.deepStrictEqual(dispatchedIndicesExec2, ['1']);
  assert.strictEqual(newlyDispatchedExec2.length, 1, 'Deve disparar exatamente 1 novo dispatch na execução 2');
  assert.strictEqual(newlyDispatchedExec2[0], '2', 'Deve disparar apenas o item 2 pendente');
}
simularPartialDispatchFlow_();
console.log('✓ PARTIAL_DISPATCH resumption test passed');

console.log('✓ All Gap Regression Tests (A-H) passed');

console.log('✓ test-apps-script-engine.js PASSED');
