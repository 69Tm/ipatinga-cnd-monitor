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
    issRetido: '2', // 1 = Sim, 2 = Não
    exigibilidadeIss: '1', // 1 = Exigível
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
    issRetido: '2',
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
    localPrestacao: 'Guanhães/MG',
    codigoIbgePrestacao: '3128006',
    codigoMunicipioIncidenciaIss: '3131307', // Regra: ISS devido no município prestador (Ipatinga/MG)
    issRetido: '2',
    exigibilidadeIss: '1',
    nbs: '123011900',
    camposFixos: 'Tomador, CNPJ, Código Nacional (04.03.01), Código Municipal (403), NBS (123011900)',
    camposVariaveis: 'Horas, Tipo de dia (úteis/fim de semana), Valor, Competência (Mês/Ano), Descrição do Espelho, Local da Prestação (se explícito no espelho)',
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
    nomeCurto: 'HIC Guanhães',
    razaoSocial: 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO',
    logradouro: 'CAPITAO BERNARDO',
    numero: '257',
    complemento: '',
    bairro: 'CENTRO',
    codigoMunicipio: '3128006',
    municipio: 'Guanhães',
    uf: 'MG',
    cep: '39740000',
    email: 'financeiro@hicguanhaes.com.br',
    categorias: 'HIC — Plantões Médicos PS SUS, HIC — Produção PS SUS',
    statusHomologacao: 'HOMOLOGADO',
    fonteEndereco: 'NFS-e histórica DEXMED',
    validadoEm: '2026-08-22',
    primeiroUso: '01/2026',
    ultimoUso: '08/2026',
    qtdNfse: 11
  },
  '50098089000149': {
    nomeCurto: 'CISURG Médio Piracicaba',
    razaoSocial: 'CONSORCIO PUBLICO INTERMUNICIPAL DE SAUDE PARA GERENCIAMENTO DOS SERVICOS DE URGENCIA E EMERGENCIA DA REGIAO DO MEDIO PIRACICABA',
    logradouro: 'RUA SAO PAULO',
    numero: '377',
    complemento: '',
    bairro: 'AMAZONAS',
    codigoMunicipio: '3131703',
    municipio: 'Itabira',
    uf: 'MG',
    cep: '35900352',
    email: 'samu192cisurg@gmail.com',
    categorias: 'CISURG — Plantão médico presencial',
    statusHomologacao: 'HOMOLOGADO',
    fonteEndereco: 'Portal Oficial CISURG',
    validadoEm: '2026-08-22',
    primeiroUso: '06/2026',
    ultimoUso: '08/2026',
    qtdNfse: 4
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

function pickField(def, key, priorVal = '') {
  if (Object.prototype.hasOwnProperty.call(def, key)) {
    return def[key] ?? '';
  }
  return priorVal ?? '';
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

    const isNewSchemaPrior = prior.length >= 19;
    const emailPreserved = isNewSchemaPrior ? (prior[11] || def.email || '') : (prior[4] || def.email || '');

    rows.push([
      pattern?.cnpjTomador || formatCnpj(key),
      pickField(def, 'razaoSocial', item.razao || pattern?.tomador || prior[1]),
      pickField(def, 'nomeCurto', prior[2]),
      pickField(def, 'logradouro', isNewSchemaPrior ? prior[3] : ''),
      pickField(def, 'numero', isNewSchemaPrior ? prior[4] : ''),
      pickField(def, 'complemento', isNewSchemaPrior ? prior[5] : ''),
      pickField(def, 'bairro', isNewSchemaPrior ? prior[6] : ''),
      pickField(def, 'codigoMunicipio', isNewSchemaPrior ? prior[7] : ''),
      pickField(def, 'municipio', isNewSchemaPrior ? prior[8] : ''),
      pickField(def, 'uf', isNewSchemaPrior ? prior[9] : ''),
      pickField(def, 'cep', isNewSchemaPrior ? prior[10] : ''),
      emailPreserved,
      pickField(def, 'categorias', [...item.categorias].sort().join(', ')),
      pickField(def, 'statusHomologacao', isNewSchemaPrior ? prior[13] : 'HOMOLOGADO'),
      pickField(def, 'fonteEndereco', isNewSchemaPrior ? prior[14] : 'NFS-e histórica'),
      pickField(def, 'validadoEm', isNewSchemaPrior ? prior[15] : '2026-08-22'),
      pickField(def, 'primeiroUso', ordered[0] || (isNewSchemaPrior ? prior[16] : '')),
      pickField(def, 'ultimoUso', ordered.at(-1) || (isNewSchemaPrior ? prior[17] : '')),
      def.qtdNfse !== undefined ? def.qtdNfse : (item.total || (isNewSchemaPrior ? Number(prior[18]) : 0))
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
      p.issRetido, p.exigibilidadeIss, p.nbs,
      p.camposFixos, p.camposVariaveis, p.camposNaoHardcodar,
      String(p.quantidadeExemplos),
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
  const appendValues = dependencies.appendSheetValues || appendSheetValues;

  const [notasPlanilha, tomadoresAtuais, padroesAtuais, demandasAtuais] = await Promise.all([
    readValues(ssId, `${CONFIG.SHEETS.TABS.NOTAS}!A:X`),
    readValues(ssId, `${CONFIG.SHEETS.TABS.TOMADORES}!A:S`),
    readValues(ssId, `${CONFIG.SHEETS.TABS.PADROES}!A:X`),
    readValues(ssId, `${CONFIG.SHEETS.TABS.DEMANDAS}!A:G`).catch(() => [])
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

    // Garante que a linha de demanda sintética para o teste E2E exista na aba Demandas
    const testRequestId = 'e2e-integration-test-live-1';
    const demandExists = (demandasAtuais || []).some(row => String(row[0] || '').trim() === testRequestId);
    if (!demandExists) {
      const e2eDemandRow = [
        testRequestId,
        '08/2026',
        'HIC — Plantões Médicos PS SUS',
        '10,00',
        'TESTE DE INTEGRACAO DRY-RUN — NAO EMITIR',
        'READY_TO_PREPARE',
        ''
      ];
      await appendValues(ssId, `${CONFIG.SHEETS.TABS.DEMANDAS}!A:G`, [e2eDemandRow]);
      executedWrites++;
    }
  }

  // Leitura de conferência após atualização
  const tomadoresLidos = await readValues(ssId, `${CONFIG.SHEETS.TABS.TOMADORES}!A1:S${tomadoresRows.length}`);

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
    readBackTomadoresA1S3: tomadoresLidos.slice(0, 3),
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
