'use strict';

const { CONFIG, sanitize } = require('./config');
const { loadCertificate, cleanupCertificate } = require('./certificate');
const { syncNfse } = require('./sync');
const { generateReport } = require('./report');
const { readSheetValues } = require('./google');
const { buildCabecalho, buildConsultarNfseFaixaEnvio } = require('./abrasf');
const { callSoapOperation } = require('./soap');
const { isValidCnpj, formatCurrency, formatDateBr } = require('./validators');

/**
 * Preflight Check: Valida todos os componentes sem realizar emissão ou alteração fiscal
 */
async function preflight() {
  console.log('🔍 Executando Preflight Check — Automação NFS-e DEXMED (Ipatinga)...');
  const results = {
    timestamp: new Date().toISOString(),
    googleServiceAccount: false,
    sheetsAccess: false,
    driveAccess: false,
    certificateConfigured: false,
    certificateValid: false,
    certificateDetails: null,
    productionWsdlAccessible: false,
    homologationWsdlAccessible: false,
    overallOk: false,
    warnings: [],
    errors: []
  };

  // 1. Google Service Account
  try {
    const sa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!sa) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON não configurado');
    const parsedSa = JSON.parse(sa);
    results.googleServiceAccount = true;
    console.log('  ✓ Service Account configurada:', parsedSa.client_email);
  } catch (err) {
    results.errors.push('Service Account: ' + err.message);
    console.log('  ✗ Falha na Service Account:', err.message);
  }

  // 2. Google Sheets
  try {
    const values = await readSheetValues(CONFIG.SHEETS.SPREADSHEET_ID, `${CONFIG.SHEETS.TABS.NOTAS}!A1:D1`);
    results.sheetsAccess = true;
    console.log('  ✓ Acesso ao Google Sheets confirmado (Aba Notas)');
  } catch (err) {
    results.errors.push('Google Sheets: ' + err.message);
    console.log('  ✗ Falha no acesso ao Google Sheets:', err.message);
  }

  // 3. Certificado Digital A1
  try {
    if (CONFIG.CERT.FILE_ID || CONFIG.CERT.LOCAL_PATH) {
      results.certificateConfigured = true;
      if (CONFIG.CERT.PASSWORD) {
        const certData = await loadCertificate();
        results.certificateValid = certData.isValid;
        results.certificateDetails = {
          commonName: certData.commonName,
          notBefore: certData.notBefore,
          notAfter: certData.notAfter,
          isExpired: certData.isExpired
        };
        console.log(`  ✓ Certificado A1 carregado: ${certData.commonName} (Válido até ${formatDateBr(certData.notAfter)})`);
      } else {
        results.warnings.push('NFE_CERT_PASSWORD não configurado.');
        console.log('  ⚠️ NFE_CERT_PASSWORD não configurado.');
      }
    } else {
      results.warnings.push('Certificado A1 não configurado (NFE_CERT_DRIVE_FILE_ID ou LOCAL_PATH ausentes).');
      console.log('  ℹ️ Certificado A1 não configurado nesta execução.');
    }
  } catch (err) {
    results.warnings.push('Certificado A1: ' + err.message);
    console.log('  ⚠️ Aviso Certificado A1:', err.message);
  } finally {
    cleanupCertificate();
  }

  // 4. Conectividade WSDL / SOAP Produção
  try {
    const cabec = buildCabecalho();
    const dados = buildConsultarNfseFaixaEnvio({ from: 1, to: 1, page: 1 });
    const res = await callSoapOperation({
      environment: 'production',
      operation: 'ConsultarNfseFaixa',
      cabecMsg: cabec,
      dadosMsg: dados,
      timeoutMs: 15000
    });
    results.productionWsdlAccessible = true;
    console.log('  ✓ Webservice de Produção Ipatinga acessível (Status HTTP', res.statusCode + ')');
  } catch (err) {
    results.errors.push('Produção WSDL: ' + err.message);
    console.log('  ✗ Webservice Produção:', err.message);
  }

  results.overallOk = results.googleServiceAccount && results.sheetsAccess && results.productionWsdlAccessible;
  console.log(`
Preflight Concluído. Status Geral: ${results.overallOk ? 'OK ✅' : 'PENDÊNCIAS ⚠️'}
`);
  return results;
}

/**
 * Operação Prepare (Fundação Fase 2): Dry-run estrutural a partir de uma demanda
 */
async function handlePrepare({ requestId, environment }) {
  console.log(`📋 Executando Operação PREPARE (Dry-Run Estrutural) para request_id: ${requestId}...`);
  if (!requestId) {
    throw new Error('request_id é obrigatório para a operação prepare.');
  }

  // 1. Carrega dados da aba Demandas
  const rows = await readSheetValues(CONFIG.SHEETS.SPREADSHEET_ID, `${CONFIG.SHEETS.TABS.DEMANDAS}!A:U`);
  if (!rows || rows.length < 2) {
    throw new Error('Nenhuma demanda encontrada na aba Demandas.');
  }

  const headers = rows[0].map(h => String(h || '').trim());
  const reqIdx = headers.indexOf('request_id');
  if (reqIdx === -1) throw new Error('Coluna request_id não encontrada na aba Demandas.');

  const targetRow = rows.slice(1).find(r => String(r[reqIdx] || '').trim() === String(requestId).trim());
  if (!targetRow) {
    throw new Error(`Demanda com request_id '${requestId}' não foi encontrada na planilha.`);
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
 * Função Principal CLI
 */
async function main() {
  const args = process.argv.slice(2);
  const getArg = (name, def = null) => {
    const prefix = `--${name}=`;
    const found = args.find(a => a.startsWith(prefix));
    return found ? found.substring(prefix.length) : def;
  };

  const operation = (process.env.INPUT_OPERATION || getArg('operation') || 'sync').toLowerCase();
  const syncMode = (process.env.INPUT_SYNC_MODE || getArg('sync_mode') || 'incremental').toLowerCase();
  const environment = (process.env.INPUT_ENVIRONMENT || getArg('environment') || 'production').toLowerCase();
  const fromNumber = process.env.INPUT_FROM_NUMBER || getArg('from_number');
  const toNumber = process.env.INPUT_TO_NUMBER || getArg('to_number');
  const requestId = process.env.INPUT_REQUEST_ID || getArg('request_id');
  const dryRun = (process.env.INPUT_DRY_RUN || getArg('dry_run') || 'false').toLowerCase() === 'true';

  console.log('🚀 Iniciando Automação NFS-e DEXMED — Prefeitura de Ipatinga');
  console.log(`⚙️ Configuração: Operação=${operation}, Modo=${syncMode}, Ambiente=${environment}, DryRun=${dryRun}
`);

  let certData = null;
  let summary = null;

  try {
    // Carrega certificado se configurado
    if (CONFIG.CERT.PASSWORD && (CONFIG.CERT.FILE_ID || CONFIG.CERT.LOCAL_PATH)) {
      try {
        certData = await loadCertificate();
        console.log(`🔑 Certificado A1 autenticado: ${certData.commonName}`);
      } catch (certErr) {
        console.log(`⚠️ Aviso no carregamento do Certificado: ${certErr.message}`);
      }
    }

    if (operation === 'sync') {
      summary = await syncNfse({
        mode: syncMode,
        environment,
        fromNumber,
        toNumber,
        dryRun,
        certData
      });
    } else if (operation === 'prepare') {
      summary = await handlePrepare({ requestId, environment });
    } else if (operation === 'issue') {
      if (environment === 'production') {
        throw new Error('EMISSÃO EM PRODUÇÃO ESTÁ ESTRITAMENTE BLOQUEADA NESTA ENTREGA.');
      }
      throw new Error('Emissão em homologação requer ativação explícita da Fase 2.');
    } else if (operation === 'preflight') {
      summary = await preflight();
    } else {
      throw new Error(`Operação desconhecida: ${operation}`);
    }

    if (summary) {
      generateReport(summary);
      console.log('
📄 Relatório de execução gerado com sucesso em report/run-summary.md');
    }
  } catch (err) {
    const sanitizedMsg = sanitize(err.message || err);
    console.error(`
❌ ERRO NA EXECUÇÃO: ${sanitizedMsg}`);
    
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
  preflight
};
