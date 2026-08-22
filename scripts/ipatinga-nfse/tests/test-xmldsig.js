'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const forge = require('node-forge');
const { signXmlNode, verifyXmlSignature } = require('../xmldsig');
const { validateXmlAgainstOfficialXsd } = require('../xsd-validator');

console.log('Running test-xmldsig.js...');

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

const validXml = `<GerarNfseEnvio xmlns="http://www.abrasf.org.br/nfse.xsd">
  <Rps>
    <InfDeclaracaoPrestacaoServico Id="RPS1001">
      <Rps>
        <IdentificacaoRps>
          <Numero>1001</Numero>
          <Serie>A</Serie>
          <Tipo>1</Tipo>
        </IdentificacaoRps>
        <DataEmissao>2026-08-22</DataEmissao>
        <Status>1</Status>
      </Rps>
      <Competencia>2026-08-01</Competencia>
      <Servico>
        <Valores>
          <ValorServicos>1000.00</ValorServicos>
        </Valores>
        <IssRetido>2</IssRetido>
        <ItemListaServico>01.01</ItemListaServico>
        <CodigoTributacaoMunicipio>403</CodigoTributacaoMunicipio>
        <Discriminacao>Plantao &amp; Atendimento &lt;Especial&gt; &quot;DEXMED&quot;</Discriminacao>
        <CodigoMunicipio>3128006</CodigoMunicipio>
        <CodigoPais>1058</CodigoPais>
        <ExigibilidadeISS>1</ExigibilidadeISS>
        <MunicipioIncidencia>3128006</MunicipioIncidencia>
        <cNBS>123011900</cNBS>
      </Servico>
      <Prestador>
        <CpfCnpj>
          <Cnpj>31302407000105</Cnpj>
        </CpfCnpj>
        <InscricaoMunicipal>23297500</InscricaoMunicipal>
      </Prestador>
      <TomadorServico>
        <IdentificacaoTomador>
          <CpfCnpj>
            <Cnpj>20724357000120</Cnpj>
          </CpfCnpj>
        </IdentificacaoTomador>
        <RazaoSocial>HOSPITAL IMACULADA CONCEICAO &amp; CIA</RazaoSocial>
      </TomadorServico>
      <OptanteSimplesNacional>1</OptanteSimplesNacional>
      <IncentivoFiscal>2</IncentivoFiscal>
    </InfDeclaracaoPrestacaoServico>
  </Rps>
</GerarNfseEnvio>`;

async function run() {
  // 1. Assina com Canonical XML 1.0 (C14N) e RSA-SHA1
  const signedXml = signXmlNode({
    xml: validXml,
    targetId: 'RPS1001',
    pemKey,
    pemCert
  });

  assert.ok(signedXml.includes('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">'));
  assert.ok(signedXml.includes('URI="#RPS1001"'));
  assert.ok(signedXml.includes('<DigestValue>'));
  assert.ok(signedXml.includes('<SignatureValue>'));
  assert.ok(signedXml.includes('<X509Certificate>'));
  assert.ok(!signedXml.includes('<Aliquota>0.0000</Aliquota>'), 'NÃO deve conter Aliquota zero artificial');
  assert.ok(!signedXml.includes('<ValorIss>0</ValorIss>'), 'NÃO deve conter ValorIss zero artificial');
  assert.ok(!signedXml.includes('<CodigoCnae>8610701</CodigoCnae>'), 'NÃO deve conter CNAE inventado');

  // 2. Verificação de integridade e falha em tamper
  const isValid = verifyXmlSignature({ signedXml, pemCert });
  assert.strictEqual(isValid, true, 'Assinatura XMLDSig deve ser criptograficamente válida');

  const tamperedXml = signedXml.replace('1000.00', '2000.00');
  const isTamperedValid = verifyXmlSignature({ signedXml: tamperedXml, pemCert });
  assert.strictEqual(isTamperedValid, false, 'Assinatura deve falhar em caso de alteração no conteúdo assinado');

  // 3. Validação do XML assinado contra o XSD oficial (incluindo cNBS e sem zeros opcionais)
  const xsdRes = await validateXmlAgainstOfficialXsd(signedXml, 'GerarNfseEnvio');
  assert.strictEqual(xsdRes.valid, true, `XML assinado deve validar contra schema oficial: ${xsdRes.errors.join('; ')}`);

  // 4. Verificação independente via xmlsec1 com FAIL-CLOSED estrito
  const tempDir = path.join(__dirname, '..', 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const xmlPath = path.join(tempDir, 'signed-test.xml');
  const tamperedValPath = path.join(tempDir, 'signed-tampered-val.xml');
  const tamperedSigPath = path.join(tempDir, 'signed-tampered-sig.xml');
  const certPath = path.join(tempDir, 'cert-test.pem');

  fs.writeFileSync(xmlPath, signedXml, 'utf8');
  fs.writeFileSync(tamperedValPath, signedXml.replace('1000.00', '2000.00'), 'utf8');
  fs.writeFileSync(tamperedSigPath, signedXml.replace(/<SignatureValue>[^<]+<\/SignatureValue>/, '<SignatureValue>AAAA==</SignatureValue>'), 'utf8');
  fs.writeFileSync(certPath, pemCert, 'utf8');

  let xmlsecExists = false;
  try {
    execSync('xmlsec1 --version', { stdio: 'pipe' });
    xmlsecExists = true;
  } catch (e) {
    if (process.env.GITHUB_ACTIONS) {
      throw new Error('XMLSEC1_MISSING_IN_CI: xmlsec1 deve estar instalado no ambiente de CI do GitHub Actions.');
    }
  }

  if (xmlsecExists) {
    // A. XML original -> DEVE PASSAR (FAIL-CLOSED)
    execSync(`xmlsec1 --verify --pubkey-cert-pem "${certPath}" --id-attr:Id InfDeclaracaoPrestacaoServico "${xmlPath}"`, { stdio: 'pipe' });
    console.log('  ✓ [A] Verificação independente nativa xmlsec1 XML ORIGINAL: OK');

    // B. Alterar ValorServicos após assinatura -> xmlsec1 DEVE FALHAR
    let valTamperFailed = false;
    try {
      execSync(`xmlsec1 --verify --pubkey-cert-pem "${certPath}" --id-attr:Id InfDeclaracaoPrestacaoServico "${tamperedValPath}"`, { stdio: 'pipe' });
    } catch (e) {
      valTamperFailed = true;
    }
    assert.strictEqual(valTamperFailed, true, 'xmlsec1 DEVE falhar ao verificar XML com ValorServicos adulterado');
    console.log('  ✓ [B] xmlsec1 rejeitou alteração em ValorServicos: OK');

    // C. Alterar SignatureValue -> xmlsec1 DEVE FALHAR
    let sigTamperFailed = false;
    try {
      execSync(`xmlsec1 --verify --pubkey-cert-pem "${certPath}" --id-attr:Id InfDeclaracaoPrestacaoServico "${tamperedSigPath}"`, { stdio: 'pipe' });
    } catch (e) {
      sigTamperFailed = true;
    }
    assert.strictEqual(sigTamperFailed, true, 'xmlsec1 DEVE falhar ao verificar XML com SignatureValue adulterado');
    console.log('  ✓ [C] xmlsec1 rejeitou alteração em SignatureValue: OK');
  } else {
    console.log('  (xmlsec1 não disponível no ambiente local Windows; será executado com fail-closed no GitHub Actions)');
  }

  // Cleanup
  try {
    if (fs.existsSync(xmlPath)) fs.unlinkSync(xmlPath);
    if (fs.existsSync(tamperedValPath)) fs.unlinkSync(tamperedValPath);
    if (fs.existsSync(tamperedSigPath)) fs.unlinkSync(tamperedSigPath);
    if (fs.existsSync(certPath)) fs.unlinkSync(certPath);
  } catch (_) {}

  console.log('✓ test-xmldsig.js PASSED');
}

module.exports = run();
