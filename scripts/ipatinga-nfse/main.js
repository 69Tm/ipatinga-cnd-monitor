'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG, sanitize } = require('./config');
const { checkSheetsAccess, checkDriveFileAccess, getSpreadsheetMetadata } = require('./google');
const { loadCertificate, formatDateBr } = require('./certificate');
const { inspectWsdl } = require('./wsdl');
const { syncNfse } = require('./sync');
const { handlePrepare } = require('./prepare');
const { issueHomologation, reconcileRps } = require('./issue');
const { runHistoricalAnalysis } = require('./patterns');

function formatTimestamp(d = new Date()) {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

async function preflight(options = {}, dependencies = {}) {
  const startedAt = Date.now();
  const environment = options.environment || CONFIG.ACTIVE_ENV;
  const results = {
    environment,
    googleServiceAccount: false,
    sheetsAccess: false,
    pfxAccessibleOnDrive: false,
    pfxPasswordConfigured: false,
    pfxValidated: false,
    productionWsdlAccessible: false,
    homologationWsdlAccessible: false,
    status: 'UNKNOWN',
    errors: [],
    warnings: [],
    wsdl: {}
  };

  console.log('\n====================================================');
  console.log('       PREFLIGHT CHECK — NFS-E IPATINGA (DEXMED)    ');
  console.log(`       Ambiente: ${environment.toUpperCase()}`);
  console.log('====================================================\n');

  // 1. Google Service Account
  if (CONFIG.AUTH.SERVICE_ACCOUNT_JSON) {
    try {
      JSON.parse(CONFIG.AUTH.SERVICE_ACCOUNT_JSON);
      results.googleServiceAccount = true;
      console.log('✓ Google Service Account JSON: CONFIGURADO');
    } catch (err) {
      results.errors.push('Service Account JSON inválido: ' + err.message);
      console.log('✗ Google Service Account JSON: INVALIDO');
    }
  } else {
    results.errors.push('GOOGLE_SERVICE_ACCOUNT_JSON ausente');
    console.log('✗ Google Service Account JSON: AUSENTE');
  }

  // 2. Google Sheets
  const checkSheets = dependencies.checkSheetsAccess || checkSheetsAccess;
  try {
    results.sheetsAccess = await checkSheets(CONFIG.SHEETS.SPREADSHEET_ID);
    console.log(`✓ Google Sheets (${CONFIG.SHEETS.SPREADSHEET_ID}): ACESSIVEL`);
  } catch (err) {
    results.errors.push('Acesso ao Google Sheets falhou: ' + err.message);
    console.log('✗ Google Sheets: FALHA');
  }

  // 3. Certificado A1 no Google Drive
  const checkDrive = dependencies.checkDriveFileAccess || checkDriveFileAccess;
  try {
    const fileInfo = await checkDrive(CONFIG.CERT.DRIVE_FILE_ID);
    results.pfxAccessibleOnDrive = true;
    console.log(`✓ Certificado PFX no Google Drive (${fileInfo.name || CONFIG.CERT.DRIVE_FILE_ID}): ACESSIVEL`);
  } catch (err) {
    results.errors.push('Acesso ao certificado no Drive falhou: ' + err.message);
    console.log('✗ Certificado PFX no Drive: FALHA');
  }

  // 4. Senha do Certificado
  if (CONFIG.CERT.PASSWORD) {
    results.pfxPasswordConfigured = true;
    console.log('✓ NFE_CERT_PASSWORD: CONFIGURADA');
  } else {
    results.warnings.push('NFE_CERT_PASSWORD não configurada (necessária para sincronização fiscal)');
    console.log('⚠️ NFE_CERT_PASSWORD: NÃO CONFIGURADA (Aviso: apenas preflight funcionará)');
  }

  // 5. Validação Criptográfica do Certificado (se senha configurada)
  if (CONFIG.CERT.PASSWORD && results.pfxAccessibleOnDrive) {
    const loadCert = dependencies.loadCertificate || loadCertificate;
    try {
      const certData = await loadCert();
      results.pfxValidated = certData.isValid;
      console.log(`✓ Certificado A1 validado: ${certData.commonName} (Expira: ${formatDateBr(certData.notAfter)})`);
    } catch (err) {
      results.errors.push('Validação do certificado A1 falhou: ' + err.message);
      console.log('✗ Validação do Certificado: FALHA');
    }
  }

  // 6. Acessibilidade dos WSDLs (Produção e Homologação)
  const inspect = dependencies.inspectWsdl || inspectWsdl;
  try {
    const prodWsdl = await inspect('production');
    results.productionWsdlAccessible = prodWsdl.success;
    results.wsdl.production = prodWsdl;
    console.log(`✓ WSDL Produção (${CONFIG.ENDPOINTS.production.wsdl}): ACESSIVEL`);
  } catch (err) {
    results.errors.push('Acesso ao WSDL de Produção falhou: ' + err.message);
    console.log('✗ WSDL Produção: FALHA');
  }

  try {
    const homWsdl = await inspect('homologation');
    results.homologationWsdlAccessible = homWsdl.success;
    results.wsdl.homologation = homWsdl;
    console.log(`✓ WSDL Homologação (${CONFIG.ENDPOINTS.homologation.wsdl}): ACESSIVEL`);
  } catch (err) {
    results.warnings.push('Acesso ao WSDL de Homologação falhou: ' + err.message);
    console.log('⚠️ WSDL Homologação: FALHA (Aviso)');
  }

  // Status Geral
  const isOk = results.googleServiceAccount && results.sheetsAccess && results.pfxAccessibleOnDrive && results.productionWsdlAccessible;
  results.status = isOk ? (results.errors.length === 0 ? 'SUCCESS' : 'WARNING') : 'FAILED';
  results.durationSec = Number(((Date.now() - startedAt) / 1000).toFixed(2));

  return results;
}

function enforceOperationSafety(operation, environment) {
  // Operação supervisionada permitida; protegida apenas pelo kill switch operacional
  if (operation === 'issue' && (process.env.NFE_ISSUE_KILL_SWITCH === 'true' || process.env.NFE_ISSUE_KILL_SWITCH === true)) {
    throw new Error('NFE_ISSUE_KILL_SWITCH_ACTIVE: Emissão de NFS-e temporariamente bloqueada pelo kill switch.');
  }
}

function buildConsoleSummary(summary) {
  return {
    operation: summary.operation,
    environment: summary.environment,
    status: summary.status,
    timestamp: summary.timestamp,
    durationSec: summary.durationSec,
    highestObserved: summary.highestObserved,
    totalApi: summary.totalApi,
    errors: summary.errors || []
  };
}

function generateReport(summary, outputDirectory = null) {
  const outDir = outputDirectory || path.join(__dirname, 'report');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const reportPath = path.join(outDir, 'run-summary.md');
  const sanitizedSummary = { ...summary };
  if (sanitizedSummary.xmlCandidate) delete sanitizedSummary.xmlCandidate;

  const content = `# Relatório de Execução — Automação NFS-e DEXMED (Ipatinga)

- **Data / Hora:** ${sanitizedSummary.timestamp || new Date().toISOString()}
- **Operação:** \`${sanitizedSummary.operation || 'N/A'}\`
- **Ambiente:** \`${sanitizedSummary.environment || 'N/A'}\`
- **Status Final:** \`${sanitizedSummary.status || 'UNKNOWN'}\`
- **Dry-Run:** \`${sanitizedSummary.dryRun ? 'SIM (sem escritas externas)' : 'NÃO (escrita real)'}\`

## Detalhes da Execução
\`\`\`json
${JSON.stringify(sanitizedSummary, null, 2)}
\`\`\`
`;

  fs.writeFileSync(reportPath, content, 'utf8');
}

async function main() {
  const operation = process.env.INPUT_OPERATION || 'preflight';
  const syncMode = process.env.INPUT_SYNC_MODE || 'incremental';
  const environment = process.env.INPUT_ENVIRONMENT || 'production';
  const fromNumber = process.env.INPUT_FROM_NUMBER || null;
  const toNumber = process.env.INPUT_TO_NUMBER || null;
  const requestId = process.env.INPUT_REQUEST_ID || null;
  const itemIndex = parseInt(process.env.INPUT_ITEM_INDEX || '1', 10);
  const dryRun = process.env.INPUT_DRY_RUN === 'true' || process.env.INPUT_DRY_RUN === true;

  enforceOperationSafety(operation, environment);

  let summary = null;
  let certData = null;

  try {
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

    if (operation === 'preflight') {
      summary = await preflight({ environment });
    } else if (operation === 'historical_analysis') {
      summary = await runHistoricalAnalysis({ dryRun, environment });
    } else if (operation === 'sync') {
      if (!certData || !certData.loaded) {
        throw new Error('CERT_PASSWORD_MISSING: sync bloqueado ate NFE_CERT_PASSWORD ser configurado.');
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
      summary = await handlePrepare({ requestId, environment, dryRun });
    } else if (operation === 'reconcile_rps') {
      if (!certData || !certData.loaded || !certData.isValid) {
        throw new Error('CERT_PASSWORD_MISSING: Reconciliação requer certificado A1 desbloqueado.');
      }
      summary = await reconcileRps({
        environment,
        requestId,
        itemIndex,
        rpsNumero: fromNumber, // suporta passar número direto via from_number se request_id não for usado
        certData
      });
    } else if (operation === 'issue') {
      if (!certData || !certData.loaded || !certData.isValid) {
        throw new Error('CERT_PASSWORD_MISSING: Emissao requer certificado A1 desbloqueado.');
      }
      if (!requestId) {
        throw new Error('REQUEST_ID_REQUIRED: Emissao requer parâmetro request_id.');
      }
      summary = await issueHomologation({
        requestId,
        itemIndex,
        certData,
        dryRun
      });
    } else {
      throw new Error(`Operacao desconhecida: ${operation}`);
    }

    summary.operation = operation;
    summary.environment = environment;
    summary.dryRun = dryRun;
    summary.timestamp = new Date().toISOString();

    generateReport(summary);
    console.log('\n📄 Relatorio de execucao gerado com sucesso em report/run-summary.md');
    console.log(`NFSE_RUN_RESULT=${JSON.stringify(buildConsoleSummary(summary))}`);
  } catch (err) {
    const errorSummary = {
      operation,
      status: 'FAILED',
      environment,
      timestamp: new Date().toISOString(),
      errors: [err.message]
    };
    generateReport(errorSummary);
    console.error(`\n❌ ERRO NA EXECUCAO: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  preflight,
  enforceOperationSafety,
  generateReport,
  buildConsoleSummary,
  main
};
