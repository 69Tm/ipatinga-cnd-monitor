'use strict';

const path = require('path');

const CONFIG = Object.freeze({
  // Prestador (DEXMED)
  PRESTADOR: {
    CNPJ: '31.302.407/0001-05',
    CNPJ_DIGITS: '31302407000105',
    INSCRICAO_MUNICIPAL: '23297500',
    RAZAO_SOCIAL: 'DEXMED SERVICOS MEDICOS LTDA',
    CODIGO_MUNICIPIO_IPATINGA: '3131307',
    UF: 'MG',
    OPTANTE_SIMPLES_NACIONAL: 1 // 1 = Sim, 2 = Não
  },

  // Endpoints ABRASF 2.04 Ipatinga
  ENDPOINTS: {
    production: {
      wsdl: 'https://abrasfipatinga.meumunicipio.online/ws/nfs?wsdl',
      url: 'https://abrasfipatinga.meumunicipio.online/ws/nfs',
      namespace: 'https://abrasfipatinga.meumunicipio.online/ws/nfs'
    },
    homologation: {
      wsdl: 'https://testeipatinga.meumunicipio.online/abrasf/ws/nfs?wsdl',
      url: 'https://testeipatingaabrasf.meumunicipio.online/ws/nfs',
      namespace: 'https://testeipatingaabrasf.meumunicipio.online/ws/nfs'
    }
  },

  // ABRASF Constants
  ABRASF: {
    VERSAO: '2.04',
    SCHEMA_NAMESPACE: 'http://www.abrasf.org.br/nfse.xsd'
  },

  // Google Sheets & Drive
  SHEETS: {
    SPREADSHEET_ID: process.env.NFE_SPREADSHEET_ID || '1-qnJjv0YuZkrAHnfiyJuyKiU3lR3VzFl76nNQ1DCHWo',
    TABS: {
      NOTAS: 'Notas',
      PADROES: 'Padrões de Emissão',
      TOMADORES: 'Tomadores',
      API: 'API Ipatinga',
      DEMANDAS: 'Demandas',
      DOCUMENTOS: 'Documentos NFS-e'
    }
  },
  DRIVE: {
    FOLDER_ID: process.env.DRIVE_FOLDER_ID || '16Dw9pUbpv_ViCP6a2MAgUbW1h37t3859',
    CERT_FILE_ID: process.env.NFE_CERT_DRIVE_FILE_ID || '14TajJJtjSurR2tuYakbdW4dCHPHkqulb'
  },

  // Secrets & Certificado
  CERT: {
    PASSWORD: process.env.NFE_CERT_PASSWORD || '',
    FILE_ID: process.env.NFE_CERT_DRIVE_FILE_ID || '14TajJJtjSurR2tuYakbdW4dCHPHkqulb',
    LOCAL_PATH: process.env.NFE_CERT_LOCAL_PATH || ''
  },
  SYNC: {
    BATCH_SIZE: Number(process.env.NFE_SYNC_BATCH_SIZE || 50),
    OVERLAP: Number(process.env.NFE_SYNC_OVERLAP || 10),
    INCREMENTAL_FORWARD: Number(process.env.NFE_SYNC_INCREMENTAL_FORWARD || 100),
    EMPTY_RANGES_TO_STOP: Number(process.env.NFE_SYNC_EMPTY_RANGES_TO_STOP || 10)
  },

  // Diretórios
  PATHS: {
    ROOT: path.resolve(__dirname),
    REPORT: path.resolve(__dirname, 'report'),
    OUTPUT: path.resolve(__dirname, 'output'),
    TEMP: path.resolve(__dirname, 'temp')
  }
});

/**
 * Sanitiza mensagens de log, objetos e strings para garantir
 * que nenhuma senha, chave privada ou segredo seja exibido.
 */
function sanitize(input) {
  if (!input) return input;
  let text = typeof input === 'string' ? input : JSON.stringify(input);

  const secretsToRedact = [
    process.env.NFE_CERT_PASSWORD,
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    process.env.GEMINI_KEY,
    process.env.BARK_KEY,
    process.env.SMTP_PASSWORD,
    process.env.GH_TOKEN,
    process.env.GITHUB_TOKEN
  ].filter(s => s && String(s).length > 3);

  secretsToRedact.forEach(sec => {
    try {
      const escaped = String(sec).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(escaped, 'g'), '***REDACTED***');
    } catch (_) {}
  });

  // Redige padroes tipicos de certificados / chaves privadas
  text = text.replace(/-----BEGIN[A-Z\s]+PRIVATE KEY-----[\s\S]*?-----END[A-Z\s]+PRIVATE KEY-----/g, '***REDACTED PRIVATE KEY***');
  text = text.replace(/\"private_key\":\s*\"[^\"]+\"/g, '\"private_key\": \"***REDACTED***\"');
  text = text.replace(/\"client_secret\":\s*\"[^\"]+\"/g, '\"client_secret\": \"***REDACTED***\"');
  text = text.replace(/password=[^&\s\"'>]+/gi, 'password=***REDACTED***');
  text = text.replace(/\"password\":\s*\"[^\"]+\"/gi, '\"password\": \"***REDACTED***\"');

  return typeof input === 'object' && input !== null ? JSON.parse(text) : text;
}

module.exports = {
  CONFIG,
  sanitize
};
