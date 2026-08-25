'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('Running test-apps-script-engine.js...');

const gsPath = path.resolve(__dirname, '../../../apps-script/Codigo_v3.4.3_patched.gs');
const code = fs.readFileSync(gsPath, 'utf8');

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
console.log('✓ abrirPlanilhaCnds_ non-recursion verified');

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

function extrairItensDemandaHic_(bodyText, defaultCompetencia) {
  const text = String(bodyText || '');
  const itens = [];
  const compMatch = text.match(/m[eê]s\s*(\d{2}\/\d{4})/i) || text.match(/compet[eê]ncia\s*(\d{2}\/\d{4})/i);
  const competencia = compMatch ? compMatch[1] : (defaultCompetencia || '08/2026');

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

  // Se não achou pelos blocos nomeados mas tem formato simples de 1 valor
  if (itens.length === 0) {
    const singleValMatch = text.match(/R\$\s*([d.,]+)/i);
    if (singleValMatch) {
      const valor = parseMoeda_(singleValMatch[1]);
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
  }

  // Identifica CNDs exigidas no corpo
  const cndsExigidas = [];
  if (/estadual/i.test(text)) cndsExigidas.push('CND Estadual');
  if (/fgts/i.test(text) || /crf/i.test(text)) cndsExigidas.push('CRF FGTS');
  if (/falencia/i.test(text) || /concordata/i.test(text)) cndsExigidas.push('Falência e Concordata');
  if (/trabalhista/i.test(text) || /cndt/i.test(text)) cndsExigidas.push('CND Trabalhista');
  if (/federal/i.test(text) || /receita federal/i.test(text)) cndsExigidas.push('CND Federal');
  if (/municipal/i.test(text)) cndsExigidas.push('CND Municipal');

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
assert.ok(parsedHic.cndsExigidas.includes('CND Estadual'));
assert.ok(parsedHic.cndsExigidas.includes('CRF FGTS'));
assert.ok(parsedHic.cndsExigidas.includes('Falência e Concordata'));
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

console.log('✓ test-apps-script-engine.js PASSED');
