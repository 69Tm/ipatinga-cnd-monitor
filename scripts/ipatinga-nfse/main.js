'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG, sanitize } = require('./config');
const { checkSheetsAccess, checkDriveFileAccess, getSpreadsheetMetadata } = require('./google');
const { loadCertificate, formatDateBr } = require('./certificate');
const { inspectWsdl } = require('./wsdl');
const { syncNfse } = require('./sync');
const { handlePrepare } = require('./prepare');
const { issueHomologation } = require('./issue');
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
    results.sheetsAccess = false;
    results.errors.push('Sheets: ' + sanitize(err.message));
    console.log(`✗ Google Sheets: FALHA (${sanitize(err.message)})`);
  }

  // 3. PFX no Google Drive
  const checkDrive = dependencies.checkDriveFileAccess || checkDriveFileAccess;
  try {
    const driveInfo = await checkDrive(CONFIG.CERT.DRIVE_FILE_ID);
    results.pfxAccessibleOnDrive = driveInfo.accessible;
    console.log(`✓ PFX no Google Drive (${CONFIG.CERT.DRIVE_FILE_ID}): ENCONTRADO (${driveInfo.name}, ${driveInfo.sizeBytes} bytes)`);
  } catch (err) {
    results.pfxAccessibleOnDrive = false;
    results.errors.push('Drive PFX: ' + sanitize(err.message));
    console.log(`✗ PFX no Google Drive: FALHA (${sanitize(err.message)})`);
  }

  // 4. Validação PFX
  const loadCert = dependencies.loadCertificate || loadCertificate;
  if (CONFIG.CERT.PASSWORD) {
    results.pfxPasswordConfigured = true;
    try {
      const certData = await loadCert();
      results.pfxValidated = certData.isValid;
      if (certData.isValid) {
        results.certificateCnpj = certData.certificateCnpj ? 'OK' : 'CERT_CNPJ_NOT_EXTRACTED';
        results.warnings.push(...(certData.warnings || []));
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

  // 5. WSDL real
  const inspect = dependencies.inspectWsdl || inspectWsdl;
  for (const envName of ['production', 'homologation']) {
    try {
      const inspected = await inspect(CONFIG.ENDPOINTS[envName].wsdl);
      results.wsdl[envName] = inspected;
      results[`${envName}WsdlAccessible`] = true;
      console.log(`✓ WSDL ${envName}: OK HTTP ${inspected.statusCode}, ${inspected.latencyMs}ms, ${inspected.contract.operation}`);
    } catch (err) {
      results.wsdl[envName] = { accessible: false, error: sanitize(err.message) };
      results.errors.push(`WSDL ${envName}: ${sanitize(err.message)}`);
      console.log(`✗ WSDL ${envName}: FALHA (${sanitize(err.message)})`);
    }
  }

  // 6. Status Geral
  if (results.googleServiceAccount && results.sheetsAccess && results.pfxAccessibleOnDrive &&
      results.productionWsdlAccessible && results.homologationWsdlAccessible) {
    if (results.pfxValidated) {
      results.status = 'READY_ALL_OK';
    } else if (!results.pfxPasswordConfigured) {
      results.status = 'READY_EXCEPT_CERT_PASSWORD';
    } else {
      results.status = 'FAILED';
    }
  } else {
    results.status = 'FAILED';
  }

  console.log('\n====================================================');
  console.log(`  STATUS FINAL DO PREFLIGHT: ${results.status}`);
  console.log('====================================================\n');

  results.durationSec = Number(((Date.now() - startedAt) / 1000).toFixed(2));
  return results;
}

function enforceOperationSafety(operation, environment) {
  if (operation === 'issue' && environment === 'production') {
    throw new Error('PRODUCTION_ISSUE_DISABLED: Emissao de NFS-e em producao esta estritamente bloqueada.');
  }
}

function generateReport(summary, outDir = path.join(__dirname, 'report')) {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const reportPath = path.join(outDir, 'run-summary.md');
  const sanitizedSummary = { ...summary };
  // Previne expor XML bruto integral no relatório
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
  return reportPath;
}

function buildConsoleSummary(summary) {
  return {
    operation: summary.operation,
    environment: summary.environment,
    status: summary.status,
    timestamp: summary.timestamp || new Date().toISOString()
  };
}

async function main() {
  const operation = process.env.INPUT_OPERATION || 'preflight';
  const syncMode = process.env.INPUT_SYNC_MODE || 'incremental';
  const environment = process.env.INPUT_ENVIRONMENT || CONFIG.ACTIVE_ENV;
  const fromNumber = process.env.INPUT_FROM_NUMBER || '';
  const toNumber = process.env.INPUT_TO_NUMBER || '';
  const requestId = process.env.INPUT_REQUEST_ID || '';
  const itemIndexRaw = parseInt(process.env.INPUT_ITEM_INDEX || '1', 10);
  const itemIndex = isNaN(itemIndexRaw) || itemIndexRaw < 1 ? 1 : itemIndexRaw;
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
    } else if (operation === 'issue') {
      if (environment !== 'homologation') {
        throw new Error('PRODUCTION_ISSUE_DISABLED: Emissao permitida apenas em homologacao.');
      }
      if (!certData || !certData.loaded || !certData.isValid) {
        throw new Error('CERT_PASSWORD_MISSING: Emissao em homologacao requer certificado A1 desbloqueado.');
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

    if (summary) {
      generateReport(summary);
      console.log('📄 Relatorio de execucao gerado com sucesso em report/run-summary.md');
      console.log(`NFSE_RUN_RESULT=${JSON.stringify(buildConsoleSummary(summary))}`);
      if (summary.status === 'FAILED') process.exitCode = 1;
    }
  } catch (err) {
    const sanitizedMsg = sanitize(err.message || err);
    console.error('\n❌ ERRO NA EXECUCAO: ' + sanitizedMsg);
    
    summary = err.syncSummary || {
      operation,
      status: err.code === 'PARTIAL_SYNC_FAILED' ? 'PARTIAL_SYNC_FAILED' : 'FAILED',
      environment,
      timestamp: new Date().toISOString(),
      errors: [sanitizedMsg]
    };
    generateReport(summary);
    process.exitCode = 1;
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
