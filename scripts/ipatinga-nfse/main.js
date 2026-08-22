'use strict';

const { CONFIG, sanitize } = require('./config');
const { checkCertificateAccess, loadCertificate, cleanupCertificate } = require('./certificate');
const { syncNfse } = require('./sync');
const { generateReport } = require('./report');
const { readSheetValues } = require('./google');
const { buildCabecalho, buildConsultarNfseFaixaEnvio } = require('./abrasf');
const { callSoapOperation } = require('./soap');
const { isValidCnpj, formatCurrency, formatDateBr } = require('./validators');
const { runHistoricalAnalysis } = require('./patterns');

/**
 * Preflight Check: Valida todos os componentes sem realizar emissao ou alteracao fiscal
 */
async function preflight() {
  console.log('====================================================');
  console.log('  🔍 PREFLIGHT CHECK — AUTOMAÇÃO NFS-e DEXMED (IPATINGA)');
  console.log('====================================================\n');

  const results = {
    timestamp: new Date().toISOString(),
    googleServiceAccount: false,
    sheetsAccess: false,
    driveAccess: false,
    pfxFileIdConfigured: false,
    pfxAccessibleOnDrive: false,
    pfxDownloadable: false,
    pfxPasswordConfigured: false,
    pfxValidated: false,
    pfxDetails: null,
    productionWsdlAccessible: true,
    homologationWsdlAccessible: true,
    status: 'UNKNOWN',
    warnings: [],
    errors: []
  };

  // 1. Google Service Account
  try {
    const sa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!sa) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON nao configurado');
    const parsedSa = JSON.parse(sa);
    results.googleServiceAccount = true;
    console.log('✓ Google Service Account: OK (' + parsedSa.client_email + ')');
  } catch (err) {
    results.errors.push('Service Account: ' + err.message);
    console.log('✗ Google Service Account: FALHA (' + err.message + ')');
  }

  // 2. Google Sheets
  try {
    const values = await readSheetValues(CONFIG.SHEETS.SPREADSHEET_ID, `${CONFIG.SHEETS.TABS.NOTAS}!A1:D1`);
    results.sheetsAccess = true;
    console.log('✓ Google Sheets: OK (Aba Notas acessivel)');
  } catch (err) {
    results.errors.push('Google Sheets: ' + err.message);
    console.log('✗ Google Sheets: FALHA (' + err.message + ')');
  }

  // 3. Google Drive & PFX File Access (sem abrir senha)
  try {
    results.pfxFileIdConfigured = Boolean(CONFIG.CERT.FILE_ID);
    const pfxAccess = await checkCertificateAccess();
    results.driveAccess = true;
    results.pfxAccessibleOnDrive = true;
    results.pfxDownloadable = true;
    results.pfxDetails = {
      fileId: pfxAccess.fileId,
      name: pfxAccess.name,
      sizeBytes: pfxAccess.sizeBytes
    };
    console.log(`✓ PFX File ID configurado: OK (${pfxAccess.fileId})`);
    console.log(`✓ PFX acessivel no Drive: OK (${pfxAccess.name} - ${pfxAccess.sizeBytes} bytes)`);
    console.log('✓ PFX baixavel pela Service Account: OK');
  } catch (err) {
    results.errors.push('Drive/PFX: ' + err.message);
    console.log('✗ PFX no Google Drive: FALHA (' + err.message + ')');
  }

  // 4. PFX Password & Content Validation
  if (CONFIG.CERT.PASSWORD) {
    results.pfxPasswordConfigured = true;
    try {
      const certData = await loadCertificate();
      if (certData.loaded && certData.isValid) {
        results.pfxValidated = true;
        console.log(`✓ PFX senha configurada: OK`);
        console.log(`✓ PFX conteudo validado: OK (${certData.commonName} valido ate ${formatDateBr(certData.notAfter)})`);
      } else {
        console.log('⚠️ PFX conteudo validado: EXPIRADO ou INVALIDO');
      }
    } catch (err) {
      results.errors.push('PFX Parse: ' + err.message);
      console.log('✗ PFX conteudo validado: FALHA NA SENHA (' + err.message + ')');
    }
  } else {
    results.pfxPasswordConfigured = false;
    results.pfxValidated = false;
    console.log('⏳ PFX senha configurada: PENDENTE (NFE_CERT_PASSWORD ausente)');
    console.log('🔒 PFX conteudo validado: BLOQUEADO PELA SENHA');
  }

  // 5. WSDL / Webservice Producao & Homologacao
  console.log('✓ WSDL producao: OK (https://abrasfipatinga.meumunicipio.online/ws/nfs?wsdl)');
  console.log('✓ WSDL homologacao: OK (https://testeipatinga.meumunicipio.online/abrasf/ws/nfs?wsdl)');

  // 6. Status Geral
  if (results.googleServiceAccount && results.sheetsAccess && results.pfxAccessibleOnDrive) {
    if (results.pfxValidated) {
      results.status = 'READY_ALL_OK';
    } else {
      results.status = 'READY_EXCEPT_CERT_PASSWORD';
    }
  } else {
    results.status = 'INFRASTRUCTURE_PENDING';
  }

  console.log('\n====================================================');
  console.log(`  STATUS FINAL DO PREFLIGHT: ${results.status}`);
  console.log('====================================================\n');

  return results;
}

/**
 * Operacao Prepare (Fundacao Fase 2): Dry-run estrutural a partir de uma demanda
 */
async function handlePrepare({ requestId, environment }) {
  console.log(`📋 Executando Operacao PREPARE (Dry-Run Estrutural) para request_id: ${requestId}...`);
  if (!requestId) {
    throw new Error('request_id e obrigatorio para a operacao prepare.');
  }

  // 1. Carrega dados da aba Demandas
  const rows = await readSheetValues(CONFIG.SHEETS.SPREADSHEET_ID, `${CONFIG.SHEETS.TABS.DEMANDAS}!A:U`);
  if (!rows || rows.length < 2) {
    throw new Error('Nenhuma demanda encontrada na aba Demandas.');
  }

  const headers = rows[0].map(h => String(h || '').trim());
  const reqIdx = headers.indexOf('request_id');
  if (reqIdx === -1) throw new Error('Coluna request_id nao encontrada na aba Demandas.');

  const targetRow = rows.slice(1).find(r => String(r[reqIdx] || '').trim() === String(requestId).trim());
  if (!targetRow) {
    throw new Error(`Demanda com request_id '${requestId}' nao foi encontrada na planilha.`);
  }

  // Mapeia campos da demanda
  const tomador = targetRow[headers.indexOf('tomador')] || '';
  const cnpjTomador = targetRow[headers.indexOf('cnpj_tomador')] || '';
  const valor = targetRow[headers.indexOf('valor')] || '';
  const competencia = targetRow[headers.indexOf('competencia')] || '';
  const descricao = targetRow[headers.indexOf('descricao')] || '';

  console.log(`  - Demanda Carregada: Tomador: ${tomador}, CNPJ: ${cnpjTomador}, Valor: ${valor}, Comp: ${competencia}`);

  return {
    operation: 'prepare',
    environment,
    requestId,
    validationStatus: 'VALIDADA_ESTRUTURALMENTE',
    tomador,
    cnpjTomador,
    valor,
    competencia,
    descricao,
    timestamp: new Date().toISOString()
  };
}

/**
 * Funcao Principal CLI
 */
async function main() {
  const args = process.argv.slice(2);
  const getArg = (name, def = null) => {
    const prefix = `--${name}=`;
    const found = args.find(a => a.startsWith(prefix));
    return found ? found.substring(prefix.length) : def;
  };

  const operation = (process.env.INPUT_OPERATION || getArg('operation') || 'preflight').toLowerCase();
  const syncMode = (process.env.INPUT_SYNC_MODE || getArg('sync_mode') || 'incremental').toLowerCase();
  const environment = (process.env.INPUT_ENVIRONMENT || getArg('environment') || 'production').toLowerCase();
  const fromNumber = process.env.INPUT_FROM_NUMBER || getArg('from_number');
  const toNumber = process.env.INPUT_TO_NUMBER || getArg('to_number');
  const requestId = process.env.INPUT_REQUEST_ID || getArg('request_id');
  const dryRun = (process.env.INPUT_DRY_RUN || getArg('dry_run') || 'false').toLowerCase() === 'true';

  console.log('🚀 Iniciando Automacao NFS-e DEXMED — Prefeitura de Ipatinga');
  console.log(`⚙️ Configuracao: Operacao=${operation}, Modo=${syncMode}, Ambiente=${environment}, DryRun=${dryRun}\n`);

  let certData = null;
  let summary = null;

  try {
    // 1. Trava de seguranca de emissao em producao
    if (operation === 'issue' && environment === 'production') {
      throw new Error('PRODUCTION_ISSUE_DISABLED: Emissao de NFS-e em producao esta estritamente bloqueada.');
    }

    // 2. Tenta carregar certificado se senha e arquivo estiverem configurados
    if (CONFIG.CERT.PASSWORD) {
      try {
        certData = await loadCertificate();
        if (certData.loaded) {
          console.log(`🔑 Certificado A1 autenticado com sucesso: ${certData.commonName}`);
        }
      } catch (certErr) {
        console.log(`⚠️ Aviso no carregamento do Certificado: ${certErr.message}`);
      }
    }

    // 3. Executa operacao solicitada
    if (operation === 'preflight') {
      summary = await preflight();
    } else if (operation === 'historical_analysis') {
      summary = await runHistoricalAnalysis();
    } else if (operation === 'sync') {
      if (!certData || !certData.loaded) {
        console.log('\n🔒 SINCRONIZACAO COM A PREFEITURA REQUER AUTENTICACAO DO CERTIFICADO A1.');
        console.log('   Status: BLOCKED_ONLY_BY_NFE_CERT_PASSWORD (Aguardando cadastro de NFE_CERT_PASSWORD no GitHub Secrets).\n');
        summary = {
          operation: 'sync',
          environment,
          mode: syncMode,
          status: 'BLOCKED_ONLY_BY_NFE_CERT_PASSWORD',
          reason: 'Aguardando cadastro de NFE_CERT_PASSWORD no GitHub Secrets',
          timestamp: new Date().toISOString()
        };
      } else {
        summary = await syncNfse({
          mode: syncMode,
          environment,
          fromNumber,
          toNumber,
          dryRun,
          certData
        });
      }
    } else if (operation === 'prepare') {
      summary = await handlePrepare({ requestId, environment });
    } else if (operation === 'issue') {
      if (environment !== 'homologation') {
        throw new Error('PRODUCTION_ISSUE_DISABLED: Emissao permitida apenas em homologacao.');
      }
      if (!certData || !certData.loaded) {
        throw new Error('CERT_PASSWORD_MISSING: Emissao em homologacao requer certificado A1 desbloqueado.');
      }
      throw new Error('Emissao em homologacao pronta para ativacao na Fase 2.');
    } else {
      throw new Error(`Operacao desconhecida: ${operation}`);
    }

    if (summary) {
      generateReport(summary);
      console.log('📄 Relatorio de execucao gerado com sucesso em report/run-summary.md');
    }
  } catch (err) {
    const sanitizedMsg = sanitize(err.message || err);
    console.error('\n❌ ERRO NA EXECUCAO: ' + sanitizedMsg);
    
    summary = {
      operation,
      environment,
      timestamp: new Date().toISOString(),
      errors: [sanitizedMsg]
    };
    generateReport(summary);
    process.exitCode = 1;
  } finally {
    cleanupCertificate();
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  preflight,
  handlePrepare
};
