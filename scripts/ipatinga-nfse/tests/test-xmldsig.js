'use strict';

const assert = require('assert');
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
          <ValorDeducoes>0</ValorDeducoes>
          <ValorPis>0</ValorPis>
          <ValorCofins>0</ValorCofins>
          <ValorInss>0</ValorInss>
          <ValorIr>0</ValorIr>
          <ValorCsll>0</ValorCsll>
          <OutrasRetencoes>0</OutrasRetencoes>
          <ValTotTributos>0</ValTotTributos>
          <ValorIss>0</ValorIss>
          <Aliquota>0.0000</Aliquota>
          <DescontoIncondicionado>0</DescontoIncondicionado>
          <DescontoCondicionado>0</DescontoCondicionado>
        </Valores>
        <IssRetido>2</IssRetido>
        <ItemListaServico>01.01</ItemListaServico>
        <CodigoCnae>8610701</CodigoCnae>
        <CodigoTributacaoMunicipio>403</CodigoTributacaoMunicipio>
        <Discriminacao>Plantao</Discriminacao>
        <CodigoMunicipio>3128006</CodigoMunicipio>
        <CodigoPais>1058</CodigoPais>
        <ExigibilidadeISS>1</ExigibilidadeISS>
        <MunicipioIncidencia>3128006</MunicipioIncidencia>
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
        <RazaoSocial>HOSPITAL IMACULADA CONCEICAO</RazaoSocial>
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

  // 2. Verificação independente de assinatura
  const isValid = verifyXmlSignature({
    signedXml,
    pemCert
  });
  assert.strictEqual(isValid, true, 'Assinatura XMLDSig deve ser criptograficamente válida');

  // 3. Validação do XML assinado contra o XSD oficial
  const xsdRes = await validateXmlAgainstOfficialXsd(signedXml, 'GerarNfseEnvio');
  assert.strictEqual(xsdRes.valid, true, `XML assinado deve validar contra schema oficial: ${xsdRes.errors.join('; ')}`);

  console.log('✓ test-xmldsig.js PASSED');
}

module.exports = run();
