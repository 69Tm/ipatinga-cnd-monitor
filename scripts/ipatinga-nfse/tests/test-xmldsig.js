'use strict';

const assert = require('assert');
const forge = require('node-forge');
const { signXmlNode, verifyXmlSignature } = require('../xmldsig');

console.log('Running test-xmldsig.js...');

// Gera par de chaves RSA sintético para teste de assinatura
const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
const cert = forge.pki.createCertificate();
cert.publicKey = keypair.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

const attrs = [{ name: 'commonName', value: 'DEXMED TEST CERT' }];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.sign(keypair.privateKey, forge.md.sha256.create());

const pemCert = forge.pki.certificateToPem(cert);
const pemKey = forge.pki.privateKeyToPem(keypair.privateKey);

const sampleDpsXml = `<InfDeclaracaoPrestacaoServico Id="RPS1001A">
  <Rps><IdentificacaoRps><Numero>1001</Numero><Serie>A</Serie><Tipo>1</Tipo></IdentificacaoRps></Rps>
  <Competencia>2026-08-01</Competencia>
  <Servico><Valores><ValorServicos>1000.00</ValorServicos></Valores></Servico>
</InfDeclaracaoPrestacaoServico>`;

const signatureBlock = signXmlNode({
  xmlNode: sampleDpsXml,
  targetId: 'RPS1001A',
  pemKey,
  pemCert
});

assert.ok(signatureBlock.includes('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">'));
assert.ok(signatureBlock.includes('URI="#RPS1001A"'));
assert.ok(signatureBlock.includes('<DigestValue>'));
assert.ok(signatureBlock.includes('<SignatureValue>'));
assert.ok(signatureBlock.includes('<X509Certificate>'));

const isValid = verifyXmlSignature({
  xmlNode: sampleDpsXml,
  signatureBlock,
  pemCert
});
assert.strictEqual(isValid, true, 'Assinatura XMLDSig deve ser criptograficamente válida');

console.log('✓ test-xmldsig.js PASSED');
