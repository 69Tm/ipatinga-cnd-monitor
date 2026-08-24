'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG } = require('./config');
const { getDriveClient, readSheetValues, updateSheetValues, appendSheetValues, createSheetIfNotExists } = require('./google');
const { normalizeCnpj, parseCurrency, parseCompetencia, formatDateBr, formatCurrency } = require('./validators');

const KNOWN_PATTERNS = [
  {
    patternId: 'HIC_PLANTOES_PS_SUS',
    nome: 'HIC — Plantões Médicos PS SUS',
    tomador: 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO',
    cnpjTomador: '20.724.357/0001-20',
    cnpjTomadorClean: '20724357000120',
    categoria: 'HIC — Plantões Médicos PS SUS',
    template: 'Dr Túlio Athélio Sathler Siman: Referente a Plantões Médicos P.S SUS no Mês {MM/AAAA}- R$ {VALOR}. {BLOCO_BANCARIO}',
    codigoTribNacional: '04.03.01',
    codigoTribMunicipal: '403',
    localPrestacao: 'Guanhães/MG',
    codigoIbgePrestacao: '3128006',
    codigoMunicipioIncidenciaIss: '3131307', // Regra: ISS devido no município prestador (Ipatinga/MG)
    issRetido: '2', // 1 = Sim, 2 = Não
    exigibilidadeIss: '1', // 1 = Exigível
    nbs: '123011900',
    camposFixos: 'Tomador, CNPJ, Código Nacional (04.03.01), Código Municipal (403), Local Prestação (Guanhães/MG), Cód Incidência ISS (3131307), Bloco Bancário injetado em runtime',
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
    template: 'Dr Túlio Athélio Sathler Siman: Referente a Produção P.S SUS no Mês {MM/AAAA}- R$ {VALOR}. {BLOCO_BANCARIO}',
    codigoTribNacional: '04.03.01',
    codigoTribMunicipal: '403',
    localPrestacao: 'Guanhães/MG',
    codigoIbgePrestacao: '3128006',
    codigoMunicipioIncidenciaIss: '3131307', // Regra: ISS devido no município prestador (Ipatinga/MG)
    issRetido: '2',
    exigibilidadeIss: '1',
    nbs: '123011900',
    camposFixos: 'Tomador, CNPJ, Código Nacional (04.03.01), Código Municipal (403), Local Prestação (Guanhães/MG), Cód Incidência ISS (3131307), Bloco Bancário injetado em runtime',
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
async function scanDriveForFiscalDocs(driveFolderId = null) {
  const folderId = driveFolderId || CONFIG.DRIVE.FOLDER_ID;
  const drive = getDriveClient();
  const foundFiles = [];

  try {
    const q = `'${folderId}' in parents and trashed = false`;
    const res = await drive.files.list({
      q,
      fields: 'files(id, name, mimeType, createdTime, size, description)',
      pageSize: 100
    });

    const files = res.data.files || [];
    for (const f of files) {
      const name = String(f.name || '').toLowerCase();
      if (name.includes('nf') || name.includes('nota') || name.includes('rps') || name.includes('espelho') || name.includes('hic') || name.includes('cisurg')) {
        foundFiles.push(f);
      }
    }
  } catch (err) {
    console.log(`[WARN] Erro ao escanear Drive: ${err.message}`);
  }

  return foundFiles;
}

function buildTomadoresRows(notasRows = [], existingTomadores = []) {
  const headers = [
    'CNPJ',
    'Razão Social',
    'Nome Curto',
    'Logradouro',
    'Número',
    'Complemento',
    'Bairro',
    'Cód. Município',
    'Município',
    'UF',
    'CEP',
    'E-mail',
    'Categorias Conhecidas',
    'Status Homologação',
    'Fonte Endereço',
    'Validado Em',
    'Primeiro Uso',
    'Último Uso',
    'Qtd NFS-e'
  ];

  const rows = [headers];

  const existingMap = new Map();
  if (existingTomadores && existingTomadores.length > 1) {
    for (let i = 1; i < existingTomadores.length; i++) {
      const row = existingTomadores[i];
      const clean = normalizeCnpj(row[0]);
      if (clean) existingMap.set(clean, row);
    }
  }

  for (const [cnpjClean, defaults] of Object.entries(TOMADORES_DEFAULTS)) {
    const formattedCnpj = cnpjClean.length === 14
      ? `${cnpjClean.slice(0, 2)}.${cnpjClean.slice(2, 5)}.${cnpjClean.slice(5, 8)}/${cnpjClean.slice(8, 12)}-${cnpjClean.slice(12)}`
      : cnpjClean;

    const exist = existingMap.get(cnpjClean);
    let row;

    if (exist && exist.length >= 12) {
      let logradouro = exist[3] || defaults.logradouro;
      let numero = exist[4] || defaults.numero;
      let complemento = exist[5] || defaults.complemento;
      let bairro = exist[6] || defaults.bairro;
      let codMun = exist[7] || defaults.codigoMunicipio;
      let mun = exist[8] || defaults.municipio;
      let uf = exist[9] || defaults.uf;
      let cep = exist[10] || defaults.cep;
      let email = exist[11] || defaults.email;

      // Corrige regressão histórica de shift se o complemento contiver string de categoria
      if (complemento && (complemento.includes('—') || complemento.includes('Plantão') || complemento.includes('Produção'))) {
        complemento = defaults.complemento || '';
      }

      row = [
        formattedCnpj,
        exist[1] || defaults.razaoSocial,
        exist[2] || defaults.nomeCurto,
        logradouro,
        numero,
        complemento,
        bairro,
        codMun,
        mun,
        uf,
        cep,
        email,
        exist[12] || defaults.categorias,
        exist[13] || defaults.statusHomologacao,
        exist[14] || defaults.fonteEndereco,
        exist[15] || defaults.validadoEm,
        exist[16] || defaults.primeiroUso,
        exist[17] || defaults.ultimoUso,
        exist[18] ? parseInt(exist[18], 10) : defaults.qtdNfse
      ];
    } else {
      row = [
        formattedCnpj,
        defaults.razaoSocial,
        defaults.nomeCurto,
        defaults.logradouro,
        defaults.numero,
        defaults.complemento,
        defaults.bairro,
        defaults.codigoMunicipio,
        defaults.municipio,
        defaults.uf,
        defaults.cep,
        defaults.email,
        defaults.categorias,
        defaults.statusHomologacao,
        defaults.fonteEndereco,
        defaults.validadoEm,
        defaults.primeiroUso,
        defaults.ultimoUso,
        defaults.qtdNfse
      ];
    }
    rows.push(row);
  }

  return rows;
}

function buildPadroesRows() {
  const headers = [
    'ID Padrão',
    'Nome Padrão',
    'Tomador',
    'CNPJ Tomador',
    'Categoria',
    'Template / Descrição Oficial',
    'Cód. Trib. Nacional',
    'Cód. Trib. Municipal',
    'Local Prestação',
    'Cód. Município Prestação',
    'Cód. Município Incidência',
    'ISS Retido',
    'Exigibilidade ISS',
    'NBS',
    'Campos Fixos',
    'Campos Variáveis',
    'Campos a Não Hardcodar',
    'Confiança',
    'Status Homologação',
    'Qtd Exemplos',
    'NFS-e Exemplo',
    'Drive File IDs',
    'Primeira Competência',
    'Última Competência'
  ];

  const rows = [headers];

  for (const p of KNOWN_PATTERNS) {
    rows.push([
      p.patternId,
      p.nome,
      p.tomador,
      p.cnpjTomador,
      p.categoria,
      p.template,
      p.codigoTribNacional,
      p.codigoTribMunicipal,
      p.localPrestacao,
      p.codigoIbgePrestacao,
      p.codigoMunicipioIncidenciaIss,
      p.issRetido,
      p.exigibilidadeIss,
      p.nbs,
      p.camposFixos,
      p.camposVariaveis,
      p.camposNaoHardcodar,
      p.confianca,
      p.statusHomologacao,
      p.quantidadeExemplos,
      (p.numerosNfseExemplo || []).join(', '),
      (p.driveFileIdsExemplo || []).join(', '),
      p.primeiraCompetencia,
      p.ultimaCompetencia
    ]);
  }

  return rows;
}

async function runHistoricalAnalysis(options = {}, dependencies = {}) {
  const spreadsheetId = options.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const dryRun = options.dryRun || false;
  const read = dependencies.readSheetValues || readSheetValues;
  const update = dependencies.updateSheetValues || updateSheetValues;
  const createSheet = dependencies.createSheetIfNotExists || createSheetIfNotExists;

  console.log('\n====================================================');
  console.log('    ANÁLISE HISTÓRICA E MAPEAMENTO DE PADRÕES       ');
  console.log('====================================================\n');

  const [notasRaw, tomadoresRaw] = await Promise.all([
    read(spreadsheetId, `${CONFIG.SHEETS.TABS.NOTAS}!A:X`),
    read(spreadsheetId, `${CONFIG.SHEETS.TABS.TOMADORES}!A:S`).catch(() => [])
  ]);

  const driveFiles = await scanDriveForFiscalDocs();
  console.log(`  ✓ Arquivos fiscais relevantes localizados no Drive: ${driveFiles.length}`);

  const tomadoresRows = buildTomadoresRows(notasRaw, tomadoresRaw);
  const padroesRows = buildPadroesRows();

  if (!dryRun) {
    await createSheet(spreadsheetId, CONFIG.SHEETS.TABS.TOMADORES);
    await update(spreadsheetId, `${CONFIG.SHEETS.TABS.TOMADORES}!A1:S${tomadoresRows.length}`, tomadoresRows);
    console.log(`  ✓ Aba '${CONFIG.SHEETS.TABS.TOMADORES}' sincronizada com ${tomadoresRows.length - 1} tomadores homologados.`);

    await createSheet(spreadsheetId, CONFIG.SHEETS.TABS.PADROES);
    await update(spreadsheetId, `${CONFIG.SHEETS.TABS.PADROES}!A1:X${padroesRows.length}`, padroesRows);
    console.log(`  ✓ Aba '${CONFIG.SHEETS.TABS.PADROES}' sincronizada com ${padroesRows.length - 1} padrões consolidados.`);
  } else {
    console.log(`  [DRY-RUN] Nenhuma alteração gravada nas abas Tomadores e Padrões.`);
  }

  return {
    status: 'SUCCESS',
    tomadoresHomologados: tomadoresRows.length - 1,
    padroesIdentificados: padroesRows.length - 1,
    driveDocsFound: driveFiles.length,
    dryRun
  };
}

module.exports = {
  KNOWN_PATTERNS,
  TOMADORES_DEFAULTS,
  buildTomadoresRows,
  buildPadroesRows,
  scanDriveForFiscalDocs,
  runHistoricalAnalysis
};
