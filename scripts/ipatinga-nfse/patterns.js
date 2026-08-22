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
    municipioIncidencia: 'Ipatinga/MG',
    nbs: '123011900',
    issRetido: false,
    camposFixos: 'Tomador, CNPJ, Código Nacional (04.03.01), Código Municipal (403), Local Prestação (Guanhães/MG), Bloco Bancário BB',
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
    municipioIncidencia: 'Ipatinga/MG',
    nbs: '123011900',
    issRetido: false,
    camposFixos: 'Tomador, CNPJ, Código Nacional (04.03.01), Código Municipal (403), Local Prestação (Guanhães/MG), Bloco Bancário BB',
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
    municipioIncidencia: 'Ipatinga/MG',
    nbs: '123011900',
    issRetido: false,
    camposFixos: 'Tomador, CNPJ, Código Nacional (04.03.01), Código Municipal (403), NBS (123011900)',
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

/**
 * Pesquisa no Google Drive todos os documentos e PDFs fiscais relacionados à DEXMED
 */
async function scanDriveNfseFiles(dependencies = {}) {
  const drive = (dependencies.getDriveClient || getDriveClient)();
  const query = "mimeType = 'application/pdf' and (name contains 'NFS' or name contains 'NFE' or name contains 'DANF' or name contains 'nota fiscal') and trashed = false";

  const res = await drive.files.list({
    q: query,
    pageSize: 100,
    fields: 'files(id, name, mimeType, size, modifiedTime, createdTime, parents)'
  });

  return Array.from(new Map((res.data.files || [])
    .filter(file => /(?:^|\b)(?:nf(?:e|s(?:-?e)?)?|danfse?|nota fiscal)(?:\b|\s|[-_])/i.test(String(file.name || '')))
    .map(file => [file.id, file])).values());
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
  const headers = ['CNPJ', 'Razão Social', 'Nome Curto', 'Município', 'E-mail', 'Categorias Conhecidas', 'Status Homologação', 'Primeiro Uso', 'Último Uso', 'Qtd NFS-e'];
  const defaults = {
    '20724357000120': { nomeCurto: 'HIC Guanhães', municipio: 'Guanhães/MG' },
    '50098089000149': { nomeCurto: 'CISURG Médio Piracicaba', municipio: 'Itabira/MG' }
  };
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
  const rows = [headers];
  for (const [key, item] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const prior = existing.get(key) || [];
    const ordered = item.competencias.filter(Boolean).sort((a, b) => competenceOrder(a) - competenceOrder(b));
    const pattern = KNOWN_PATTERNS.find(candidate => candidate.cnpjTomadorClean === key);
    rows.push([
      pattern?.cnpjTomador || formatCnpj(key),
      item.razao || pattern?.tomador || prior[1] || '',
      prior[2] || defaults[key]?.nomeCurto || '',
      defaults[key]?.municipio || prior[3] || '',
      prior[4] || '',
      [...item.categorias].sort().join(', '),
      prior[6] || 'EVIDENCIA_HISTORICA_VALIDADA',
      ordered[0] || prior[7] || '',
      ordered.at(-1) || prior[8] || '',
      item.total
    ]);
  }
  return rows;
}

function buildPadroesRows() {
  const rows = [[
    'ID Padrão', 'Nome Padrão', 'Tomador', 'CNPJ Tomador', 'Categoria', 'Template / Descrição Oficial',
    'Cód. Trib. Nacional', 'Cód. Trib. Municipal', 'Local Prestação', 'NBS', 'Campos Fixos',
    'Campos Variáveis', 'Campos Não Hardcodar', 'Qtd Exemplos', 'NFS-e Exemplos',
    'Drive File IDs Exemplos', 'Primeira Competência', 'Última Competência', 'Confiança', 'Status'
  ]];
  for (const p of KNOWN_PATTERNS) {
    rows.push([
      p.patternId, p.nome, p.tomador, p.cnpjTomador, p.categoria, p.template,
      p.codigoTribNacional, p.codigoTribMunicipal, p.localPrestacao, p.nbs,
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
async function runHistoricalAnalysis({ dryRun = false } = {}, dependencies = {}) {
  console.log('🔍 Executando Análise Histórica de NFS-e no Google Drive...');
  const startTime = Date.now();
  const driveFiles = await scanDriveNfseFiles(dependencies);
  console.log(`  - Total de arquivos PDF candidatos encontrados no Drive: ${driveFiles.length}`);

  const ssId = CONFIG.SHEETS.SPREADSHEET_ID;
  const readValues = dependencies.readSheetValues || readSheetValues;
  const updateValues = dependencies.updateSheetValues || updateSheetValues;
  const batchUpdate = dependencies.batchUpdateSheetValues || batchUpdateSheetValues;
  const [notasPlanilha, tomadoresAtuais, padroesAtuais] = await Promise.all([
    readValues(ssId, `${CONFIG.SHEETS.TABS.NOTAS}!A:X`),
    readValues(ssId, `${CONFIG.SHEETS.TABS.TOMADORES}!A:J`),
    readValues(ssId, `${CONFIG.SHEETS.TABS.PADROES}!A:T`)
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
      await updateValues(ssId, `${CONFIG.SHEETS.TABS.TOMADORES}!A1:J${tomadoresRows.length}`, tomadoresRows);
      executedWrites++;
    }
    if (padroesChanged) {
      await updateValues(ssId, `${CONFIG.SHEETS.TABS.PADROES}!A1:T${padroesRows.length}`, padroesRows);
      executedWrites++;
    }
    if (legacyPatternRows > 0) {
      const first = padroesRows.length + 1;
      const last = first + legacyPatternRows - 1;
      await updateValues(ssId, `${CONFIG.SHEETS.TABS.PADROES}!A${first}:T${last}`, Array.from({ length: legacyPatternRows }, () => Array(20).fill('')));
      executedWrites++;
    }
    if (localRepairs.length > 0) {
      await batchUpdate(ssId, localRepairs.map(item => ({ range: item.range, values: [[item.value]] })));
      executedWrites++;
    }
  } else {
    console.log('  🔎 DRY-RUN: nenhuma escrita externa executada.');
  }

  const reportData = {
    timestamp: new Date().toISOString(),
    durationSec: Number(((Date.now() - startTime) / 1000).toFixed(2)),
    operation: 'historical_analysis',
    status: dryRun ? 'DRY_RUN' : 'SUCCESS',
    dryRun,
    writeAllowed: !dryRun,
    plannedWrites,
    executedWrites,
    totalArquivosDrivePesquisados: driveFiles.length,
    arquivosPdfCandidatos: driveFiles.map(f => ({ id: f.id, name: f.name, size: f.size })),
    driveEvidenceIdsValidated: KNOWN_PATTERNS.flatMap(pattern => pattern.driveFileIdsExemplo),
    totalNotasPlanilha: Math.max(0, (notasPlanilha || []).length - 1),
    tomadoresConsolidados: tomadoresRows.slice(1),
    padroesIdentificados: KNOWN_PATTERNS,
    localPrestacaoRepairs: localRepairs.map(item => ({ numero: item.numero, value: item.value })),
    divergenciasObservadas: [
      { campo: 'Código tributário', observacao: 'SOAP expõe ItemListaServico 04.03; DANFSe oficial expõe Código de tributação nacional 04.03.01.' },
      { campo: 'Local da prestação', observacao: 'SOAP retornou código municipal 0; DANFSe 13, 14 e 15 comprova Guanhães/MG. Município de incidência do ISS é Ipatinga/MG.' },
      { campo: 'Alíquota ISS', observacao: 'Varia historicamente (inclusive 2,4227%, 2,4097% e 2,0000%). Nunca hardcodar.' },
      { campo: 'NFS-e 12', observacao: 'A API oficial confirmou NFS-e 12 NORMAL, CISURG, competência 08/2026, valor R$ 10.661,00.' },
      { campo: 'CISURG', observacao: 'O espelho mensal permanece a fonte do descritivo principal; histórico serve somente como validação.' }
    ]
  };

  if (!fs.existsSync(CONFIG.PATHS.REPORT)) fs.mkdirSync(CONFIG.PATHS.REPORT, { recursive: true });
  fs.writeFileSync(path.join(CONFIG.PATHS.REPORT, 'historical-analysis.json'), JSON.stringify(sanitize(reportData), null, 2), 'utf8');
  const md = `# Relatório de Análise Histórica - NFS-e DEXMED

- **Data:** ${reportData.timestamp}
- **Status:** ${reportData.status}
- **PDFs candidatos acessíveis ao executor:** ${reportData.totalArquivosDrivePesquisados}
- **Notas consolidadas:** ${reportData.totalNotasPlanilha}
- **Escritas planejadas:** ${reportData.plannedWrites}
- **Escritas executadas:** ${reportData.executedWrites}

## Evidências documentais validadas

${KNOWN_PATTERNS.map(p => `- ${p.nome}: NFS-e ${p.numerosNfseExemplo.join(', ')}; Drive ${p.driveFileIdsExemplo.join(', ')}; confiança ${p.confianca}.`).join('\n')}

## Invariantes

- HIC Plantões e HIC Produção permanecem notas separadas.
- CISURG usa o espelho da competência como fonte do descritivo.
- ISS não é hardcoded.
- Local da prestação e município de incidência são campos distintos.
`;
  fs.writeFileSync(path.join(CONFIG.PATHS.REPORT, 'historical-analysis.md'), md, 'utf8');
  console.log('  📄 Relatório de Análise Histórica salvo em report/historical-analysis.md');
  return reportData;
}

module.exports = {
  KNOWN_PATTERNS,
  scanDriveNfseFiles,
  runHistoricalAnalysis,
  rowsEqual,
  buildTomadoresRows,
  buildPadroesRows,
  buildLocalPrestacaoRepairs
};
