'use strict';

const assert = require('assert');
const { XMLValidator } = require('fast-xml-parser');
const {
  demandRows,
  tomadorRows,
  patternRows,
  prepareDemand,
  buildHomologationFixture,
  handlePrepare
} = require('../prepare');

console.log('Running test-prepare.js...');

const demandasRaw = [
  ['Message ID', 'Período', 'Notas solicitadas', 'Valores', 'Descrição obrigatória', 'Status', 'NFS-e resultantes'],
  ['req-hic', '08/2026', 'HIC — Plantões PS SUS; HIC — Produção PS SUS', '1000,00; 200,00', 'Descrição plantões vinda do e-mail || Descrição produção vinda do e-mail', 'PENDENTE', ''],
  ['req-cisurg', '08/2026', 'CISURG — Plantões credenciamento', '4199,40', 'DESCRIÇÃO EXATA DO ESPELHO MENSAL', 'PENDENTE', ''],
  ['req-done', '07/2026', 'CISURG', '4199,40', 'descrição', 'CONCLUÍDA', '15'],
  ['req-sem-pattern', '08/2026', 'Serviço Médico Desconhecido', '500,00', 'Descrição médica avulsa', 'PENDENTE', '']
];
const tomadoresRaw = [
  ['CNPJ', 'Razão Social', 'Nome Curto', 'Logradouro', 'Número', 'Complemento', 'Bairro', 'Cód. Município', 'Município', 'UF', 'CEP', 'Fonte Endereço', 'Validado Em', 'Categorias Conhecidas', 'Status Homologação'],
  ['20.724.357/0001-20', 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO', 'HIC', 'CAPITAO BERNARDO', '257', '', 'CENTRO', '3128006', 'GUANHAES', 'MG', '39740000', 'NFS-e histórica', '2026-08-22', 'HIC', 'HOMOLOGADO'],
  ['50.098.089/0001-49', 'CONSORCIO INTERMUNICIPAL DE SAUDE DA REGIAO DO MEDIO PIRACICABA - CISURG', 'CISURG', 'RUA SAO PAULO', '377', '', 'AMAZONAS', '3131703', 'ITABIRA', 'MG', '35900352', 'Portal Oficial CISURG', '2026-08-22', 'CISURG', 'HOMOLOGADO']
];
const patternsRaw = [
  ['ID Padrão', 'Nome Padrão', 'Tomador', 'CNPJ Tomador', 'Categoria', 'Template / Descrição Oficial', 'Cód. Trib. Nacional', 'Cód. Trib. Municipal', 'Local Prestação', 'Cód. Município Prestação', 'Cód. Município Incidência', 'ISS Retido', 'Exigibilidade ISS', 'NBS', 'Confiança', 'Status'],
  ['HIC_PLANTOES_PS_SUS', 'HIC Plantões', 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO', '20.724.357/0001-20', 'HIC — Plantões PS SUS', '', '04.03.01', '403', 'Guanhães/MG', '3128006', '3131307', '2', '1', '123011900', 'ALTA', 'VALIDADO'],
  ['HIC_PRODUCAO_PS_SUS', 'HIC Produção', 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO', '20.724.357/0001-20', 'HIC — Produção PS SUS', '', '04.03.01', '403', 'Guanhães/MG', '3128006', '3131307', '2', '1', '123011900', 'ALTA', 'VALIDADO'],
  ['CISURG_PLANTAO_PRESENCIAL', 'CISURG', 'CONSORCIO INTERMUNICIPAL DE SAUDE DA REGIAO DO MEDIO PIRACICABA - CISURG', '50.098.089/0001-49', 'CISURG', '', '04.03.01', '403', 'Itabira/MG', '3131703', '3131307', '2', '1', '123011900', 'MÉDIA', 'VALIDADO']
];

const demandas = demandRows(demandasRaw);
const tomadores = tomadorRows(tomadoresRaw);
const patterns = patternRows(patternsRaw);

// 1. Demanda HIC válida
const hic = prepareDemand({ requestId: 'req-hic', demandas, tomadores, patterns });
assert.strictEqual(hic.candidates.length, 2);
assert.notStrictEqual(hic.candidates[0].patternId, hic.candidates[1].patternId);
assert.strictEqual(hic.candidates[0].valor, 1000);
assert.strictEqual(hic.candidates[1].valor, 200);
assert.strictEqual(hic.candidates[0].aliquotaIss, null);
assert.strictEqual(hic.candidates[0].rpsStatus, 'PENDING_ALLOCATION');
assert.strictEqual(XMLValidator.validate(hic.candidates[0].xmlCandidate), true);
assert.strictEqual(hic.validationStatus, 'READY_TO_ISSUE');
assert.strictEqual(hic.blockingReasons.length, 0);

// 2. Demanda sem pattern -> REVISAO_MANUAL (SEM defaults silenciosos)
const semPattern = prepareDemand({ requestId: 'req-sem-pattern', demandas, tomadores, patterns });
assert.strictEqual(semPattern.validationStatus, 'REVISAO_MANUAL');
assert.ok(semPattern.blockingReasons.includes('PATTERN_NOT_IDENTIFIED'));

// 3. Fixture explícita de homologação
const fixture = buildHomologationFixture();
assert.strictEqual(fixture.validationStatus, 'READY_TO_ISSUE');
assert.strictEqual(fixture.candidates[0].enderecoTomador.codigoMunicipio, '3128006');
assert.strictEqual(fixture.candidates[0].codigoMunicipioPrestacao, '3128006');
assert.strictEqual(fixture.candidates[0].codigoMunicipioIncidenciaIss, '3131307');
assert.strictEqual(XMLValidator.validate(fixture.candidates[0].xmlCandidate), true);

// 4. Demanda CISURG com espelho mensal
const cisurg = prepareDemand({ requestId: 'req-cisurg', demandas, tomadores, patterns });
assert.strictEqual(cisurg.validationStatus, 'READY_TO_ISSUE');
assert.strictEqual(cisurg.candidates[0].enderecoTomador.codigoMunicipio, '3131703');
assert.strictEqual(cisurg.candidates[0].codigoMunicipioPrestacao, '3128006');
assert.strictEqual(cisurg.candidates[0].codigoMunicipioIncidenciaIss, '3131307');

// 5. Demanda já concluída
const done = prepareDemand({ requestId: 'req-done', demandas, tomadores, patterns });
assert.strictEqual(done.validationStatus, 'ALREADY_ISSUED');

console.log('✓ test-prepare.js PASSED');
