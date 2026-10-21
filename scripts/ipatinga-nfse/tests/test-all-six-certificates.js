'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const crypto = require('crypto');

const source = fs.readFileSync(path.resolve(__dirname, '../../../apps-script/Codigo_v3.4.3_patched.gs'), 'utf8');
const tipos = ['CRF FGTS', 'CNDT', 'CND Federal', 'CND Estadual MG', 'CND Municipal', 'Certidão Falência/Concordata'];
const reference = new Date('2026-10-20T12:00:00Z');
let renewalCalls = 0;
let allowRenewals = false;
let historico = tipos.map((tipo, i) => ({ tipo, fileId: 'file-' + i, emissao: new Date('2026-10-01T00:00:00Z'), validade: new Date('2026-11-01T00:00:00Z') }));
const context = vm.createContext({ console, Date, PropertiesService: { getScriptProperties: () => ({ getProperty: () => String(allowRenewals) }) } });
vm.runInContext(source, context);
context.carregarHistoricoCndsPlanilha_ = () => historico;
context.obterSituacaoCndsParaCnpj_ = () => ({ validas: historico, vencidas: [], ausentes: [] });
context.renovarCndsVencidasAutomaticamente_ = () => { renewalCalls++; throw new Error('PAID_API_MUST_NOT_RUN'); };

// Executa as funções reais do .gs; a solicitação original de apenas FGTS/Falência
// continua sendo preservada em Demandas, sem limitar o pacote do draft.
let result = context.verificarPacoteCompletoCndsParaRascunho_(reference);
const parsed = context.extrairItensDemandaHic_('Gentileza emitir: Plantões Médicos PS SUS no Mês 09/2026 R$ 7.700,00.\nProdução PS SUS R$ 1.560,00.\nFAVOR ENVIAR FALENCIA E FGTS');
assert.strictEqual(parsed.itens.length, 2);
assert.strictEqual(parsed.cndsExigidas.split(';').length, 2);
assert.strictEqual(result.requiredAttachmentPolicy, 'ALL_SIX_CERTIFICATES');
assert.deepStrictEqual(Array.from(result.exigidas), tipos);
assert.strictEqual(result.cndsParaAnexo.length, 6);
assert.strictEqual(result.todasValidas, true);
assert.strictEqual(renewalCalls, 0);
assert.ok(source.includes("'PROVIDER_PREFLIGHT_BLOCKED'"), 'preflight externo bloqueado não autoriza dispatch automático');
assert.ok(source.includes('const cndCheck = verificarPacoteCompletoCndsParaRascunho_();'));

historico = historico.slice(0, 5);
result = context.verificarPacoteCompletoCndsParaRascunho_(reference);
assert.strictEqual(result.todasValidas, false);
assert.strictEqual(result.pendencias[0].motivo, 'CERTIFICATE_RENEWAL_REQUIRES_AUTHORIZATION');
assert.strictEqual(result.renewalsAttempted, 0);
assert.strictEqual(renewalCalls, 0);

const blob = (name, value = '%PDF-official-' + name) => ({
  name, getBytes: () => Array.from(Buffer.from(value)), setName() { return this; }
});
const certs = tipos.map((tipo, i) => ({ tipo, fileId: 'file-' + i }));
context.DriveApp = { getFileById: id => ({ getBlob: () => blob(id), getName: () => id + '.pdf' }) };
const attachments = [blob('nfse-1'), blob('nfse-2')];
context.anexarPacoteCompletoCnds_({ todasValidas: true, cndsParaAnexo: certs }, attachments);
assert.strictEqual(attachments.length, 8);

for (const bad of [certs.slice(0, 5), certs.map(c => ({ ...c, fileId: 'same-file' }))]) {
  assert.throws(() => context.anexarPacoteCompletoCnds_({ todasValidas: true, cndsParaAnexo: bad }, []), /ALL_SIX_CERTIFICATES_REQUIRED/);
}
context.DriveApp = { getFileById: id => {
  if (id === 'file-5') throw new Error('DRIVE_UNAVAILABLE');
  return { getBlob: () => blob(id), getName: () => id + '.pdf' };
} };
const unchanged = [blob('nfse-1'), blob('nfse-2')];
assert.throws(() => context.anexarPacoteCompletoCnds_({ todasValidas: true, cndsParaAnexo: certs }, unchanged), /DRIVE_UNAVAILABLE/);
assert.strictEqual(unchanged.length, 2, 'nenhum pacote parcial deve ser anexado');
context.DriveApp = { getFileById: id => ({ getBlob: () => blob(id, '<html>error</html>'), getName: () => id + '.pdf' }) };
assert.throws(() => context.anexarPacoteCompletoCnds_({ todasValidas: true, cndsParaAnexo: certs }, []), /CERTIFICATE_PDF_INVALID/);

const docs = [{ itemIndex: '1', nfseNumero: '24' }, { itemIndex: '2', nfseNumero: '25' }];
assert.strictEqual(context.documentosDaDemandaCompletos_(docs, '24; 25', 2), true);
assert.strictEqual(context.documentosDaDemandaCompletos_(docs.slice(0, 1), '24; 25', 2), false);
assert.strictEqual(context.documentosDaDemandaCompletos_([docs[0], docs[0]], '24; 25', 2), false);
assert.strictEqual(context.documentosDaDemandaCompletos_([{ ...docs[0], itemIndex: '3' }, docs[1]], '24; 25', 2), false);
context.calcularSha256Blob_ = b => crypto.createHash('sha256').update(Buffer.from(b.getBytes())).digest('hex');
assert.strictEqual(context.anexosCorrespondemAoPacote_(attachments, [...attachments].reverse()), true);
assert.strictEqual(context.anexosCorrespondemAoPacote_(attachments, attachments.slice(0, 7)), false);
assert.strictEqual(context.anexosCorrespondemAoPacote_(attachments, [...attachments.slice(0, 7), blob('wrong')]), false);
assert.ok(source.includes("pipelineState === 'DRAFT_CREATED'"), 'demandas já concluídas permanecem intocadas');
console.log('✓ test-all-six-certificates.js PASSED: pacote completo, ausência/erro fail-closed, zero renovação paga, dois itens e hashes integrais');
