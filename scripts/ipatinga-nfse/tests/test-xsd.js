'use strict';

const assert = require('assert');
const { validateXmlAgainstAbrasf204 } = require('../xsd-validator');

console.log('Running test-xsd.js...');

const validXml = `<GerarNfseEnvio xmlns="http://www.abrasf.org.br/nfse.xsd">
  <Rps>
    <InfDeclaracaoPrestacaoServico Id="RPS1001A">
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
        <ItemListaServico>04.03</ItemListaServico>
        <CodigoTributacaoMunicipio>403</CodigoTributacaoMunicipio>
        <Discriminacao>Serviços médicos em pronto socorro SUS</Discriminacao>
        <CodigoMunicipio>3128006</CodigoMunicipio>
      </Servico>
      <Prestador>
        <CpfCnpj>
          <Cnpj>31302407000105</Cnpj>
        </CpfCnpj>
        <InscricaoMunicipal>23297500</InscricaoMunicipal>
      </Prestador>
      <Tomador>
        <IdentificacaoTomador>
          <CpfCnpj>
            <Cnpj>20724357000120</Cnpj>
          </CpfCnpj>
        </IdentificacaoTomador>
        <RazaoSocial>HOSPITAL IMACULADA CONCEICAO</RazaoSocial>
      </Tomador>
      <OptanteSimplesNacional>1</OptanteSimplesNacional>
      <IncentivoFiscal>2</IncentivoFiscal>
    </InfDeclaracaoPrestacaoServico>
  </Rps>
</GerarNfseEnvio>`;

const resValid = validateXmlAgainstAbrasf204(validXml, 'GerarNfseEnvio');
assert.strictEqual(resValid.valid, true, `Esperado XML válido, erros: ${resValid.errors.join(', ')}`);

// Teste erro: CNPJ Tomador inválido
const invalidCnpjXml = validXml.replace('20724357000120', '11111111111111');
const resInvalidCnpj = validateXmlAgainstAbrasf204(invalidCnpjXml, 'GerarNfseEnvio');
assert.strictEqual(resInvalidCnpj.valid, false);
assert.ok(resInvalidCnpj.errors.some(e => e.includes('TOMADOR_CNPJ_INVALID')));

// Teste erro: Falta ValorServicos
const missingValXml = validXml.replace('<ValorServicos>1000.00</ValorServicos>', '');
const resMissingVal = validateXmlAgainstAbrasf204(missingValXml, 'GerarNfseEnvio');
assert.strictEqual(resMissingVal.valid, false);
assert.ok(resMissingVal.errors.some(e => e.includes('VALOR_SERVICOS_INVALID')));

// Teste erro: Falta Id
const missingIdXml = validXml.replace('Id="RPS1001A"', '');
const resMissingId = validateXmlAgainstAbrasf204(missingIdXml, 'GerarNfseEnvio');
assert.strictEqual(resMissingId.valid, false);
assert.ok(resMissingId.errors.some(e => e.includes('ID_ATTRIBUTE_MISSING')));

console.log('✓ test-xsd.js PASSED');
