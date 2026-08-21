'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG, sanitize } = require('./config');

function generateReport(summaryData) {
  if (!fs.existsSync(CONFIG.PATHS.REPORT)) {
    fs.mkdirSync(CONFIG.PATHS.REPORT, { recursive: true });
  }

  const jsonPath = path.join(CONFIG.PATHS.REPORT, 'run-summary.json');
  const mdPath = path.join(CONFIG.PATHS.REPORT, 'run-summary.md');

  const sanitizedData = sanitize(summaryData);

  // 1. Salva JSON
  fs.writeFileSync(jsonPath, JSON.stringify(sanitizedData, null, 2), 'utf8');

  // 2. Monta Markdown
  const mdLines = [];
  mdLines.push('# 📋 Relatório de Execução — NFS-e DEXMED (Ipatinga ABRASF 2.04)');
  mdLines.push('');
  mdLines.push(`- **Operação:** \`${sanitizedData.operation}\``);
  mdLines.push(`- **Ambiente:** \`${sanitizedData.environment}\``);
  mdLines.push(`- **Modo:** \`${sanitizedData.mode || 'N/A'}\``);
  mdLines.push(`- **Dry Run:** \`${sanitizedData.dryRun ? 'Sim' : 'Não'}\``);
  mdLines.push(`- **Data/Hora:** \`${sanitizedData.timestamp}\``);
  mdLines.push(`- **Duração:** \`${sanitizedData.durationSec || 0}s\``);
  mdLines.push('');

  if (sanitizedData.operation === 'sync') {
    mdLines.push('## 📊 Resumo da Sincronização');
    mdLines.push('');
    mdLines.push(`- **Total Retornado pela API:** ${sanitizedData.totalRetornadoApi || 0}`);
    mdLines.push(`- **Primeira NFS-e Encontrada:** ${sanitizedData.primeiraNfEncontrada || 'N/A'}`);
    mdLines.push(`- **Última NFS-e Encontrada:** ${sanitizedData.ultimaNfEncontrada || 'N/A'}`);
    mdLines.push('');

    const upsert = sanitizedData.upsertResult || {};
    mdLines.push('### 🔄 Impacto na Planilha (Aba Notas)');
    mdLines.push(`- **Novas Notas Inseridas:** ${upsert.totalNew || 0}`);
    mdLines.push(`- **Notas Existentes Atualizadas:** ${upsert.totalUpdated || 0}`);
    mdLines.push(`- **Notas Canceladas Detectadas:** ${upsert.totalCanceled || 0}`);
    mdLines.push('');

    if (sanitizedData.regressionCheck) {
      mdLines.push('### 🩺 Verificação de Regressão (Notas Conhecidas)');
      mdLines.push('| NFS-e | Status API | Tomador | Valor |');
      mdLines.push('| :--- | :--- | :--- | :--- |');
      for (const [key, val] of Object.entries(sanitizedData.regressionCheck)) {
        if (typeof val === 'object' && val !== null) {
          mdLines.push(`| **${val.numero}** | ${val.status || 'NORMAL'} | ${val.tomador || 'N/A'} | R$ ${val.valorServicos || 0} |`);
        } else {
          mdLines.push(`| **${key}** | ${val} | - | - |`);
        }
      }
      mdLines.push('');
    }
  } else if (sanitizedData.operation === 'prepare') {
    mdLines.push('## 📝 Resultado da Preparação Fiscal (Dry-Run)');
    mdLines.push(`- **Request ID:** \`${sanitizedData.requestId}\``);
    mdLines.push(`- **Status Validação:** \`${sanitizedData.validationStatus}\``);
    mdLines.push(`- **Tomador:** ${sanitizedData.tomador || 'N/A'}`);
    mdLines.push(`- **Valor:** R$ ${sanitizedData.valor || 0}`);
    mdLines.push(`- **Competência:** ${sanitizedData.competencia || 'N/A'}`);
    mdLines.push('');
  }

  if (sanitizedData.errors && sanitizedData.errors.length > 0) {
    mdLines.push('## ⚠️ Erros / Advertências');
    sanitizedData.errors.forEach(err => {
      mdLines.push(`- ${typeof err === 'object' ? JSON.stringify(err) : err}`);
    });
    mdLines.push('');
  }

  const mdContent = mdLines.join('
');
  fs.writeFileSync(mdPath, mdContent, 'utf8');

  // Se estiver no GitHub Actions, anexa ao Step Summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, mdContent + '
', 'utf8');
    } catch (_) {}
  }

  return {
    jsonPath,
    mdPath
  };
}

module.exports = {
  generateReport
};
