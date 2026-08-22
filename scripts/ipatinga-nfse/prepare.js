'use strict';

const { XMLValidator } = require('fast-xml-parser');
const { CONFIG } = require('./config');
const { readSheetValues } = require('./google');
const { isValidCnpj, normalizeCnpj, parseCurrency, parseCompetencia } = require('./validators');

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
      municipio: firstField(item, ['Município', 'municipio']),
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

function buildUnsignedCandidateXml(candidate) {
  const itemLista = String(candidate.codigoTribNacional || '').split('.').slice(0, 2).join('.');
  return `<GerarNfseEnvio xmlns="${CONFIG.ABRASF.SCHEMA_NAMESPACE}">` +
    `<Rps><InfDeclaracaoPrestacaoServico Id="${escapeXml(candidate.xmlId)}">` +
    `<Rps><IdentificacaoRps><Numero>${escapeXml(candidate.rpsNumero)}</Numero><Serie>${escapeXml(candidate.rpsSerie)}</Serie><Tipo>${escapeXml(candidate.rpsTipo)}</Tipo></IdentificacaoRps>` +
    `<DataEmissao>${escapeXml(candidate.dataEmissao)}</DataEmissao><Status>1</Status></Rps>` +
    `<Competencia>${escapeXml(candidate.competenciaData)}</Competencia>` +
    `<Servico><Valores><ValorServicos>${candidate.valor.toFixed(2)}</ValorServicos></Valores>` +
    `<IssRetido>2</IssRetido><ItemListaServico>${escapeXml(itemLista)}</ItemListaServico>` +
    `<CodigoTributacaoMunicipio>${escapeXml(candidate.codigoTribMunicipal)}</CodigoTributacaoMunicipio>` +
    `<Discriminacao>${escapeXml(candidate.descricao)}</Discriminacao>` +
    `<CodigoMunicipio>${escapeXml(candidate.codigoMunicipioPrestacao)}</CodigoMunicipio></Servico>` +
    `<Prestador><CpfCnpj><Cnpj>${CONFIG.PRESTADOR.CNPJ_DIGITS}</Cnpj></CpfCnpj><InscricaoMunicipal>${CONFIG.PRESTADOR.INSCRICAO_MUNICIPAL}</InscricaoMunicipal></Prestador>` +
    `<Tomador><IdentificacaoTomador><CpfCnpj><Cnpj>${escapeXml(candidate.cnpjTomador)}</Cnpj></CpfCnpj></IdentificacaoTomador>` +
    `<RazaoSocial>${escapeXml(candidate.tomador)}</RazaoSocial></Tomador>` +
    `<OptanteSimplesNacional>${CONFIG.PRESTADOR.OPTANTE_SIMPLES_NACIONAL}</OptanteSimplesNacional><IncentivoFiscal>2</IncentivoFiscal>` +
    `</InfDeclaracaoPrestacaoServico></Rps></GerarNfseEnvio>`;
}

function validateCandidate(candidate) {
  const errors = [];
  if (!candidate.requestId) errors.push('REQUEST_ID_MISSING');
  if (!candidate.patternId) errors.push('PATTERN_NOT_IDENTIFIED');
  if (!candidate.categoria) errors.push('CATEGORY_MISSING');
  if (!isValidCnpj(candidate.cnpjTomador)) errors.push('TAKER_CNPJ_INVALID');
  if (!(candidate.valor > 0)) errors.push('SERVICE_VALUE_INVALID');
  if (!candidate.competenciaData) errors.push('COMPETENCE_INVALID');
  if (!candidate.descricao || /^texto do proprio e-?mail$/i.test(normalizeLabel(candidate.descricao))) errors.push('DESCRIPTION_SOURCE_REQUIRED');
  if (!candidate.codigoTribNacional) errors.push('NATIONAL_TAX_CODE_MISSING');
  if (!candidate.codigoTribMunicipal) errors.push('MUNICIPAL_TAX_CODE_MISSING');
  if (!candidate.localPrestacao) errors.push('SERVICE_LOCATION_MISSING');
  if (!candidate.nbs) errors.push('NBS_MISSING');
  if (!candidate.rpsNumero) errors.push('RPS_NUMBER_MISSING');
  if (!candidate.rpsSerie) errors.push('RPS_SERIES_MISSING');
  if (!candidate.rpsTipo) errors.push('RPS_TYPE_MISSING');
  if (normalizeLabel(candidate.patternId).includes('cisurg') && !candidate.descriptionFromDemand) {
    errors.push('CISURG_MONTHLY_MIRROR_DESCRIPTION_REQUIRED');
  }
  return errors;
}

function prepareDemand({ requestId, demandas, tomadores, patterns, notas = [], now = new Date() }) {
  const normalizedRequest = String(requestId || '').trim();
  if (!normalizedRequest) throw new Error('REQUEST_ID_REQUIRED');
  const demand = demandas.find(item => String(firstField(item, ['request_id', 'Message ID']) || '').trim() === normalizedRequest);
  if (!demand) throw new Error(`REQUEST_NOT_FOUND: ${normalizedRequest}`);

  const priorNfse = String(firstField(demand, ['NFS-e resultantes', 'nfse_resultantes']) || '').trim();
  const demandStatus = String(firstField(demand, ['Status']) || '').trim();
  if (priorNfse || /conclu|emitid/i.test(demandStatus)) {
    return {
      operation: 'prepare',
      status: 'SUCCESS',
      validationStatus: 'REVISAO_MANUAL',
      blockingReasons: ['DUPLICATE_ALREADY_ISSUED'],
      requestId: normalizedRequest,
      existingNfse: priorNfse,
      candidates: [],
      warnings: [],
      errors: []
    };
  }

  const labels = splitList(firstField(demand, ['Notas solicitadas', 'categorias', 'categoria']));
  const values = splitList(firstField(demand, ['Valores', 'valores', 'valor']));
  const descriptions = splitList(firstField(demand, ['Descrição obrigatória', 'descricao_obrigatoria', 'descricao']));
  const rpsNumbers = splitList(firstField(demand, ['Números RPS', 'Número RPS', 'RPS', 'rps_numero']));
  const period = firstField(demand, ['Período', 'competencia', 'período referência']);
  const rpsSeries = splitList(firstField(demand, ['Séries RPS', 'Série RPS', 'rps_serie']));
  const rpsTypes = splitList(firstField(demand, ['Tipos RPS', 'Tipo RPS', 'rps_tipo']));
  const blockingReasons = [];
  if (!labels.length) blockingReasons.push('REQUESTED_NOTES_MISSING');
  if (values.length !== labels.length) blockingReasons.push('VALUES_COUNT_MISMATCH');
  if (descriptions.length > 1 && descriptions.length !== labels.length) blockingReasons.push('DESCRIPTIONS_COUNT_MISMATCH');
  if (labels.length > 1 && descriptions.length === 1) blockingReasons.push('DESCRIPTION_PER_NOTE_REQUIRED');

  const candidates = labels.map((label, index) => {
    const pattern = selectPattern(label, patterns);
    const taker = pattern && tomadores.find(item => normalizeCnpj(item.cnpj) === normalizeCnpj(pattern.cnpjTomador));
    const description = descriptions.length === labels.length ? descriptions[index] : (descriptions[0] || '');
    const cnpjTomador = normalizeCnpj(pattern?.cnpjTomador || taker?.cnpj || '');
    const rpsNumero = String(rpsNumbers[index] || (rpsNumbers.length === 1 ? rpsNumbers[0] : '')).trim();
    const rpsSerie = String(rpsSeries[index] || (rpsSeries.length === 1 ? rpsSeries[0] : '')).trim();
    const rpsTipo = String(rpsTypes[index] || (rpsTypes.length === 1 ? rpsTypes[0] : '')).trim();
    const candidate = {
      requestId: normalizedRequest,
      sequence: index + 1,
      patternId: pattern?.patternId || '',
      categoria: pattern?.categoria || String(label),
      tomador: taker?.razaoSocial || pattern?.tomador || '',
      cnpjTomador,
      valor: parseCurrency(values[index]),
      competencia: parseCompetencia(period),
      competenciaData: competenceDate(period),
      descricao: description,
      descriptionFromDemand: Boolean(description),
      codigoTribNacional: pattern?.codigoTribNacional || '',
      codigoTribMunicipal: pattern?.codigoTribMunicipal || '',
      localPrestacao: pattern?.localPrestacao || '',
      codigoMunicipioPrestacao: pattern?.localPrestacao === 'Guanhães/MG' ? '3128006' : '',
      nbs: pattern?.nbs || '',
      aliquotaIss: null,
      rpsNumero,
      rpsSerie,
      rpsTipo,
      dataEmissao: now.toISOString().slice(0, 10),
      xmlId: rpsNumero && rpsSerie ? `RPS${rpsNumero}${rpsSerie.replace(/[^A-Za-z0-9]/g, '')}` : ''
    };
    candidate.validationErrors = validateCandidate(candidate);
    if (!candidate.validationErrors.length) {
      candidate.xmlCandidate = buildUnsignedCandidateXml(candidate);
      const xmlValidation = XMLValidator.validate(candidate.xmlCandidate);
      if (xmlValidation !== true) candidate.validationErrors.push('XML_NOT_WELL_FORMED');
    }
    return candidate;
  });

  const duplicateRps = new Set();
  for (const candidate of candidates) {
    if (!candidate.rpsNumero) continue;
    const key = `${candidate.rpsNumero}:${candidate.rpsSerie}:${candidate.rpsTipo}`;
    if (duplicateRps.has(key)) candidate.validationErrors.push('DUPLICATE_RPS_IN_REQUEST');
    duplicateRps.add(key);
  }
  if ((notas || []).slice(1).some(row => String(row[17] || '').trim() === normalizedRequest)) {
    blockingReasons.push('REQUEST_ALREADY_PRESENT_IN_NOTES');
  }
  blockingReasons.push(...candidates.flatMap(candidate => candidate.validationErrors));
  if (!blockingReasons.length) blockingReasons.push('OFFICIAL_ABRASF_XSD_NOT_AVAILABLE_TO_EXECUTOR');

  return {
    operation: 'prepare',
    status: 'SUCCESS',
    validationStatus: 'REVISAO_MANUAL',
    requestId: normalizedRequest,
    candidates,
    blockingReasons: [...new Set(blockingReasons)],
    xsdValidation: 'BLOCKED_OFFICIAL_ABRASF_XSD_NOT_AVAILABLE',
    xmlSignature: 'NOT_APPLIED_PREPARE_ONLY',
    warnings: ['ISS_RATE_NOT_HARDCODED'],
    errors: []
  };
}

async function handlePrepare({ requestId, environment = 'production', dryRun = true } = {}, dependencies = {}) {
  const read = dependencies.readSheetValues || readSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const [demandasRaw, tomadoresRaw, patternsRaw, notasRaw] = await Promise.all([
    read(spreadsheetId, `${CONFIG.SHEETS.TABS.DEMANDAS}!A:Z`),
    read(spreadsheetId, `${CONFIG.SHEETS.TABS.TOMADORES}!A:J`),
    read(spreadsheetId, `${CONFIG.SHEETS.TABS.PADROES}!A:T`),
    read(spreadsheetId, `${CONFIG.SHEETS.TABS.NOTAS}!A:X`)
  ]);
  const summary = prepareDemand({
    requestId,
    demandas: demandRows(demandasRaw),
    tomadores: tomadorRows(tomadoresRaw),
    patterns: patternRows(patternsRaw),
    notas: notasRaw
  });
  return {
    ...summary,
    environment,
    dryRun: true,
    writeAllowed: false,
    plannedWrites: 0,
    executedWrites: 0,
    timestamp: new Date().toISOString()
  };
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
  buildUnsignedCandidateXml,
  validateCandidate,
  prepareDemand,
  handlePrepare
};
