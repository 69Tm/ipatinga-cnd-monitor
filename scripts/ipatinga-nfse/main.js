'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG, sanitize } = require('./config');
const { checkSheetsAccess, checkDriveFileAccess, getSpreadsheetMetadata, readSheetValues } = require('./google');
const { loadCertificate, checkCertificateAccess } = require('./certificate');
const { formatDateBr } = require('./validators');
const { inspectWsdl } = require('./wsdl');
const { syncNfse } = require('./sync');
const { handlePrepare } = require('./prepare');
const { issueNfse, reconcileRps, probeProviderHealth, runAutoRecoveryBatch } = require('./issue');
const { fetchOfficialNfseDocument } = require('./documents');
const { runHistoricalAnalysis } = require('./patterns');
const { loadLedger, RPS_STATUS } = require('./ledger');

function formatTimestamp(d = new Date()) {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

async function checkPendingEntries(dependencies = {}) {
  const read = dependencies.readSheetValues || readSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;
  const tabName = CONFIG.SHEETS.TABS.RPS || 'RPS';

  const rows = await read(spreadsheetId, `${tabName}!A:G`);
  if (!rows || rows.length <= 1) {
    return { pendingCount: 0, pendingEntries: [] };
  }

  const eligibleStatuses = [
    RPS_STATUS.PROVIDER_INFRA_UNAVAILABLE,
    RPS_STATUS.SUBMITTED_ASYNC_PROCESSING,
    RPS_STATUS.UNKNOWN_AFTER_TIMEOUT
  ];

  const pendingEntries = [];
  for (let idx = 1; idx < rows.length; idx++) {
    const row = rows[idx];
    const env = String(row[0] || '').trim().toLowerCase();
    const reqId = String(row[1] || '').trim();
    const itemIdx = String(row[2] || '1').trim();
    const rpsNum = String(row[3] || '').trim();
    const status = String(row[6] || '').trim();

    if (env === 'production' && eligibleStatuses.includes(status)) {
      pendingEntries.push({
        rowIndex: idx + 1,
        requestId: reqId,
        itemIndex: itemIdx,
        rpsNumero: rpsNum,
        status
      });
    }
  }

  return {
    operation: 'pending_check',
    status: 'SUCCESS',
    pendingCount: pendingEntries.length,
    pendingEntries,
    timestamp: new Date().toISOString()
  };
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
    wsdl: {
      production: null,
      homologation: null
    },
    errors: [],
    warnings: []
  };

  console.log('\n====================================================');
  console.log('       PREFLIGHT CHECK — NFS-E IPATINGA (DEXMED)    ');
  console.log(`       Ambiente: ${environment.toUpperCase()}`);
  console.log('====================================================\n');

  // 1. Google Sheets Connection
  try {
    const meta = await (dependencies.getSpreadsheetMetadata || getSpreadsheetMetadata)();
    if (meta && meta.sheets) {
      results.googleServiceAccount = true;
      results.sheetsAccess = true;
      console.log(`  ✓ Planilha Google Sheets acessível: ${meta.sheets.length} abas.`);
    } else {
      results.errors.push('Não foi possível obter metadados da planilha.');
      console.log('  ✗ Erro ao acessar Google Sheets.');
    }
  } catch (err) {
    results.errors.push(`Google Sheets access error: ${err.message}`);
    console.log(`  ✗ Erro ao acessar Google Sheets: ${err.message}`);
  }

  // 2. Acesso ao Certificado PFX
  try {
    const certFileId = CONFIG.CERT.FILE_ID;
    const certAccess = await (dependencies.checkCertificateAccess || checkCertificateAccess)(certFileId);
    if (certAccess.accessible) {
      results.pfxAccessibleOnDrive = true;
      console.log(`  ✓ Certificado PFX encontrado (${certAccess.name}, ${certAccess.sizeBytes} bytes).`);
    } else {
      results.errors.push('Certificado PFX não encontrado no Drive ou caminho local.');
      console.log('  ✗ Erro ao localizar PFX.');
    }
  } catch (err) {
    results.errors.push(`PFX access error: ${err.message}`);
    console.log(`  ✗ Erro ao localizar PFX: ${err.message}`);
  }

  // 3. Validação da Senha e Conteúdo do Certificado
  const certPassword = process.env.NFE_CERT_PASSWORD || CONFIG.CERT.PASSWORD;
  if (!certPassword) {
    results.warnings.push('NFE_CERT_PASSWORD não configurado. Certificado não pôde ser descriptografado.');
    console.log('  ⚠ NFE_CERT_PASSWORD ausente (esperado em rotas de inspeção sem emissão).');
  } else {
    results.pfxPasswordConfigured = true;
    try {
      const certData = await (dependencies.loadCertificate || loadCertificate)({ certPassword });
      if (certData.isValid) {
        results.pfxValidated = true;
        const validTo = certData.notAfter || certData.validTo;
        const cnpj = certData.certificateCnpj || certData.cnpj || CONFIG.PRESTADOR.CNPJ;
        console.log(`  ✓ Certificado A1 válido (CNPJ: ${cnpj}, Validade: ${formatDateBr(validTo)}).`);
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
  const inspector = dependencies.inspectWsdl || inspectWsdl;
  const prodWsdlUrl = CONFIG.ENDPOINTS.production.wsdl;
  const homWsdlUrl = CONFIG.ENDPOINTS.homologation.wsdl;

  const [prodWsdl, homWsdl] = await Promise.all([
    inspector(prodWsdlUrl).catch(err => ({ success: false, error: err.message })),
    inspector(homWsdlUrl).catch(err => ({ success: false, error: err.message }))
  ]);

  results.wsdl.production = prodWsdl;
  results.wsdl.homologation = homWsdl;

  if (prodWsdl.accessible || prodWsdl.success) {
    results.productionWsdlAccessible = true;
    console.log(`  ✓ WSDL Produção acessível (HTTP ${prodWsdl.statusCode || prodWsdl.httpStatus}).`);
  } else {
    results.warnings.push(`WSDL Produção inacessível: ${prodWsdl.error}`);
    console.log(`  ⚠ WSDL Produção inacessível: ${prodWsdl.error}`);
  }

  if (homWsdl.accessible || homWsdl.success) {
    results.homologationWsdlAccessible = true;
    console.log(`  ✓ WSDL Homologação acessível (HTTP ${homWsdl.statusCode || homWsdl.httpStatus}).`);
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

    if (['sync', 'issue', 'reconcile_rps', 'provider_health', 'auto_recovery', 'fetch_document'].includes(operation)) {
      const certPassword = process.env.NFE_CERT_PASSWORD || CONFIG.CERT.PASSWORD;
      if (certPassword) {
        try {
          certData = await loadCertificate({ certPassword });
        } catch (err) {
          console.log(`[WARN] Falha ao carregar certificado: ${err.message}`);
        }
      }
    }

    if (operation === 'pending_check') {
      summary = await checkPendingEntries();
    } else if (operation === 'preflight') {
      summary = await preflight({ environment });
    } else if (operation === 'provider_health') {
      summary = await probeProviderHealth({ certData });
    } else if (operation === 'auto_recovery') {
      summary = await runAutoRecoveryBatch({ certData, dryRun });
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
    } else if (operation === 'fetch_document') {
      if (!certData || !certData.loaded || !certData.isValid) {
        throw new Error('CERT_PASSWORD_MISSING: fetch_document requer certificado A1 desbloqueado.');
      }
      if (!requestId) {
        throw new Error('REQUEST_ID_REQUIRED: fetch_document requer parâmetro request_id.');
      }
      summary = await fetchOfficialNfseDocument({
        requestId,
        itemIndex,
        environment,
        fromNumber,
        certData,
        dryRun
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
    console.error(`\n[FATAL ERROR] Execução abortada: ${err.message}`);
    console.error(err.stack);

    const errorSummary = {
      operation,
      environment,
      status: 'FAILED',
      error: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString()
    };

    generateReport(errorSummary);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  preflight,
  checkPendingEntries,
  enforceOperationSafety,
  generateReport
};
