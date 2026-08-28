'use strict';

const assert = require('assert');
const { buildUnsignedCandidateXml, validateCandidate, prepareDemand, demandRows, tomadorRows, patternRows } = require('../prepare');

console.log('Running test-fiscal-xml.js...');

// 1. Testa que candidato com ISS Retido = 1 e Exigibilidade ISS = 2 gera exatamente essas tags no XML
const mockCandidate = {
  requestId: 'req-mock-tax-test',
  sequence: 1,
  patternId: 'MOCK_PATTERN',
  categoria: 'Serviço com Retenção',
  tomador: 'TOMADOR TESTE LTDA',
  cnpjTomador: '20724357000120',
  enderecoTomador: {
    logradouro: 'RUA TESTE',
    numero: '100',
    complemento: 'SALA 1',
    bairro: 'CENTRO',
    codigoMunicipio: '3131307',
    uf: 'MG',
    cep: '35160000'
  },
  valor: 500.00,
  competencia: '08/2026',
  competenciaData: '2026-08-01',
  descricao: 'SERVICO TESTE COM RETENCAO',
  descriptionFromDemand: true,
  codigoTribNacional: '04.03.01',
  codigoTribMunicipal: '403',
  localPrestacao: 'Ipatinga/MG',
  codigoMunicipioPrestacao: '3131307',
  codigoMunicipioIncidenciaIss: '3131307',
  issRetido: '1',          // 1 = Retido
  exigibilidadeIss: '2',   // 2 = Não Incidência
  nbs: '123011900',
  dataEmissao: '2026-08-23',
  rpsNumero: '999',
  rpsSerie: 'A',
  rpsTipo: '1'
};

const xml = buildUnsignedCandidateXml(mockCandidate);
assert.ok(xml.includes('<IssRetido>1</IssRetido>'), 'Deveria conter <IssRetido>1</IssRetido>');
assert.ok(xml.includes('<ExigibilidadeISS>2</ExigibilidadeISS>'), 'Deveria conter <ExigibilidadeISS>2</ExigibilidadeISS>');
assert.ok(xml.includes('<MunicipioIncidencia>3131307</MunicipioIncidencia>'));

// 2. Testa que ausência de campos fiscais obrigatórios bloqueia prepareDemand (sem defaults silenciosos)
const candidateMissingIncidence = { ...mockCandidate, codigoMunicipioIncidenciaIss: '' };
const errors = validateCandidate(candidateMissingIncidence);
assert.ok(errors.includes('ISS_INCIDENCE_LOCATION_IBGE_MISSING'), 'Deveria barrar falta de incidencia');

const candidateMissingRetencao = { ...mockCandidate, issRetido: '' };
const errorsRet = validateCandidate(candidateMissingRetencao);
assert.ok(errorsRet.includes('ISS_RETIDO_MISSING'), 'Deveria barrar falta de issRetido');

console.log('✓ test-fiscal-xml.js PASSED');
