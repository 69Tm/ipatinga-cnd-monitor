'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG, sanitize } = require('./config');
const { checkSheetsAccess, checkDriveFileAccess, getSpreadsheetMetadata } = require('./google');
const { loadCertificate, formatDateBr } = require('./certificate');
const { inspectWsdl } = require('./wsdl');
const { syncNfse } = require('./sync');
const { handlePrepare } = require('./prepare');
const { issueNfse, reconcileRps } = require('./issue');
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

  // 1. Validação do Google Service Account
  try {
    const sheetsMeta = await (dependencies.getSpreadsheetMetadata || getSpreadsheetMetadata)(CONFIG.SHEETS.SPREADSHEET_ID);
    results.googleServiceAccount = true;
    results.sheetsAccess = true;
    console.log(`  ✓ Planilha Google Sheets acessível: ${sheetsMeta.sheets?.length || 0} abas.`);
  } catch (err) {
    results.errors.push(`Google Sheets error: ${err.message}`);
    console.log(`  ✗ Erro ao acessar Google Sheets: ${err.message}`);
  }

  // 2. Validação do Certificado A1 no Google Drive
  try {
    const pfxMeta = await (dependencies.checkDriveFileAccess || checkDriveFileAccess)(CONFIG.CERTIFICATE.DRIVE_FILE_ID);
    results.pfxAccessibleOnDrive = true;
    console.log(`  ✓ Certificado PFX encontrado no Drive (${pfxMeta.name}, ${pfxMeta.size} bytes).`);
  } catch (err) {
    results.errors.push(`Google Drive PFX error: ${err.message}`);
    console.log(`  ✗ Erro ao localizar PFX no Drive: ${err.message}`);
  }

  // 3. Validação da Senha e Conteúdo do Certificado
  const certPassword = process.env.NFE_CERT_PASSWORD;
  if (!certPassword) {
    results.warnings.push('NFE_CERT_PASSWORD não configurado. Certificado não pôde ser descriptografado.');
    console.log('  ⚠ NFE_CERT_PASSWORD ausente (esperado em rotas de inspeção sem emissão).');
  } else {
    results.pfxPasswordConfigured = true;
    try {
      const certData = await (dependencies.loadCertificate || loadCertificate)({ certPassword });
      if (certData.isValid) {
        results.pfxValidated = true;
        console.log(`  ✓ Certificado A1 válido (CNPJ: ${certData.cnpj}, Validade: ${formatDateBr(certData.validTo)}).`);
      } else {
        results.errors.push(`Certificado inválido: ${certData.error}`);
        console.log(`  ✗ Certificado A1 inválido: ${certData.error}`);
      }
    } catch (err) {
      results.errors.push(`Falha ao carregar certificado: ${err.message}`);
      console.log(`  ✗ Falha ao carregar certificado: ${err.message}`);
    }
  }

  // 4. Conectividade WSDL / Endpoints
  console.log('\n  Inspecionando WSDL dos ambientes...');
  const [prodWsdl, homWsdl] = await Promise.all([
    (dependencies.inspectWsdl || inspectWsdl)({ environment: 'production' }).catch(err => ({ success: false, error: err.message })),
    (dependencies.inspectWsdl || inspectWsdl)({ environment: 'homologation' }).catch(err => ({ success: false, error: err.message }))
  ]);

  results.wsdl.production = prodWsdl;
  results.wsdl.homologation = homWsdl;

  if (prodWsdl.success) {
    results.productionWsdlAccessible = true;
    console.log(`  ✓ WSDL Produção acessível (HTTP ${prodWsdl.httpStatus}, ${prodWsdl.operations?.length || 0} operações).`);
  } else {
    results.warnings.push(`WSDL Produção inacessível: ${prodWsdl.error}`);
    console.log(`  ⚠ WSDL Produção inacessível: ${prodWsdl.error}`);
  }

  if (homWsdl.success) {
    results.homologationWsdlAccessible = true;
    console.log(`  ✓ WSDL Homologação acessível (HTTP ${homWsdl.httpStatus}, ${homWsdl.operations?.length || 0} operações).`);
  } else {
    results.warnings.push(`WSDL Homologação inacessível: ${homWsdl.error}`);
    console.log(`  ⚠ WSDL Homologação inacessível: ${homWsdl.error}`);
  }

  // Classificação final do Preflight
  const isHealthy = results.sheetsAccess && results.pfxAccessibleOnDrive && (results.productionWsdlAccessible || results.homologationWsdlAccessible);
  results.status = isHealthy ? (results.warnings.length ? 'HEALTHY_WITH_WARNINGS' : 'SUCCESS') : 'FAILED';
  results.durationSec = Number(((Date.now() - startedAt) / 1000).toFixed(2));

  console.log('\n====================================================');
  console.log(`  STATUS FINAL DO PREFLIGHT: ${results.status}`);
  console.log('====================================================\n');

  return results;
}

function generateReport(summary) {
  const reportDir = path.resolve(__dirname, 'report');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const reportPath = path.join(reportDir, 'run-summary.md');
  const now = new Date().toISOString();
  
  let md = `# Relatório de Execução — Automação NFS-e DEXMED (Ipatinga)\n\n`;
  md += `- **Data / Hora:** ${now}\n`;
  md += `- **Operação:** \`${summary.operation || 'N/A'}\`\n`;
  md += `- **Ambiente:** \`${summary.environment || 'N/A'}\`\n`;
  md += `- **Status Final:** \`${summary.status || (summary.success ? 'SUCCESS' : 'FAILED')}\`\n`;
  md += `- **Dry-Run:** \`${summary.dryRun ? 'SIM (sem escrita)' : 'NÃO (escrita real)'}\`\n\n`;

  md += `## Detalhes da Execução\n`;
  md += `\`\`\`json\n${JSON.stringify(sanitize(summary), null, 2)}\n\`\`\`\n\n`;

  fs.writeFileSync(reportPath, md, 'utf8');
  console.log(`[OK] Relatório gerado em: ${reportPath}`);
}

function enforceOperationSafety(operation, environment) {
  if (operation === 'issue') {
    if (process.env.NFE_ISSUE_KILL_SWITCH === 'true' || process.env.NFE_ISSUE_KILL_SWITCH === true) {
      throw new Error('NFE_ISSUE_KILL_SWITCH_ACTIVE: Emissao bloqueada emergencialmente.');
    }
  }
}

async function main() {
  const operation = process.env.INPUT_OPERATION || 'preflight';
  const environment = process.env.INPUT_ENVIRONMENT || 'homologation';
  const dryRun = process.env.INPUT_DRY_RUN === 'true' || process.env.INPUT_DRY_RUN === true;
  const fromNumber = process.env.INPUT_FROM_NUMBER || '';
  const toNumber = process.env.INPUT_TO_NUMBER || '';
  const syncMode = process.env.INPUT_SYNC_MODE || 'auto';
  const requestId = process.env.INPUT_REQUEST_ID || '';
  const itemIndex = parseInt(process.env.INPUT_ITEM_INDEX || '1', 10);

  console.log(`[INIT] Operação: ${operation} | Ambiente: ${environment} | DryRun: ${dryRun}`);

  try {
    enforceOperationSafety(operation, environment);

    let summary = {};
    let certData = null;

    // Carrega o certificado se a senha estiver disponível
    if (process.env.NFE_CERT_PASSWORD) {
      try {
        certData = await loadCertificate({ certPassword: process.env.NFE_CERT_PASSWORD });
        console.log(`[CERT] Certificado A1 carregado. CNPJ: ${certData.cnpj}`);
      } catch (err) {
        console.log(`[CERT] Falha ao descriptografar certificado: ${err.message}`);
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
        rpsNumero: fromNumber,
        certData
      });
    } else if (operation === 'issue') {
      if (!certData || !certData.loaded || !certData.isValid) {
        throw new Error('CERT_PASSWORD_MISSING: Emissao requer certificado A1 desbloqueado.');
      }
      if (!requestId) {
        throw new Error('REQUEST_ID_REQUIRED: Emissao requer parâmetro request_id.');
      }
      summary = await issueNfse({
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

    if (summary.status === 'FAILED' || summary.success === false) {
      process.exit(1);
    }
  } catch (err) {
    console.error(`[FATAL ERROR] ${err.message}`);
    generateReport({
      operation,
      environment,
      status: 'FAILED',
      error: err.message,
      stack: err.stack
    });
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  preflight,
  generateReport,
  enforceOperationSafety
};
