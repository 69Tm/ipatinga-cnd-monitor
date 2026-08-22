'use strict';

const assert = require('assert');
const { validateXmlAgainstOfficialXsd } = require('../xsd-validator');

console.log('Running test-xsd.js...');

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
  // 1. XML válido contra schema_2.04.xsd oficial
  const resValid = await validateXmlAgainstOfficialXsd(validXml, 'GerarNfseEnvio');
  assert.strictEqual(resValid.valid, true, `Esperado XML válido no engine XSD: ${resValid.errors.join('; ')}`);
  assert.strictEqual(resValid.schemaFile, 'schema_2.04.xsd');
  assert.ok(resValid.engine.includes('xmllint-wasm'));

  // 2. Elemento obrigatório ausente (ValorServicos)
  const missingValXml = validXml.replace('<ValorServicos>1000.00</ValorServicos>', '');
  const resMissingVal = await validateXmlAgainstOfficialXsd(missingValXml, 'GerarNfseEnvio');
  assert.strictEqual(resMissingVal.valid, false, 'Engine XSD deve rejeitar falta de ValorServicos');

  // 3. Ordem de elementos incorreta na sequência pai (Prestador antes de Servico)
  const wrongOrderXml = validXml.replace(
    /<Servico>[\s\S]*?<\/Servico>\s*<Prestador>[\s\S]*?<\/Prestador>/,
    '<Prestador><CpfCnpj><Cnpj>31302407000105</Cnpj></CpfCnpj><InscricaoMunicipal>23297500</InscricaoMunicipal></Prestador><Servico><Valores><ValorServicos>1000.00</ValorServicos></Valores><IssRetido>2</IssRetido><ItemListaServico>01.01</ItemListaServico><CodigoCnae>8610701</CodigoCnae><CodigoTributacaoMunicipio>403</CodigoTributacaoMunicipio><Discriminacao>Plantao</Discriminacao><CodigoMunicipio>3128006</CodigoMunicipio><CodigoPais>1058</CodigoPais><ExigibilidadeISS>1</ExigibilidadeISS><MunicipioIncidencia>3128006</MunicipioIncidencia></Servico>'
  );
  const resWrongOrder = await validateXmlAgainstOfficialXsd(wrongOrderXml, 'GerarNfseEnvio');
  assert.strictEqual(resWrongOrder.valid, false, 'Engine XSD deve rejeitar violação de sequência/ordem');

  // 4. Tipo inválido / enum (IssRetido = 9)
  const invalidEnumXml = validXml.replace('<IssRetido>2</IssRetido>', '<IssRetido>9</IssRetido>');
  const resInvalidEnum = await validateXmlAgainstOfficialXsd(invalidEnumXml, 'GerarNfseEnvio');
  assert.strictEqual(resInvalidEnum.valid, false, 'Engine XSD deve rejeitar enumeração inválida');

  // 5. Cardinalidade / maxLength excedido (CNPJ com 15 dígitos)
  const invalidLengthXml = validXml.replace('31302407000105', '313024070001059');
  const resInvalidLength = await validateXmlAgainstOfficialXsd(invalidLengthXml, 'GerarNfseEnvio');
  assert.strictEqual(resInvalidLength.valid, false, 'Engine XSD deve rejeitar maxLength excedido');

  // 6. Namespace incorreto
  const wrongNsXml = validXml.replace('http://www.abrasf.org.br/nfse.xsd', 'http://outro.namespace.com');
  const resWrongNs = await validateXmlAgainstOfficialXsd(wrongNsXml, 'GerarNfseEnvio');
  assert.strictEqual(resWrongNs.valid, false, 'Engine XSD deve rejeitar namespace incorreto');

  console.log('✓ test-xsd.js PASSED');
}

module.exports = run();
