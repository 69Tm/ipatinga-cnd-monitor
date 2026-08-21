'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildCabecalho,
  buildConsultarNfseFaixaEnvio,
  parseConsultarNfseResposta
} = require('../abrasf');

console.log('Running test-xml.js...');

// 1. Build Cabecalho & Envio
const cabec = buildCabecalho();
assert.ok(cabec.includes('versao="2.04"'));
assert.ok(cabec.includes('http://www.abrasf.org.br/nfse.xsd'));

const faixaEnvio = buildConsultarNfseFaixaEnvio({ from: 1, to: 50, page: 1 });
assert.ok(faixaEnvio.includes('<NumeroNfseInicial>1</NumeroNfseInicial>'));
assert.ok(faixaEnvio.includes('<NumeroNfseFinal>50</NumeroNfseFinal>'));
assert.ok(faixaEnvio.includes('<Cnpj>31302407000105</Cnpj>'));
assert.ok(faixaEnvio.includes('<InscricaoMunicipal>23297500</InscricaoMunicipal>'));

// 2. Parse Realistic Sample with NFS-e 10, 11, 13, 14, 15
const samplePath = path.join(__dirname, 'fixtures', 'consultar-faixa-resposta-sample.xml');
const sampleXml = fs.readFileSync(samplePath, 'utf8');
const parsed = parseConsultarNfseResposta(sampleXml);

assert.strictEqual(parsed.success, true);
assert.strictEqual(parsed.totalNotas, 5);
assert.strictEqual(parsed.notas[0].numero, '10');
assert.strictEqual(parsed.notas[0].valorServicos, 12925);
assert.strictEqual(parsed.notas[0].aliquota, 2.291);
assert.strictEqual(parsed.notas[0].localPrestacao, 'Guanhães/MG');
assert.strictEqual(parsed.notas[0].tomador, 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO');

assert.strictEqual(parsed.notas[1].numero, '11');
assert.strictEqual(parsed.notas[1].valorServicos, 2320);

assert.strictEqual(parsed.notas[2].numero, '13');
assert.strictEqual(parsed.notas[2].valorServicos, 13200);
assert.strictEqual(parsed.notas[2].aliquota, 2.0);

assert.strictEqual(parsed.notas[3].numero, '14');
assert.strictEqual(parsed.notas[3].valorServicos, 2010);

assert.strictEqual(parsed.notas[4].numero, '15');
assert.strictEqual(parsed.notas[4].valorServicos, 4199.4);
assert.strictEqual(parsed.notas[4].cnpjTomador, '50.098.089/0001-49');

// 3. Parse Empty Response
const emptyPath = path.join(__dirname, 'fixtures', 'consultar-faixa-resposta-empty.xml');
const emptyXml = fs.readFileSync(emptyPath, 'utf8');
const parsedEmpty = parseConsultarNfseResposta(emptyXml);

assert.strictEqual(parsedEmpty.totalNotas, 0);
assert.strictEqual(parsedEmpty.mensagens.length, 1);
assert.strictEqual(parsedEmpty.mensagens[0].codigo, 'L000');

console.log('✓ test-xml.js PASSED');
