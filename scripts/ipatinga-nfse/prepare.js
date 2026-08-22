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
  const nbsTag = candidate.nbs ? `<cNBS>${escapeXml(candidate.nbs.replace(/\D/g, ''))}</cNBS>` : '';
  const cnaeTag = candidate.codigoCnae ? `<CodigoCnae>${escapeXml(candidate.codigoCnae)}</CodigoCnae>` : '';

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
    `<CodigoPais>1058</CodigoPais><ExigibilidadeISS>1</ExigibilidadeISS><MunicipioIncidencia>${escapeXml(codMunPrestacao)}</MunicipioIncidencia>` +
    nbsTag +
    `</Servico>` +
    `<Prestador><CpfCnpj><Cnpj>${CONFIG.PRESTADOR.CNPJ_DIGITS}</Cnpj></CpfCnpj><InscricaoMunicipal>${CONFIG.PRESTADOR.INSCRICAO_MUNICIPAL}</InscricaoMunicipal></Prestador>` +
    `<TomadorServico><IdentificacaoTomador><CpfCnpj><Cnpj>${escapeXml(candidate.cnpjTomador)}</Cnpj></CpfCnpj></IdentificacaoTomador>` +
    `<RazaoSocial>${escapeXml(candidate.tomador)}</RazaoSocial></TomadorServico>` +
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
  if (!candidate.nbs) errors.push('NBS_MISSING');
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
    tomador: 'HOSPITAL IMACULADA CONCEICAO',
    cnpjTomador: '20724357000120',
    valor: 10.00,
    competencia: '08/2026',
    competenciaData: '2026-08-01',
    descricao: 'TESTE DE HOMOLOGACAO - SEM VALOR FISCAL - AUTOMACAO DEXMED',
    descriptionFromDemand: true,
    codigoTribNacional: '04.03.01',
    codigoTribMunicipal: '403',
    localPrestacao: 'Guanhães/MG',
    codigoMunicipioPrestacao: '3128006',
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
    validationStatus: 'READY_TO_ISSUE',
    requestId,
    candidates: [candidate],
    blockingReasons: [],
    xsdValidation: 'SCHEMA_READY',
    xmlSignature: 'NOT_APPLIED_PREPARE_ONLY',
    warnings: ['SYNTHETIC_HOMOLOGATION_FIXTURE'],
    errors: []
  };
}

function prepareDemand({ requestId, demandas, tomadores, patterns, notas = [], now = new Date() }) {
  const normalizedRequest = String(requestId || '').trim();
  if (!normalizedRequest) throw new Error('REQUEST_ID_REQUIRED');

  // Separado: Fixture sintética explícita
  if (normalizedRequest === 'fixture-homologation' || normalizedRequest === 'fixture-controlada') {
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
  const rawDesc = firstField(demand, ['Descrição obrigatória', 'descricao_obrigatoria', 'descricao']);
  const descriptions = splitList(rawDesc);
  const period = firstField(demand, ['Período', 'competencia', 'período referência']);
  const blockingReasons = [];
  if (!labels.length) blockingReasons.push('REQUESTED_NOTES_MISSING');
  if (values.length !== labels.length) blockingReasons.push('VALUES_COUNT_MISMATCH');
  if (descriptions.length > 1 && descriptions.length !== labels.length) blockingReasons.push('DESCRIPTIONS_COUNT_MISMATCH');
  if (labels.length > 1 && descriptions.length === 1) blockingReasons.push('DESCRIPTION_PER_NOTE_REQUIRED');

  const candidates = labels.map((label, index) => {
    const pattern = selectPattern(label, patterns);
    const taker = pattern && tomadores.find(item => normalizeCnpj(item.cnpj) === normalizeCnpj(pattern.cnpjTomador));
    const description = descriptions.length === labels.length ? descriptions[index] : (descriptions[0] || '');
    const cnpjTomador = pattern?.cnpjTomador || taker?.cnpj ? normalizeCnpj(pattern?.cnpjTomador || taker?.cnpj) : '';
    const localPrestacao = pattern?.localPrestacao || '';
    const codigoMunicipioPrestacao = resolveMunicipioIbge(localPrestacao);

    const parsedVal = parseCurrency(values[index]);
    const compFormatted = parseCompetencia(period);
    const compData = competenceDate(period);

    const candidate = {
      requestId: normalizedRequest,
      sequence: index + 1,
      patternId: pattern?.patternId || '',
      categoria: pattern?.categoria || String(label || ''),
      tomador: taker?.razaoSocial || pattern?.tomador || '',
      cnpjTomador,
      valor: parsedVal || 0,
      competencia: compFormatted || '',
      competenciaData: compData || '',
      descricao: description,
      descriptionFromDemand: Boolean(description),
      codigoTribNacional: pattern?.codigoTribNacional || '',
      codigoTribMunicipal: pattern?.codigoTribMunicipal || '',
      localPrestacao,
      codigoMunicipioPrestacao,
      nbs: pattern?.nbs || '',
      codigoCnae: null,
      aliquotaIss: null,
      valorIss: null,
      rpsStatus: 'PENDING_ALLOCATION',
      rpsNumero: '',
      rpsSerie: 'A',
      rpsTipo: '1',
      dataEmissao: now.toISOString().slice(0, 10),
      xmlId: `RPS_PREPARE_${index + 1}`
    };
    candidate.validationErrors = validateCandidate(candidate);
    if (!candidate.validationErrors.length) {
      candidate.xmlCandidate = buildUnsignedCandidateXml(candidate);
    }
    return candidate;
  });

  if ((notas || []).slice(1).some(row => String(row[17] || '').trim() === normalizedRequest)) {
    blockingReasons.push('REQUEST_ALREADY_PRESENT_IN_NOTES');
  }
  blockingReasons.push(...candidates.flatMap(candidate => candidate.validationErrors));

  const validationStatus = blockingReasons.length === 0 ? 'READY_TO_ISSUE' : 'REVISAO_MANUAL';

  return {
    operation: 'prepare',
    status: 'SUCCESS',
    validationStatus,
    requestId: normalizedRequest,
    candidates,
    blockingReasons: [...new Set(blockingReasons)],
    xsdValidation: blockingReasons.length === 0 ? 'SCHEMA_READY' : 'REVISION_REQUIRED',
    xmlSignature: 'NOT_APPLIED_PREPARE_ONLY',
    warnings: ['NO_SILENT_DEFAULTS'],
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
  buildHomologationFixture,
  prepareDemand,
  handlePrepare
};
