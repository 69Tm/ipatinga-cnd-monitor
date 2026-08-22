'use strict';

const crypto = require('crypto');

/**
 * Normaliza e canonicaliza um nó XML (C14N simplificada para nós bem formados)
 */
function canonicalizeXml(xmlSnippet) {
  return String(xmlSnippet || '')
    .replace(/>\s+</g, '><')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

/**
 * Assina um nó XML (como InfDeclaracaoPrestacaoServico) usando chave privada RSA e gera envelope XMLDSig
 */
function signXmlNode({ xmlNode, targetId, pemKey, pemCert }) {
  if (!xmlNode || !targetId || !pemKey || !pemCert) {
    throw new Error('XMLDSIG_PARAM_MISSING: xmlNode, targetId, pemKey e pemCert são obrigatórios.');
  }

  const canonicalTarget = canonicalizeXml(xmlNode);
  const digestSha1 = crypto.createHash('sha1').update(canonicalTarget, 'utf8').digest('base64');

  const signedInfo = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod>` +
    `<Reference URI="#${targetId}">` +
      `<Transforms>` +
        `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform>` +
        `<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></Transform>` +
      `</Transforms>` +
      `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod>` +
      `<DigestValue>${digestSha1}</DigestValue>` +
    `</Reference>` +
  `</SignedInfo>`;

  const canonicalSignedInfo = canonicalizeXml(signedInfo);
  const signer = crypto.createSign('RSA-SHA1');
  signer.update(canonicalSignedInfo, 'utf8');
  const signatureValue = signer.sign(pemKey, 'base64');

  const certDerBase64 = pemCert
    .replace(/-----BEGIN[A-Z\s]+CERTIFICATE-----/g, '')
    .replace(/-----END[A-Z\s]+CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');

  const signatureBlock = `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    signedInfo +
    `<SignatureValue>${signatureValue}</SignatureValue>` +
    `<KeyInfo>` +
      `<X509Data>` +
        `<X509Certificate>${certDerBase64}</X509Certificate>` +
      `</X509Data>` +
    `</KeyInfo>` +
  `</Signature>`;

  return signatureBlock;
}

/**
 * Valida criptograficamente uma assinatura XMLDSig gerada
 */
function verifyXmlSignature({ xmlNode, signatureBlock, pemCert }) {
  const digestMatch = signatureBlock.match(/<DigestValue>([^<]+)<\/DigestValue>/);
  const sigMatch = signatureBlock.match(/<SignatureValue>([^<]+)<\/SignatureValue>/);
  const signedInfoMatch = signatureBlock.match(/<SignedInfo[\s\S]*?<\/SignedInfo>/);

  if (!digestMatch || !sigMatch || !signedInfoMatch) return false;

  const digestExpected = digestMatch[1];
  const signatureValue = sigMatch[1];
  const signedInfoXml = signedInfoMatch[0];

  const canonicalTarget = canonicalizeXml(xmlNode);
  const digestActual = crypto.createHash('sha1').update(canonicalTarget, 'utf8').digest('base64');
  if (digestExpected !== digestActual) return false;

  const canonicalSignedInfo = canonicalizeXml(signedInfoXml);
  const verifier = crypto.createVerify('RSA-SHA1');
  verifier.update(canonicalSignedInfo, 'utf8');
  return verifier.verify(pemCert, signatureValue, 'base64');
}

module.exports = {
  canonicalizeXml,
  signXmlNode,
  verifyXmlSignature
};
