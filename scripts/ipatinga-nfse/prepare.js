'use strict';

const { CONFIG } = require('./config');
const { readSheetValues } = require('./google');
const { isValidCnpj, normalizeCnpj, parseCurrency, parseCompetencia } = require('./validators');
const { validateXmlAgainstOfficialXsd } = require('./xsd-validator');

function normalizeLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function rowObject(headers, row) {
  const result = {};
  headers.forEach((header, index) => { result[normalizeLabel(header)] = row[index] ?? ''; });
  return result;
}

function firstField(record, aliases) {
  for (const alias of aliases) {
    const value = record[normalizeLabel(alias)];
    if (value !== undefined && String(value).trim() !== '') return value;
  }
  return '';
}

function splitList(value, expected = null) {
  if (Array.isArray(value)) return value;
  const text = String(value || '').trim();
  if (!text) return [];
  let result = text.split(/\s*(?:;|\|\|)\s*/).map(item => item.trim()).filter(Boolean);
  if (expected === 1 && result.length > 1) result = [text];
  return result;
}

function patternRows(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).filter(row => row.some(Boolean)).map(row => {
    const item = rowObject(headers, row);
    return {
      patternId: firstField(item, ['ID Padrão', 'pattern_id']),
      nome: firstField(item, ['Nome Padrão', 'nome']),
      tomador: firstField(item, ['Tomador']),
      cnpjTomador: firstField(item, ['CNPJ Tomador', 'cnpj_tomador']),
      categoria: firstField(item, ['Categoria']),
      template: firstField(item, ['Template / Descrição Oficial', 'template']),
      codigoTribNacional: firstField(item, ['Cód. Trib. Nacional', 'codigo_tributacao_nacional']),
      codigoTribMunicipal: firstField(item, ['Cód. Trib. Municipal', 'codigo_tributacao_municipal']),
      localPrestacao: firstField(item, ['Local Prestação', 'local_prestacao']),
      codigoMunicipioPrestacao: firstField(item, ['Cód. Município Prestação', 'codigo_municipio_prestacao']),
      codigoMunicipioIncidenciaIss: firstField(item, ['Cód. Município Incidência', 'codigo_municipio_incidencia', 'codigo_municipio_incidencia_iss']),
      nbs: firstField(item, ['NBS']),
      confianca: firstField(item, ['Confiança', 'confianca']),
      status: firstField(item, ['Status'])
    };
  });
}

function demandRows(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).filter(row => row.some(Boolean)).map(row => rowObject(headers, row));
}

function tomadorRows(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).filter(row => row.some(Boolean)).map(row => {
    const item = rowObject(headers, row);
    return {
      cnpj: firstField(item, ['CNPJ']),
      razaoSocial: firstField(item, ['Razão Social', 'razao_social']),
      nomeCurto: firstField(item, ['Nome Curto', 'nome_curto']),
      logradouro: firstField(item, ['Logradouro', 'endereco', 'logradouro']),
      numero: firstField(item, ['Número', 'numero']),
      complemento: firstField(item, ['Complemento', 'complemento']),
      bairro: firstField(item, ['Bairro', 'bairro']),
      codigoMunicipio: firstField(item, ['Cód. Município', 'codigo_municipio', 'codigo_municipio_ibge']),
      municipio: firstField(item, ['Município', 'municipio']),
      uf: firstField(item, ['UF', 'uf']),
      cep: firstField(item, ['CEP', 'cep']),
      fonteEndereco: firstField(item, ['Fonte Endereço', 'fonte_endereco']),
      validadoEm: firstField(item, ['Validado Em', 'validado_em']),
      categorias: firstField(item, ['Categorias Conhecidas', 'categorias']),
      status: firstField(item, ['Status Homologação', 'status'])
    };
  });
}

function selectPattern(label, patterns) {
  const key = normalizeLabel(label);
  if (!key) return null;
  const exact = patterns.find(pattern => [pattern.patternId, pattern.nome, pattern.categoria]
    .some(value => normalizeLabel(value) === key));
  if (exact) return exact;
  if (key.includes('cisurg')) return patterns.find(pattern => normalizeLabel(pattern.patternId).includes('cisurg')) || null;
  if (key.includes('produc')) return patterns.find(pattern => normalizeLabel(pattern.patternId).includes('produc')) || null;
  if (key.includes('plant')) return patterns.find(pattern => normalizeLabel(pattern.patternId).includes('plant')) || null;
  return null;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function competenceDate(value) {
  const match = String(parseCompetencia(value) || '').match(/^(\d{2})\/(\d{4})$/);
  return match ? `${match[2]}-${match[1]}-01` : '';
}

function resolveMunicipioIbge(localPrestacao) {
  const norm = normalizeLabel(localPrestacao);
  if (norm.includes('guanhaes')) return '3128006';
  if (norm.includes('ipatinga')) return '3131307';
  if (norm.includes('itabira')) return '3131703';
  return '';
}

function buildUnsignedCandidateXml(candidate) {
  const itemLista = String(candidate.codigoTribNacional || '').split('.').slice(0, 2).join('.');
  const rpsNum = candidate.rpsNumero || '999999';
  const rpsSer = candidate.rpsSerie || 'A';
  const rpsTip = candidate.rpsTipo || '1';
  const xmlId = candidate.xmlId || `RPS${rpsNum}${rpsSer.replace(/[^A-Za-z0-9]/g, '')}`;
  const codMunPrestacao = candidate.codigoMunicipioPrestacao;
  const codMunIncidencia = candidate.codigoMunicipioIncidenciaIss || '3131307'; // Regra: ISS devido no município prestador (Ipatinga) para atividades sem retenção fora
  const nbsTag = candidate.nbs ? `<cNBS>${escapeXml(candidate.nbs.replace(/\D/g, ''))}</cNBS>` : '';
  const cnaeTag = candidate.codigoCnae ? `<CodigoCnae>${escapeXml(candidate.codigoCnae)}</CodigoCnae>` : '';

  let enderecoXml = '';
  if (candidate.enderecoTomador) {
    const end = candidate.enderecoTomador;
    const complTag = end.complemento ? `<Complemento>${escapeXml(end.complemento)}</Complemento>` : '';
    enderecoXml = `<Endereco>` +
      `<Endereco>${escapeXml(end.logradouro || end.endereco)}</Endereco>` +
      `<Numero>${escapeXml(end.numero)}</Numero>` +
      complTag +
      `<Bairro>${escapeXml(end.bairro)}</Bairro>` +
      `<CodigoMunicipio>${escapeXml(end.codigoMunicipio)}</CodigoMunicipio>` +
      `<Uf>${escapeXml(end.uf)}</Uf>` +
      `<Cep>${escapeXml(String(end.cep || '').replace(/\D/g, ''))}</Cep>` +
    `</Endereco>`;
  }

  return `<GerarNfseEnvio xmlns="${CONFIG.ABRASF.SCHEMA_NAMESPACE}">` +
    `<Rps><InfDeclaracaoPrestacaoServico Id="${escapeXml(xmlId)}">` +
    `<Rps><IdentificacaoRps><Numero>${escapeXml(rpsNum)}</Numero><Serie>${escapeXml(rpsSer)}</Serie><Tipo>${escapeXml(rpsTip)}</Tipo></IdentificacaoRps>` +
    `<DataEmissao>${escapeXml(candidate.dataEmissao)}</DataEmissao><Status>1</Status></Rps>` +
    `<Competencia>${escapeXml(candidate.competenciaData)}</Competencia>` +
    `<Servico><Valores><ValorServicos>${candidate.valor.toFixed(2)}</ValorServicos></Valores>` +
    `<IssRetido>2</IssRetido><ItemListaServico>${escapeXml(itemLista)}</ItemListaServico>` +
    cnaeTag +
    `<CodigoTributacaoMunicipio>${escapeXml(candidate.codigoTribMunicipal)}</CodigoTributacaoMunicipio>` +
    `<Discriminacao>${escapeXml(candidate.descricao)}</Discriminacao>` +
    `<CodigoMunicipio>${escapeXml(codMunPrestacao)}</CodigoMunicipio>` +
    `<CodigoPais>1058</CodigoPais><ExigibilidadeISS>1</ExigibilidadeISS><MunicipioIncidencia>${escapeXml(codMunIncidencia)}</MunicipioIncidencia>` +
    nbsTag +
    `</Servico>` +
    `<Prestador><CpfCnpj><Cnpj>${CONFIG.PRESTADOR.CNPJ_DIGITS}</Cnpj></CpfCnpj><InscricaoMunicipal>${CONFIG.PRESTADOR.INSCRICAO_MUNICIPAL}</InscricaoMunicipal></Prestador>` +
    `<TomadorServico><IdentificacaoTomador><CpfCnpj><Cnpj>${escapeXml(candidate.cnpjTomador)}</Cnpj></CpfCnpj></IdentificacaoTomador>` +
    `<RazaoSocial>${escapeXml(candidate.tomador)}</RazaoSocial>` +
    enderecoXml +
    `</TomadorServico>` +
    `<OptanteSimplesNacional>${CONFIG.PRESTADOR.OPTANTE_SIMPLES_NACIONAL}</OptanteSimplesNacional><IncentivoFiscal>2</IncentivoFiscal>` +
    `</InfDeclaracaoPrestacaoServico></Rps></GerarNfseEnvio>`;
}

function validateCandidate(candidate) {
  const errors = [];
  if (!candidate.requestId) errors.push('REQUEST_ID_MISSING');
  if (!candidate.patternId) errors.push('PATTERN_NOT_IDENTIFIED');
  if (!candidate.categoria) errors.push('CATEGORY_MISSING');
  if (!isValidCnpj(candidate.cnpjTomador)) errors.push('TAKER_CNPJ_INVALID');
  if (!candidate.tomador) errors.push('TAKER_NAME_MISSING');
  if (!(candidate.valor > 0)) errors.push('SERVICE_VALUE_INVALID');
  if (!candidate.competenciaData) errors.push('COMPETENCE_INVALID');
  if (!candidate.descricao || /^texto do proprio e-?mail$/i.test(normalizeLabel(candidate.descricao))) errors.push('DESCRIPTION_SOURCE_REQUIRED');
  if (!candidate.codigoTribNacional) errors.push('NATIONAL_TAX_CODE_MISSING');
  if (!candidate.codigoTribMunicipal) errors.push('MUNICIPAL_TAX_CODE_MISSING');
  if (!candidate.localPrestacao) errors.push('SERVICE_LOCATION_MISSING');
  if (!candidate.codigoMunicipioPrestacao) errors.push('SERVICE_LOCATION_IBGE_MISSING');
  if (!candidate.codigoMunicipioIncidenciaIss) errors.push('ISS_INCIDENCE_LOCATION_IBGE_MISSING');
  if (!candidate.nbs) errors.push('NBS_MISSING');
  if (!candidate.enderecoTomador || !candidate.enderecoTomador.logradouro || !candidate.enderecoTomador.numero || !candidate.enderecoTomador.bairro || !candidate.enderecoTomador.codigoMunicipio || !candidate.enderecoTomador.uf || !candidate.enderecoTomador.cep) {
    errors.push('TAKER_ADDRESS_INCOMPLETE');
  }
  if (normalizeLabel(candidate.patternId).includes('cisurg') && !candidate.descriptionFromDemand) {
    errors.push('CISURG_MONTHLY_MIRROR_DESCRIPTION_REQUIRED');
  }
  return errors;
}

function buildHomologationFixture(requestId = 'fixture-homologation', now = new Date()) {
  const candidate = {
    requestId,
    sequence: 1,
    patternId: 'HIC_PLANTOES_PS_SUS',
    categoria: 'HIC — Plantões PS SUS',
    tomador: 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO',
    cnpjTomador: '20724357000120',
    enderecoTomador: {
      logradouro: 'CAPITAO BERNARDO',
      numero: '257',
      complemento: '',
      bairro: 'CENTRO',
      codigoMunicipio: '3128006',
      uf: 'MG',
      cep: '39740000'
    },
    valor: 10.00,
    competencia: '08/2026',
    competenciaData: '2026-08-01',
    descricao: 'TESTE DE HOMOLOGACAO - SEM VALOR FISCAL - AUTOMACAO DEXMED',
    descriptionFromDemand: true,
    codigoTribNacional: '04.03.01',
    codigoTribMunicipal: '403',
    localPrestacao: 'Guanhães/MG',
    codigoMunicipioPrestacao: '3128006',
    codigoMunicipioIncidenciaIss: '3131307', // Incidência em Ipatinga para atividade médica da DEXMED
    nbs: '123011900',
    codigoCnae: null,
    aliquotaIss: null,
    valorIss: null,
    rpsStatus: 'PENDING_ALLOCATION',
    rpsNumero: '',
    rpsSerie: 'A',
    rpsTipo: '1',
    dataEmissao: now.toISOString().slice(0, 10),
    xmlId: 'RPS_PREPARE_1'
  };

  candidate.validationErrors = validateCandidate(candidate);
  candidate.xmlCandidate = buildUnsignedCandidateXml(candidate);

  return {
    operation: 'prepare',
    status: 'SUCCESS',
    validationStatus: candidate.validationErrors.length ? 'REVISAO_MANUAL' : 'READY_TO_ISSUE',
    requestId,
    candidates: [candidate],
    blockingReasons: candidate.validationErrors,
    xsdValidation: 'SCHEMA_READY',
    xmlSignature: 'NOT_APPLIED_PREPARE_ONLY',
    warnings: ['SYNTHETIC_HOMOLOGATION_FIXTURE'],
    errors: candidate.validationErrors
  };
}

function prepareDemand({ requestId, demandas, tomadores, patterns, notas = [], now = new Date() }) {
  const normalizedRequest = String(requestId || '').trim();
  if (!normalizedRequest) throw new Error('REQUEST_ID_REQUIRED');

  // Separado: Fixture sintética explícita
  if (normalizedRequest.startsWith('fixture-homologation') || normalizedRequest.startsWith('fixture-controlada')) {
    return buildHomologationFixture(normalizedRequest, now);
  }

  const demand = demandas.find(item => String(firstField(item, ['request_id', 'Message ID']) || '').trim() === normalizedRequest);
  if (!demand) throw new Error(`REQUEST_NOT_FOUND: ${normalizedRequest}`);

  const priorNfse = String(firstField(demand, ['NFS-e resultantes', 'nfse_resultantes']) || '').trim();
  const demandStatus = String(firstField(demand, ['Status']) || '').trim();
  if (priorNfse || /conclu|emitid/i.test(demandStatus)) {
    return {
      operation: 'prepare',
      status: 'SUCCESS',
      validationStatus: 'ALREADY_ISSUED',
      requestId: normalizedRequest,
      candidates: [],
      blockingReasons: ['DEMAND_ALREADY_ISSUED'],
      warnings: [],
      errors: []
    };
  }

  const patternLabel = firstField(demand, ['Padrão Identificado', 'padrao_identificado', 'Assunto / Categoria', 'categoria', 'Notas solicitadas', 'notas_solicitadas']);
  const pattern = selectPattern(patternLabel, patterns);
  if (!pattern) {
    return {
      operation: 'prepare',
      status: 'SUCCESS',
      validationStatus: 'REVISAO_MANUAL',
      requestId: normalizedRequest,
      candidates: [],
      blockingReasons: ['PATTERN_NOT_IDENTIFIED'],
      warnings: [],
      errors: ['PATTERN_NOT_IDENTIFIED']
    };
  }

  const demandCnpj = normalizeCnpj(firstField(demand, ['CNPJ Tomador', 'cnpj_tomador']));
  const patternCnpj = normalizeCnpj(pattern.cnpjTomador);
  const cnpjTomador = demandCnpj || patternCnpj;

  const tomadorCadastrado = tomadores.find(t => normalizeCnpj(t.cnpj) === cnpjTomador) || null;
  const tomadorNome = tomadorCadastrado?.razaoSocial || pattern.tomador || firstField(demand, ['Tomador']);

  let enderecoTomador = null;
  if (tomadorCadastrado && tomadorCadastrado.logradouro && tomadorCadastrado.numero && tomadorCadastrado.bairro && tomadorCadastrado.codigoMunicipio && tomadorCadastrado.uf && tomadorCadastrado.cep) {
    enderecoTomador = {
      logradouro: tomadorCadastrado.logradouro,
      numero: tomadorCadastrado.numero,
      complemento: tomadorCadastrado.complemento || '',
      bairro: tomadorCadastrado.bairro,
      codigoMunicipio: tomadorCadastrado.codigoMunicipio,
      municipio: tomadorCadastrado.municipio,
      uf: tomadorCadastrado.uf,
      cep: tomadorCadastrado.cep
    };
  }

  const values = splitList(firstField(demand, ['Valor(es) Extraído(s)', 'valor_extraido', 'Valores', 'valores', 'valor'])).map(parseCurrency).filter(v => v > 0);
  const subPadroes = splitList(firstField(demand, ['Sub-Padrão(ões)', 'sub_padroes', 'Notas solicitadas', 'notas_solicitadas']));
  const count = Math.max(values.length, subPadroes.length, 1);

  const localPrestacao = pattern.localPrestacao || firstField(demand, ['Local Prestação', 'local_prestacao']);
  const codigoMunicipioPrestacao = pattern.codigoMunicipioPrestacao || resolveMunicipioIbge(localPrestacao);
  const codigoMunicipioIncidenciaIss = pattern.codigoMunicipioIncidenciaIss || '3131307'; // Ipatinga por padrão para prestador estabelecido em Ipatinga

  const descDemands = splitList(firstField(demand, ['Descrição obrigatória', 'Descrição / Espelho', 'descricao', 'Corpo do E-mail']));

  const candidates = [];
  const blockingReasons = [];

  for (let i = 0; i < count; i++) {
    const valor = values[i] || values[0] || 0;
    const subPadrao = subPadroes[i] || pattern.patternId;
    const subPattern = selectPattern(subPadrao, patterns) || pattern;

    const descDemand = descDemands[i] || descDemands[0] || '';
    const isCisurg = normalizeLabel(subPattern.patternId).includes('cisurg');
    const descricao = isCisurg ? descDemand : (descDemand || subPattern.template);

    const cand = {
      requestId: normalizedRequest,
      sequence: i + 1,
      patternId: subPattern.patternId,
      categoria: subPattern.categoria || pattern.categoria,
      tomador: tomadorNome,
      cnpjTomador,
      enderecoTomador,
      valor,
      competencia: parseCompetencia(firstField(demand, ['Competência', 'competencia', 'Período', 'periodo'])),
      competenciaData: competenceDate(firstField(demand, ['Competência', 'competencia', 'Período', 'periodo'])),
      descricao,
      descriptionFromDemand: Boolean(descDemand),
      codigoTribNacional: subPattern.codigoTribNacional,
      codigoTribMunicipal: subPattern.codigoTribMunicipal,
      localPrestacao,
      codigoMunicipioPrestacao,
      codigoMunicipioIncidenciaIss,
      nbs: subPattern.nbs,
      codigoCnae: null,
      aliquotaIss: null,
      valorIss: null,
      rpsStatus: 'PENDING_ALLOCATION',
      rpsNumero: '',
      rpsSerie: 'A',
      rpsTipo: '1',
      dataEmissao: now.toISOString().slice(0, 10),
      xmlId: `RPS_PREPARE_${i + 1}`
    };

    cand.validationErrors = validateCandidate(cand);
    if (cand.validationErrors.length) {
      blockingReasons.push(...cand.validationErrors);
    }
    cand.xmlCandidate = buildUnsignedCandidateXml(cand);
    candidates.push(cand);
  }

  const validationStatus = blockingReasons.length ? 'REVISAO_MANUAL' : 'READY_TO_ISSUE';

  return {
    operation: 'prepare',
    status: 'SUCCESS',
    validationStatus,
    requestId: normalizedRequest,
    candidates,
    blockingReasons: Array.from(new Set(blockingReasons)),
    xsdValidation: validationStatus === 'READY_TO_ISSUE' ? 'SCHEMA_READY' : 'PENDING_FIX',
    xmlSignature: 'NOT_APPLIED_PREPARE_ONLY',
    warnings: [],
    errors: Array.from(new Set(blockingReasons))
  };
}

async function handlePrepare({ requestId, environment, dryRun }) {
  const spreadsheetId = CONFIG.SHEETS.SPREADSHEET_ID;
  const [demandasRaw, tomadoresRaw, patternsRaw, notasRaw] = await Promise.all([
    readSheetValues(spreadsheetId, `${CONFIG.SHEETS.TABS.DEMANDAS}!A:Z`),
    readSheetValues(spreadsheetId, `${CONFIG.SHEETS.TABS.TOMADORES}!A:M`),
    readSheetValues(spreadsheetId, `${CONFIG.SHEETS.TABS.PADROES}!A:T`),
    readSheetValues(spreadsheetId, `${CONFIG.SHEETS.TABS.NOTAS}!A:X`)
  ]);

  const prepared = prepareDemand({
    requestId,
    demandas: demandRows(demandasRaw),
    tomadores: tomadorRows(tomadoresRaw),
    patterns: patternRows(patternsRaw),
    notas: notasRaw
  });

  return prepared;
}

module.exports = {
  normalizeLabel,
  rowObject,
  firstField,
  splitList,
  patternRows,
  demandRows,
  tomadorRows,
  selectPattern,
  escapeXml,
  competenceDate,
  resolveMunicipioIbge,
  buildUnsignedCandidateXml,
  validateCandidate,
  buildHomologationFixture,
  prepareDemand,
  handlePrepare
};
