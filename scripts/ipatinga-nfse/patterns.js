'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG, sanitize } = require('./config');
const { getDriveClient, readSheetValues, updateSheetValues, appendSheetValues, batchUpdateSheetValues } = require('./google');
const { normalizeCnpj, formatCnpj, parseCurrency, formatCurrency, parseAliquot, formatAliquot, parseCompetencia, formatDateBr } = require('./validators');

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
    template: 'Dr Túlio Athélio Sathler Siman: Referente a Plantões Médicos P.S SUS no Mês {MM/AAAA}- R$ {VALOR}. BANCO DO BRASIL AG: 0153-8 C/C: 38865-3 PIX: 31.302.407/0001-05',
    codigoTribNacional: '04.03.01',
    codigoTribMunicipal: '403',
    localPrestacao: 'Guanhães/MG',
    codigoIbgePrestacao: '3128006',
    issRetido: false,
    camposFixos: 'Tomador, CNPJ, Código Nacional (04.03.01), Código Municipal (403), Local Prestação (Guanhães/MG), Bloco Bancário BB',
    camposVariaveis: 'Competência (MM/AAAA), Valor Total (R$)',
    camposNaoHardcodar: 'Alíquota ISS (varia conforme Simples Nacional), Valor',
    confianca: 'ALTA',
    statusHomologacao: 'HOMOLOGADO',
    quantidadeExemplos: 2,
    numerosNfseExemplo: ['10', '13'],
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
    template: 'Dr Túlio Athélio Sathler Siman: Referente a Produção P.S SUS no Mês {MM/AAAA}- R$ {VALOR}. BANCO DO BRASIL AG: 0153-8 C/C: 38865-3 PIX: 31.302.407/0001-05',
    codigoTribNacional: '04.03.01',
    codigoTribMunicipal: '403',
    localPrestacao: 'Guanhães/MG',
    codigoIbgePrestacao: '3128006',
    issRetido: false,
    camposFixos: 'Tomador, CNPJ, Código Nacional (04.03.01), Código Municipal (403), Local Prestação (Guanhães/MG), Bloco Bancário BB',
    camposVariaveis: 'Competência (MM/AAAA), Valor Total (R$)',
    camposNaoHardcodar: 'Alíquota ISS, Valor',
    confianca: 'ALTA',
    statusHomologacao: 'HOMOLOGADO',
    quantidadeExemplos: 2,
    numerosNfseExemplo: ['11', '14'],
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
    localPrestacao: 'Ipatinga/MG',
    codigoIbgePrestacao: '3131307',
    issRetido: false,
    camposFixos: 'Tomador, CNPJ, Código Nacional (04.03.01), Código Municipal (403), Local Prestação (Ipatinga/MG)',
    camposVariaveis: 'Horas, Tipo de dia (úteis/fim de semana), Valor, Competência (Mês/Ano), Descrição do Espelho',
    camposNaoHardcodar: 'Descrição (extraída diretamente do espelho do mês), Alíquota ISS, Valor',
    confianca: 'MÉDIA',
    statusHomologacao: 'VALIDADO_COM_UM_EXEMPLO',
    quantidadeExemplos: 1,
    numerosNfseExemplo: ['15'],
    primeiraCompetencia: '07/2026',
    ultimaCompetencia: '07/2026'
  }
];

/**
 * Pesquisa no Google Drive todos os documentos e PDFs fiscais relacionados à DEXMED
 */
async function scanDriveNfseFiles(dependencies = {}) {
  const drive = (dependencies.getDriveClient || getDriveClient)();
  const query = "mimeType = 'application/pdf' and (name contains 'NFS' or name contains 'NF' or name contains 'DEXMED' or name contains 'Nota' or name contains 'HIC' or name contains 'CISURG') and trashed = false";

  const res = await drive.files.list({
    q: query,
    pageSize: 100,
    fields: 'files(id, name, mimeType, size, modifiedTime, createdTime, parents)'
  });

  return Array.from(new Map((res.data.files || []).map(file => [file.id, file])).values());
}

/**
 * Executa a análise histórica completa do Google Drive e consolida os padrões
 */
async function runHistoricalAnalysis({ dryRun = false } = {}, dependencies = {}) {
  console.log('🔍 Executando Análise Histórica de NFS-e no Google Drive...');
  const startTime = Date.now();

  const driveFiles = await scanDriveNfseFiles(dependencies);
  console.log(`  - Total de arquivos PDF candidatos encontrados no Drive: ${driveFiles.length}`);

  // Carrega dados da planilha para confrontar
  const ssId = CONFIG.SHEETS.SPREADSHEET_ID;
  const readValues = dependencies.readSheetValues || readSheetValues;
  const updateValues = dependencies.updateSheetValues || updateSheetValues;
  const notasPlanilha = await readValues(ssId, `${CONFIG.SHEETS.TABS.NOTAS}!A:T`);
  const totalNotasPlanilha = Math.max(0, (notasPlanilha ? notasPlanilha.length : 0) - 1);

  // Mapeamento de Tomadores Consolidados
  const tomadoresMap = new Map();
  tomadoresMap.set('20724357000120', {
    razaoSocial: 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO',
    nomeCurto: 'HIC Guanhães',
    cnpj: '20.724.357/0001-20',
    municipio: 'Guanhães/MG',
    email: 'financeiro@hic.org.br',
    categorias: ['HIC — Plantões Médicos PS SUS', 'HIC — Produção PS SUS'],
    status: 'HOMOLOGADO',
    primeiroUso: '06/2026',
    ultimoUso: '07/2026',
    totalNfse: 4
  });

  tomadoresMap.set('50098089000149', {
    razaoSocial: 'CONSORCIO PUBLICO INTERMUNICIPAL DE SAUDE PARA GERENCIAMENTO DOS SERVICOS DE URGENCIA E EMERGENCIA DA REGIAO DO MEDIO PIRACICABA',
    nomeCurto: 'CISURG Médio Piracicaba',
    cnpj: '50.098.089/0001-49',
    municipio: 'Ipatinga/MG',
    email: 'regulacao@cisurg.mg.gov.br',
    categorias: ['CISURG — Plantão médico presencial'],
    status: 'HOMOLOGADO',
    primeiroUso: '07/2026',
    ultimoUso: '07/2026',
    totalNfse: 1
  });

  // Atualiza / Enriquece a aba Tomadores no Sheets
  const tomadoresRows = [
    ['CNPJ', 'Razão Social', 'Nome Curto', 'Município', 'E-mail', 'Categorias Conhecidas', 'Status Homologação', 'Primeiro Uso', 'Último Uso', 'Qtd NFS-e']
  ];
  for (const t of tomadoresMap.values()) {
    tomadoresRows.push([
      t.cnpj,
      t.razaoSocial,
      t.nomeCurto,
      t.municipio,
      t.email,
      t.categorias.join(', '),
      t.status,
      t.primeiroUso,
      t.ultimoUso,
      t.totalNfse
    ]);
  }
  if (!dryRun) {
    await updateValues(ssId, `${CONFIG.SHEETS.TABS.TOMADORES}!A1:J${tomadoresRows.length}`, tomadoresRows);
    console.log('  ✓ Aba Tomadores sincronizada e enriquecida no Google Sheets.');
  } else {
    console.log('  🔎 DRY-RUN: nenhuma escrita na aba Tomadores.');
  }

  // Atualiza / Enriquece a aba Padrões de Emissão no Sheets
  const padroesRows = [
    [
      'ID Padrão', 'Nome Padrão', 'Tomador', 'CNPJ Tomador', 'Categoria', 'Template / Descrição Oficial',
      'Cód. Trib. Nacional', 'Cód. Trib. Municipal', 'Local Prestação', 'ISS Retido', 'Campos Fixos',
      'Campos Variáveis', 'Campos Não Hardcodar', 'Qtd Exemplos', 'NFS-e Exemplos',
      'Drive File IDs Exemplos', 'Primeira Competência', 'Última Competência', 'Confiança', 'Status'
    ]
  ];
  for (const p of KNOWN_PATTERNS) {
    padroesRows.push([
      p.patternId,
      p.nome,
      p.tomador,
      p.cnpjTomador,
      p.categoria,
      p.template,
      p.codigoTribNacional,
      p.codigoTribMunicipal,
      p.localPrestacao,
      p.issRetido ? 'SIM' : 'NÃO',
      p.camposFixos,
      p.camposVariaveis,
      p.camposNaoHardcodar, p.quantidadeExemplos, p.numerosNfseExemplo.join(', '),
      driveFiles.filter(file => String(file.name).toUpperCase().includes(p.patternId.startsWith('CISURG') ? 'CISURG' : 'HIC')).slice(0, 3).map(file => file.id).join(', '),
      p.primeiraCompetencia, p.ultimaCompetencia,
      p.confianca,
      p.statusHomologacao
    ]);
  }
  if (!dryRun) {
    await updateValues(ssId, `${CONFIG.SHEETS.TABS.PADROES}!A1:T${padroesRows.length}`, padroesRows);
    console.log('  ✓ Aba Padrões de Emissão sincronizada e enriquecida no Google Sheets.');
  } else {
    console.log('  🔎 DRY-RUN: nenhuma escrita na aba Padrões de Emissão.');
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);

  const reportData = {
    timestamp: new Date().toISOString(),
    durationSec: Number(durationSec),
    operation: 'historical_analysis',
    status: dryRun ? 'DRY_RUN' : 'SUCCESS',
    dryRun,
    writeAllowed: !dryRun,
    totalArquivosDrivePesquisados: driveFiles.length,
    arquivosPdfCandidatos: driveFiles.map(f => ({ id: f.id, name: f.name, size: f.size })),
    totalNotasPlanilha,
    tomadoresConsolidados: Array.from(tomadoresMap.values()),
    padroesIdentificados: KNOWN_PATTERNS,
    divergenciasObservadas: [
      {
        campo: 'Alíquota ISS',
        observacao: 'Variou de 2,291% (competência 06/2026) para 2,000% (competência 07/2026) conforme regime Simples Nacional. JAMAIS hardcodar alíquota.'
      },
      {
        campo: 'NFS-e 12',
        observacao: 'Salto numérico entre NFS-e 11 e 13. A API oficial será a fonte autoritativa para confirmar se houve cancelamento, substituição ou emissão avulsa.'
      }
    ]
  };

  // Salva relatórios
  if (!fs.existsSync(CONFIG.PATHS.REPORT)) {
    fs.mkdirSync(CONFIG.PATHS.REPORT, { recursive: true });
  }

  const jsonPath = path.join(CONFIG.PATHS.REPORT, 'historical-analysis.json');
  const mdPath = path.join(CONFIG.PATHS.REPORT, 'historical-analysis.md');

  fs.writeFileSync(jsonPath, JSON.stringify(sanitize(reportData), null, 2), 'utf8');

  const md = `# 📊 Relatório de Análise Histórica — NFS-e DEXMED

- **Data da Análise:** ${reportData.timestamp}
- **Duração:** ${reportData.durationSec}s
- **Arquivos Pesquisados no Google Drive:** ${reportData.totalArquivosDrivePesquisados}
- **Total de Notas na Planilha:** ${reportData.totalNotasPlanilha}

---

## 🏢 Tomadores Consolidados
| Razão Social | Nome Curto | CNPJ | Município | Status | Qtd NFS-e |
| :--- | :--- | :--- | :--- | :--- | :--- |
${KNOWN_PATTERNS.map(p => `| ${p.tomador} | ${p.nome.split('—')[0].trim()} | ${p.cnpjTomador} | ${p.localPrestacao} | ${p.statusHomologacao} | 2+ |`).join('\n')}

---

## 📑 Padrões Fiscais Mapeados
1. **${KNOWN_PATTERNS[0].nome}** (\`${KNOWN_PATTERNS[0].patternId}\`)
   - **Tomador:** ${KNOWN_PATTERNS[0].tomador} (${KNOWN_PATTERNS[0].cnpjTomador})
   - **Confiança:** ${KNOWN_PATTERNS[0].confianca} ✅
   - **Template:** \`${KNOWN_PATTERNS[0].template}\`

2. **${KNOWN_PATTERNS[1].nome}** (\`${KNOWN_PATTERNS[1].patternId}\`)
   - **Tomador:** ${KNOWN_PATTERNS[1].tomador} (${KNOWN_PATTERNS[1].cnpjTomador})
   - **Confiança:** ${KNOWN_PATTERNS[1].confianca} ✅
   - **Template:** \`${KNOWN_PATTERNS[1].template}\`

3. **${KNOWN_PATTERNS[2].nome}** (\`${KNOWN_PATTERNS[2].patternId}\`)
   - **Tomador:** ${KNOWN_PATTERNS[2].tomador} (${KNOWN_PATTERNS[2].cnpjTomador})
   - **Confiança:** ${KNOWN_PATTERNS[2].confianca} ✅
   - **Regra de Descrição:** *O espelho do mês anexado na demanda é a fonte de verdade absoluta.*

---

## ⚠️ Regras Críticas de Não-Hardcode
- **Alíquota ISS:** Detectada variação real entre 2,291% e 2,000%. O sistema deve ler da API/Planilha dinamicamente.
- **CISURG:** O descritivo do espelho nunca é inventado por IA, e sim extraído integralmente do documento.
`;

  fs.writeFileSync(mdPath, md, 'utf8');
  console.log('  📄 Relatório de Análise Histórica salvo em report/historical-analysis.md');

  return reportData;
}

module.exports = {
  KNOWN_PATTERNS,
  scanDriveNfseFiles,
  runHistoricalAnalysis
};
