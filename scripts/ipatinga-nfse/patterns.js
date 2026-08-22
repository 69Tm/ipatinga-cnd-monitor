'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG, sanitize } = require('./config');
const { getDriveClient, readSheetValues, updateSheetValues, appendSheetValues, batchUpdateSheetValues } = require('./google');
const { normalizeCnpj, formatCnpj, parseCompetencia } = require('./validators');

/**
 * Catálogo consolidado de padrões fiscais conhecidos e suas regras determinísticas
 */
const KNOWN_PATTERNS = [
  {
    patternId: 'HIC_PLANTOES_PS_SUS',
    nome: 'HIC — Plantões Médicos PS SUS',
    tomador: 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO',
    cnpjTomador: '20.724.357/0001-20',
    cnpjTomadorClean: '20724357000120',
    categoria: 'HIC — Plantões Médicos PS SUS',
    template: 'Dr Túlio Athélio Sathler Siman: Referente a Plantões Médicos P.S SUS no Mês {MM/AAAA}- R$ {VALOR}. {BLOCO_BANCARIO_VALIDADO}',
    codigoTribNacional: '04.03.01',
    codigoTribMunicipal: '403',
    localPrestacao: 'Guanhães/MG',
    codigoIbgePrestacao: '3128006',
    codigoMunicipioIncidenciaIss: '3131307', // Regra: ISS devido no município prestador (Ipatinga/MG)
    issRetido: false,
    exigibilidadeIss: '1',
    nbs: '123011900',
    camposFixos: 'Tomador, CNPJ, Código Nacional (04.03.01), Código Municipal (403), Local Prestação (Guanhães/MG), Cód Incidência ISS (3131307), Bloco Bancário Inter validado nos exemplos',
    camposVariaveis: 'Competência (MM/AAAA), Valor Total (R$)',
    camposNaoHardcodar: 'Alíquota ISS (varia conforme Simples Nacional), Valor',
    confianca: 'ALTA',
    statusHomologacao: 'EVIDENCIA_HISTORICA_VALIDADA',
    quantidadeExemplos: 2,
    numerosNfseExemplo: ['10', '13'],
    driveFileIdsExemplo: ['1lu434NAezUB_pRMXIJoSx4uzr_01RVRm'],
    primeiraCompetencia: '06/2026',
    ultimaCompetencia: '07/2026'
  },
  {
    patternId: 'HIC_PRODUCAO_PS_SUS',
    nome: 'HIC — Produção PS SUS',
    tomador: 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO',
    cnpjTomador: '20.724.357/0001-20',
    cnpjTomadorClean: '20724357000120',
    categoria: 'HIC — Produção PS SUS',
    template: 'Dr Túlio Athélio Sathler Siman: Referente a Produção P.S SUS no Mês {MM/AAAA}- R$ {VALOR}. {BLOCO_BANCARIO_VALIDADO}',
    codigoTribNacional: '04.03.01',
    codigoTribMunicipal: '403',
    localPrestacao: 'Guanhães/MG',
    codigoIbgePrestacao: '3128006',
    codigoMunicipioIncidenciaIss: '3131307', // Regra: ISS devido no município prestador (Ipatinga/MG)
    issRetido: false,
    exigibilidadeIss: '1',
    nbs: '123011900',
    camposFixos: 'Tomador, CNPJ, Código Nacional (04.03.01), Código Municipal (403), Local Prestação (Guanhães/MG), Cód Incidência ISS (3131307), Bloco Bancário Inter validado nos exemplos',
    camposVariaveis: 'Competência (MM/AAAA), Valor Total (R$)',
    camposNaoHardcodar: 'Alíquota ISS, Valor',
    confianca: 'ALTA',
    statusHomologacao: 'EVIDENCIA_HISTORICA_VALIDADA',
    quantidadeExemplos: 2,
    numerosNfseExemplo: ['11', '14'],
    driveFileIdsExemplo: ['1hlzcRRciNAkWnHNieqFyf0l3aB2weV-a'],
    primeiraCompetencia: '06/2026',
    ultimaCompetencia: '07/2026'
  },
  {
    patternId: 'CISURG_PLANTAO_PRESENCIAL',
    nome: 'CISURG — Plantão médico presencial credenciamento',
    tomador: 'CONSORCIO PUBLICO INTERMUNICIPAL DE SAUDE PARA GERENCIAMENTO DOS SERVICOS DE URGENCIA E EMERGENCIA DA REGIAO DO MEDIO PIRACICABA',
    cnpjTomador: '50.098.089/0001-49',
    cnpjTomadorClean: '50098089000149',
    categoria: 'CISURG — Plantão médico presencial',
    template: 'ESPELHO DO MÊS É FONTE DE VERDADE (Ex: {HORAS} HORAS DE PLANTÃO MÉDICO PRESENCIAL CISURG MP {TIPO_DIA} VALOR R$ {VALOR} REALIZADO POR DR. TULIO ATHELIO CRM 76034 REFERENTE {MES_EXTENSO} {ANO} CREDENCIMENTO MEDICO)',
    codigoTribNacional: '04.03.01',
    codigoTribMunicipal: '403',
    localPrestacao: 'Itabira/MG',
    codigoIbgePrestacao: '3131703',
    codigoMunicipioIncidenciaIss: '3131307', // Regra: ISS devido no município prestador (Ipatinga/MG)
    issRetido: false,
    exigibilidadeIss: '1',
    nbs: '123011900',
    camposFixos: 'Tomador, CNPJ, Código Nacional (04.03.01), Código Municipal (403), Local Prestação (Itabira/MG), Cód Incidência ISS (3131307), NBS (123011900)',
    camposVariaveis: 'Horas, Tipo de dia (úteis/fim de semana), Valor, Competência (Mês/Ano), Descrição do Espelho',
    camposNaoHardcodar: 'Descrição (extraída diretamente do espelho do mês), Local da prestação, Alíquota ISS, Valor',
    confianca: 'MÉDIA',
    statusHomologacao: 'VALIDADO_COM_UM_EXEMPLO',
    quantidadeExemplos: 1,
    numerosNfseExemplo: ['15'],
    driveFileIdsExemplo: ['16GPS4KvIWENhRHOs4bYTymb62WetOolk'],
    primeiraCompetencia: '07/2026',
    ultimaCompetencia: '07/2026'
  }
];

const TOMADORES_DEFAULTS = {
  '20724357000120': {
    nomeCurto: 'HIC',
    razaoSocial: 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO',
    logradouro: 'CAPITAO BERNARDO',
    numero: '257',
    complemento: '',
    bairro: 'CENTRO',
    codigoMunicipio: '3128006',
    municipio: 'GUANHAES',
    uf: 'MG',
    cep: '39740000',
    fonteEndereco: 'NFS-e histórica DEXMED',
    validadoEm: '2026-08-22'
  },
  '50098089000149': {
    nomeCurto: 'CISURG',
    razaoSocial: 'CONSORCIO INTERMUNICIPAL DE SAUDE DA REGIAO DO MEDIO PIRACICABA - CISURG',
    logradouro: 'RUA SAO PAULO',
    numero: '377',
    complemento: '',
    bairro: 'AMAZONAS',
    codigoMunicipio: '3131703',
    municipio: 'ITABIRA',
    uf: 'MG',
    cep: '35900352',
    fonteEndereco: 'Portal Oficial CISURG',
    validadoEm: '2026-08-22'
  }
};

/**
 * Pesquisa no Google Drive todos os documentos e PDFs fiscais relacionados à DEXMED
 */
async function scanDriveNfseFiles(dependencies = {}) {
  const drive = (dependencies.getDriveClient || getDriveClient)();
  const query = "mimeType = 'application/pdf' and (name contains 'NFS' or name contains 'NFE' or name contains 'DANF' or name contains 'nota fiscal') and trashed = false";

  const res = await drive.files.list({
    q: query,
    fields: 'files(id, name, createdTime, modifiedTime, webViewLink, size)',
    spaces: 'drive',
    pageSize: 100
  });

  return res.data.files || [];
}

function rowsEqual(left, right) {
  const normalize = rows => (rows || []).map(row => row.map(value => String(value ?? '').trim()));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function competenceOrder(value) {
  const match = String(parseCompetencia(value) || '').match(/^(\d{2})\/(\d{4})$/);
  return match ? Number(`${match[2]}${match[1]}`) : 0;
}

function buildTomadoresRows(notasRows, existingRows) {
  const headers = [
    'CNPJ', 'Razão Social', 'Nome Curto',
    'Logradouro', 'Número', 'Complemento', 'Bairro', 'Cód. Município', 'Município', 'UF', 'CEP',
    'E-mail', 'Categorias Conhecidas', 'Status Homologação',
    'Fonte Endereço', 'Validado Em',
    'Primeiro Uso', 'Último Uso', 'Qtd NFS-e'
  ];

  const existing = new Map();
  for (const row of (existingRows || []).slice(1)) {
    const key = normalizeCnpj(row[0]);
    if (key) existing.set(key, row);
  }

  const grouped = new Map();
  for (const row of (notasRows || []).slice(1)) {
    const key = normalizeCnpj(row[5]);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, { razao: row[4] || '', competencias: [], categorias: new Set(), total: 0 });
    const item = grouped.get(key);
    item.total++;
    if (row[2]) item.competencias.push(String(row[2]));
    if (row[6]) item.categorias.add(String(row[6]));
  }

  for (const pattern of KNOWN_PATTERNS) {
    const item = grouped.get(pattern.cnpjTomadorClean);
    if (item) item.categorias.add(pattern.categoria);
  }

  // Garante tomadores conhecidos mesmo que não tenham notas emitidas ainda
  for (const key of Object.keys(TOMADORES_DEFAULTS)) {
    if (!grouped.has(key)) {
      const def = TOMADORES_DEFAULTS[key];
      grouped.set(key, { razao: def.razaoSocial, competencias: [], categorias: new Set([def.nomeCurto]), total: 0 });
    }
  }

  const rows = [headers];
  for (const [key, item] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const prior = existing.get(key) || [];
    const def = TOMADORES_DEFAULTS[key] || {};
    const ordered = item.competencias.filter(Boolean).sort((a, b) => competenceOrder(a) - competenceOrder(b));
    const pattern = KNOWN_PATTERNS.find(candidate => candidate.cnpjTomadorClean === key);

    rows.push([
      pattern?.cnpjTomador || formatCnpj(key),
      item.razao || pattern?.tomador || def.razaoSocial || prior[1] || '',
      prior[2] || def.nomeCurto || '',
      prior[3] || def.logradouro || '',
      prior[4] || def.numero || '',
      prior[5] || def.complemento || '',
      prior[6] || def.bairro || '',
      prior[7] || def.codigoMunicipio || '',
      prior[8] || def.municipio || '',
      prior[9] || def.uf || '',
      prior[10] || def.cep || '',
      prior[11] || '', // E-mail
      [...item.categorias].sort().join(', '),
      prior[13] || 'EVIDENCIA_HISTORICA_VALIDADA',
      prior[14] || def.fonteEndereco || 'NFS-e histórica',
      prior[15] || def.validadoEm || '2026-08-22',
      ordered[0] || prior[16] || '',
      ordered.at(-1) || prior[17] || '',
      item.total
    ]);
  }
  return rows;
}

function buildPadroesRows() {
  const rows = [[
    'ID Padrão', 'Nome Padrão', 'Tomador', 'CNPJ Tomador', 'Categoria', 'Template / Descrição Oficial',
    'Cód. Trib. Nacional', 'Cód. Trib. Municipal', 'Local Prestação', 'Cód. Município Prestação', 'Cód. Município Incidência ISS',
    'ISS Retido', 'Exigibilidade ISS', 'NBS', 'Campos Fixos',
    'Campos Variáveis', 'Campos Não Hardcodar', 'Qtd Exemplos', 'NFS-e Exemplos',
    'Drive File IDs Exemplos', 'Primeira Competência', 'Última Competência', 'Confiança', 'Status'
  ]];

  for (const p of KNOWN_PATTERNS) {
    rows.push([
      p.patternId, p.nome, p.tomador, p.cnpjTomador, p.categoria, p.template,
      p.codigoTribNacional, p.codigoTribMunicipal, p.localPrestacao, p.codigoIbgePrestacao, p.codigoMunicipioIncidenciaIss,
      p.issRetido ? '1' : '2', p.exigibilidadeIss, p.nbs,
      p.camposFixos, p.camposVariaveis, p.camposNaoHardcodar, p.quantidadeExemplos,
      p.numerosNfseExemplo.join(', '), p.driveFileIdsExemplo.join(', '),
      p.primeiraCompetencia, p.ultimaCompetencia, p.confianca, p.statusHomologacao
    ]);
  }
  return rows;
}

function buildLocalPrestacaoRepairs(notasRows) {
  const verified = new Set(['10', '11', '13', '14', '15']);
  const repairs = [];
  for (let index = 1; index < (notasRows || []).length; index++) {
    const row = notasRows[index];
    const numero = String(row[0] || '').trim();
    const local = String(row[11] || '').trim();
    if (verified.has(numero) && (!local || local === 'IBGE 0')) {
      repairs.push({ numero, range: `${CONFIG.SHEETS.TABS.NOTAS}!L${index + 1}`, value: 'Guanhães/MG' });
    }
  }
  return repairs;
}

/**
 * Executa a análise histórica completa do Google Drive e consolida os padrões.
 * Escritas são idempotentes e ocorrem somente depois que todas as leituras terminam.
 */
async function runHistoricalAnalysis({ dryRun = false, environment = 'production' } = {}, dependencies = {}) {
  console.log('🔍 Executando Análise Histórica de NFS-e no Google Drive...');
  const startTime = Date.now();
  const driveFiles = await scanDriveNfseFiles(dependencies);
  console.log(`  - Total de arquivos PDF candidatos encontrados no Drive: ${driveFiles.length}`);

  const ssId = CONFIG.SHEETS.SPREADSHEET_ID;
  const readValues = dependencies.readSheetValues || readSheetValues;
  const updateValues = dependencies.updateSheetValues || updateSheetValues;
  const [notasPlanilha, tomadoresAtuais, padroesAtuais] = await Promise.all([
    readValues(ssId, `${CONFIG.SHEETS.TABS.NOTAS}!A:X`),
    readValues(ssId, `${CONFIG.SHEETS.TABS.TOMADORES}!A:S`),
    readValues(ssId, `${CONFIG.SHEETS.TABS.PADROES}!A:X`)
  ]);
  const tomadoresRows = buildTomadoresRows(notasPlanilha, tomadoresAtuais);
  const padroesRows = buildPadroesRows();
  const localRepairs = buildLocalPrestacaoRepairs(notasPlanilha);
  const tomadoresChanged = !rowsEqual(tomadoresRows, tomadoresAtuais);
  const padroesChanged = !rowsEqual(padroesRows, (padroesAtuais || []).slice(0, padroesRows.length));
  const legacyPatternRows = Math.max(0, (padroesAtuais || []).length - padroesRows.length);
  const plannedWrites = Number(tomadoresChanged) + Number(padroesChanged) + Number(legacyPatternRows > 0) + Number(localRepairs.length > 0);
  let executedWrites = 0;

  if (!dryRun) {
    if (tomadoresChanged) {
      await updateValues(ssId, `${CONFIG.SHEETS.TABS.TOMADORES}!A1:S${tomadoresRows.length}`, tomadoresRows);
      executedWrites++;
    }
    if (padroesChanged) {
      await updateValues(ssId, `${CONFIG.SHEETS.TABS.PADROES}!A1:X${padroesRows.length}`, padroesRows);
      executedWrites++;
    }
    for (const repair of localRepairs) {
      await updateValues(ssId, repair.range, [[repair.value]]);
      executedWrites++;
    }
  }

  return {
    operation: 'historical_analysis',
    status: dryRun ? 'DRY_RUN' : 'SUCCESS',
    environment,
    dryRun,
    timestamp: new Date().toISOString(),
    durationSec: Number(((Date.now() - startTime) / 1000).toFixed(2)),
    driveFilesFound: driveFiles.length,
    knownPatternsCount: KNOWN_PATTERNS.length,
    tomadoresIdentificados: tomadoresRows.length - 1,
    plannedWrites,
    executedWrites,
    tomadoresChanged,
    padroesChanged,
    localRepairsCount: localRepairs.length,
    errors: [],
    warnings: []
  };
}

module.exports = {
  KNOWN_PATTERNS,
  TOMADORES_DEFAULTS,
  scanDriveNfseFiles,
  buildTomadoresRows,
  buildPadroesRows,
  buildLocalPrestacaoRepairs,
  runHistoricalAnalysis,
  rowsEqual
};
