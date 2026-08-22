'use strict';

const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('@xmldom/xmldom');

/**
 * Assina um elemento XML (InfDeclaracaoPrestacaoServico) dentro do documento GerarNfseEnvio
 * utilizando W3C Canonical XML 1.0 (C14N), Enveloped Signature, SHA-1 Digest e RSA-SHA1.
 * 
 * Mantém o contexto de namespaces do nó pai (http://www.abrasf.org.br/nfse.xsd).
 */
function signXmlNode({ xml, targetId, pemKey, pemCert }) {
  if (!xml || !targetId || !pemKey || !pemCert) {
    throw new Error('XMLDSIG_PARAM_MISSING: xml, targetId, pemKey e pemCert são obrigatórios.');
  }

  const sig = new SignedXml();
  sig.privateKey = pemKey;
  sig.publicCert = pemCert;
  
  sig.addReference({
    xpath: `//*[@Id='${targetId}']`,
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"
    ],
    digestAlgorithm: "http://www.w3.org/2000/09/xmldsig#sha1"
  });

  sig.signatureAlgorithm = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
  sig.canonicalizationAlgorithm = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";

  const certDer = pemCert
    .replace(/-----BEGIN[A-Z\s]+CERTIFICATE-----/g, '')
    .replace(/-----END[A-Z\s]+CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');

  sig.keyInfoProvider = {
    getKeyInfo: () => `<X509Data><X509Certificate>${certDer}</X509Certificate></X509Data>`
  };

  sig.computeSignature(xml, {
    prefix: '',
    location: { reference: `//*[@Id='${targetId}']`, action: "after" }
  });

  return sig.getSignedXml();
}

/**
 * Validação independente de assinatura XMLDSig
 */
function verifyXmlSignature({ signedXml, pemCert }) {
  try {
    const doc = new DOMParser().parseFromString(signedXml);
    const signatureNodes = doc.getElementsByTagNameNS("http://www.w3.org/2000/09/xmldsig#", "Signature");
    if (!signatureNodes || signatureNodes.length === 0) return false;

    const verifier = new SignedXml();
    verifier.publicCert = pemCert;
    verifier.loadSignature(signatureNodes[0]);
    return verifier.checkSignature(signedXml);
  } catch (err) {
    return false;
  }
}

module.exports = {
  signXmlNode,
  verifyXmlSignature
};
