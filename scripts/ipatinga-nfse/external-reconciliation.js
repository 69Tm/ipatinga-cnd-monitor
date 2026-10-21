'use strict';

function normalizeText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function reconcileExternalFiscalEvidence({ demand, sentReply, officialDocuments = [], providerAvailable = true }) {
  if (!demand || !Array.isArray(demand.items) || demand.items.length === 0) return { decision: 'REVIEW_REQUIRED', reason: 'DEMAND_ITEMS_MISSING', items: [] };
  if (!sentReply || sentReply.sent !== true || sentReply.threadId !== demand.threadId) {
    return providerAvailable
      ? { decision: 'PREPARE', reason: 'NO_MATCHING_SENT_REPLY', items: [] }
      : { decision: 'BLOCKED', reason: 'PROVIDER_UNAVAILABLE_WITHOUT_OFFICIAL_EVIDENCE', items: [] };
  }
  const requiredCertificates = ['CRF_FGTS', 'CNDT', 'FEDERAL', 'ESTADUAL_MG', 'MUNICIPAL_IPATINGA', 'FALENCIA_TJMG'];
  const sentCertificates = new Set((sentReply.certificateCategories || []).map(value => String(value || '').trim().toUpperCase()));
  const allCertificatesAttached = requiredCertificates.every(category => sentCertificates.has(category));

  const matches = demand.items.map((item, index) => {
    const candidates = officialDocuments.filter(doc => {
      if (doc.type !== 'OFFICIAL_DANFSE_PDF' || doc.threadId !== sentReply.threadId || doc.sourceMessageId !== sentReply.messageId) return false;
      return String(doc.cnpj || '') === String(item.cnpj || '') &&
        String(doc.referencePeriod || '') === String(item.referencePeriod || '') &&
        Number(doc.amount) === Number(item.amount) &&
        normalizeText(doc.recipient) === normalizeText(item.recipient) &&
        normalizeText(doc.description).includes(normalizeText(item.description));
    });
    if (candidates.length > 1) return { itemIndex: index + 1, status: 'AMBIGUOUS', candidates: candidates.length };
    if (candidates.length === 0) return { itemIndex: index + 1, status: 'MISSING' };
    return { itemIndex: index + 1, status: 'MATCHED', document: candidates[0] };
  });

  if (matches.some(match => match.status === 'AMBIGUOUS')) return { decision: 'REVIEW_REQUIRED', reason: 'AMBIGUOUS_OFFICIAL_DOCUMENT_MATCH', items: matches };
  if (matches.every(match => match.status === 'MATCHED') && allCertificatesAttached) {
    return { decision: 'RECONCILE_EXISTING', status: 'COMPLETED_SENT', items: matches, sideEffects: { newDps: 0, newRps: 0, newNfse: 0, newEmails: 0, newDrafts: 0, newProviderWrites: 0 } };
  }
  if (!providerAvailable) return { decision: 'BLOCKED', reason: !allCertificatesAttached ? 'SENT_REPLY_CERTIFICATE_SET_INCOMPLETE' : 'PROVIDER_UNAVAILABLE_WITH_INCOMPLETE_EVIDENCE', items: matches };
  return { decision: 'REVIEW_REQUIRED', reason: !allCertificatesAttached ? 'SENT_REPLY_CERTIFICATE_SET_INCOMPLETE' : 'INCOMPLETE_OFFICIAL_DOCUMENT_SET', items: matches };
}

module.exports = { normalizeText, reconcileExternalFiscalEvidence };
