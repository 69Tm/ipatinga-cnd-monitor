'use strict';

const assert = require('assert');
const { routeProvider } = require('../provider-router');
const { buildReceptionRequest, parseReceptionAcknowledgement, buildReadOnlyConsultationUrl, createNationalNfseProvider } = require('../sigcorp-national-provider');
const { buildNationalSubmitRequest, buildNationalNfseReadRequest, buildNationalDpsReadRequest, createNationalIssuerProvider } = require('../national-emissor-provider');
const { LegacyAbrasfProvider } = require('../legacy-abrasf-provider');

async function run() {
const { reconcileExternalFiscalEvidence } = require('../external-reconciliation');

const historical = routeProvider({ taxRegime: 'SIMPLES_NACIONAL', emissionDate: '2026-10-20' });
assert.strictEqual(historical.provider, 'LEGACY_ABRASF');
assert.strictEqual(historical.writeAllowed, true);
assert.strictEqual(routeProvider({ taxRegime: 'SIMPLES_NACIONAL', emissionDate: '2026-10-21' }).provider, 'NATIONAL_ISSUER');
assert.strictEqual(routeProvider({ taxRegime: 'SIMPLES_NACIONAL', emissionDate: '2026-10-21' }).writeAllowed, false);
assert.strictEqual(routeProvider({ taxRegime: 'SIMPLES_NACIONAL', emissionDate: '2026-10-21', historicalRead: true }).mode, 'historical_read');
assert.strictEqual(routeProvider({ taxRegime: 'SIMPLES_NACIONAL', emissionDate: '' }).reason, 'EMISSION_DATE_REQUIRED');

const request = buildReceptionRequest({ dpsXml: '<DPS/>', nfseNumber: '27', cnpj: '31302407000105', username: 'test-user', password: 'not-logged' });
assert.strictEqual(request.method, 'POST');
assert.strictEqual(request.url, 'https://webservice.meumunicipio.online/v1/nfse/recepcao');
assert.strictEqual(request.headers['X-NFSe-nNFSe'], '27');
assert.strictEqual(request.headers['X-NFSe-Prestador-CNPJ'], '31302407000105');
assert.strictEqual(request.body, '<DPS/>');
assert.strictEqual(parseReceptionAcknowledgement({ statusCode: 202, body: '{"protocolo":"abc-123"}' }).status, 'SUBMITTED_ASYNC_PROCESSING');
assert.strictEqual(parseReceptionAcknowledgement({ statusCode: 202, body: '{"protocolo":"abc-123"}' }).protocol, 'abc-123');
assert.strictEqual(buildReadOnlyConsultationUrl({ protocol: 'abc-123' }), 'https://webservice.meumunicipio.online/v1/nfse/consulta/abc-123');
assert.throws(() => buildReceptionRequest({ dpsXml: '<DPS/>', nfseNumber: '27', cnpj: '31302407000105', username: '', password: '' }), /CREDENTIALS_MISSING/);
assert.throws(() => createNationalNfseProvider().submit(), /SIGCORP_PROVIDER_WRITE_NOT_VALIDATED/);
const nationalPost = buildNationalSubmitRequest({ dpsXml: '<DPS/>', baseUrl: 'https://adn.nfse.gov.br/contribuintes' });
assert.strictEqual(nationalPost.method, 'POST');
assert.strictEqual(nationalPost.url, 'https://adn.nfse.gov.br/contribuintes/nfse');
assert.strictEqual(nationalPost.tls.rejectUnauthorized, true);
assert.strictEqual(buildNationalNfseReadRequest({ accessKey: 'key-25' }).method, 'GET');
assert.strictEqual(buildNationalDpsReadRequest({ dpsId: 'DPS-id', method: 'HEAD' }).method, 'HEAD');
assert.throws(() => createNationalIssuerProvider().submit(), /NATIONAL_ISSUER_WRITE_NOT_VALIDATED/);
assert.throws(() => buildNationalSubmitRequest({ dpsXml: '<DPS/>', baseUrl: 'http://unsafe.example' }), /HTTPS_REQUIRED/);
let legacyCalls = 0;
const legacyHistorical = new LegacyAbrasfProvider({ issueDate: '2026-10-20', callSoapOperation: async () => { legacyCalls++; return 'ok'; } });
assert.strictEqual(await legacyHistorical.submit({ operation: 'GerarNfse' }), 'ok');
const legacyCurrent = new LegacyAbrasfProvider({ issueDate: '2026-10-21', callSoapOperation: async () => { legacyCalls++; return 'unsafe'; } });
await assert.rejects(() => legacyCurrent.submit({ operation: 'GerarNfse' }), /LEGACY_ABRASF_WRITER_DISABLED/);
assert.strictEqual(legacyCalls, 1);

const demand = {
  threadId: 'thread-1',
  items: [
    { cnpj: '20724357000120', recipient: 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO', referencePeriod: '09/2026', description: 'Plantões Médicos P.S SUS', amount: 7700 },
    { cnpj: '20724357000120', recipient: 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO', referencePeriod: '09/2026', description: 'Produção P.S SUS', amount: 1560 }
  ]
};
const sentReply = { sent: true, threadId: 'thread-1', messageId: 'sent-1', attachments: ['nfe 1.pdf', 'nfe 2.pdf'], certificateCategories: ['CRF_FGTS', 'CNDT', 'FEDERAL', 'ESTADUAL_MG', 'MUNICIPAL_IPATINGA', 'FALENCIA_TJMG'] };
const officialDocuments = [
  { type: 'OFFICIAL_DANFSE_PDF', threadId: 'thread-1', sourceMessageId: 'sent-1', nfseNumber: '25', cnpj: '20724357000120', recipient: 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO', referencePeriod: '09/2026', description: 'Referente a Plantões Médicos P.S SUS no Mês 09/2026', amount: 7700 },
  { type: 'OFFICIAL_DANFSE_PDF', threadId: 'thread-1', sourceMessageId: 'sent-1', nfseNumber: '26', cnpj: '20724357000120', recipient: 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO', referencePeriod: '09/2026', description: 'Referente a Produção P.S SUS no Mês 09/2026', amount: 1560 }
];
assert.strictEqual(reconcileExternalFiscalEvidence({ demand, providerAvailable: true }).decision, 'PREPARE');
const recovered = reconcileExternalFiscalEvidence({ demand, sentReply, officialDocuments, providerAvailable: false });
assert.strictEqual(recovered.decision, 'RECONCILE_EXISTING');
assert.strictEqual(recovered.status, 'COMPLETED_SENT');
assert.deepStrictEqual(recovered.sideEffects, { newDps: 0, newRps: 0, newNfse: 0, newEmails: 0, newDrafts: 0, newProviderWrites: 0 });
assert.strictEqual(reconcileExternalFiscalEvidence({ demand, sentReply, officialDocuments: [officialDocuments[0]], providerAvailable: false }).decision, 'BLOCKED');
assert.strictEqual(reconcileExternalFiscalEvidence({ demand, sentReply, officialDocuments: [{ type: 'OFFICIAL_DANFSE_PDF', threadId: 'thread-1', amount: 7700 }], providerAvailable: true }).decision, 'REVIEW_REQUIRED');
assert.strictEqual(reconcileExternalFiscalEvidence({ demand, sentReply, officialDocuments: [...officialDocuments, officialDocuments[0]], providerAvailable: true }).reason, 'AMBIGUOUS_OFFICIAL_DOCUMENT_MATCH');
assert.strictEqual(reconcileExternalFiscalEvidence({ demand, providerAvailable: false }).reason, 'PROVIDER_UNAVAILABLE_WITHOUT_OFFICIAL_EVIDENCE');

console.log('✓ test-provider-routing-and-recovery.js PASSED');
}

module.exports = run();
