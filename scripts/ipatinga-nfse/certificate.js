'use strict';

const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const { CONFIG, sanitize } = require('./config');
const { downloadDriveFile, getDriveFileMetadata } = require('./google');
const { normalizeCnpj } = require('./validators');

let tempCertPath = null;

/**
 * Valida o acesso ao arquivo do certificado A1 no Drive/local sem abrir a chave privada
 */
async function checkCertificateAccess() {
  const fileId = CONFIG.CERT.FILE_ID;
  const localPath = CONFIG.CERT.LOCAL_PATH;

  if (localPath && fs.existsSync(localPath)) {
    const stats = fs.statSync(localPath);
    return {
      accessible: true,
      source: 'local',
      path: localPath,
      name: path.basename(localPath),
      sizeBytes: stats.size
    };
  }

  if (!fileId) {
    throw new Error('Nenhum File ID ou caminho local de certificado configurado.');
  }

  try {
    const meta = await getDriveFileMetadata(fileId);
    if (!meta || !meta.id) {
      throw new Error('CERT_FILE_ACCESS_DENIED: Arquivo nao encontrado ou sem permissao na Service Account.');
    }

    if (meta.name && meta.name.toLowerCase().endsWith('.pdf')) {
      throw new Error(`O arquivo '${meta.name}' no Google Drive e um documento PDF de instalacao, nao o arquivo PFX.`);
    }

    // Testa download temporario
    if (!fs.existsSync(CONFIG.PATHS.TEMP)) {
      fs.mkdirSync(CONFIG.PATHS.TEMP, { recursive: true });
    }
    const testTempPath = path.join(CONFIG.PATHS.TEMP, `test_cert_access_${Date.now()}.pfx`);
    await downloadDriveFile(fileId, testTempPath);

    const stats = fs.statSync(testTempPath);
    if (stats.size === 0) {
      throw new Error('Arquivo de certificado baixado com tamanho 0 bytes.');
    }

    // Remove apos confirmar
    try { fs.unlinkSync(testTempPath); } catch (_) {}

    return {
      accessible: true,
      source: 'drive',
      fileId: meta.id,
      name: meta.name || 'certificado.pfx',
      sizeBytes: stats.size,
      mimeType: meta.mimeType || 'application/x-pkcs12'
    };
  } catch (err) {
    throw new Error(`CERT_FILE_ACCESS_DENIED: Falha ao acessar certificado no Drive (ID ${fileId}): ${sanitize(err.message)}`);
  }
}

/**
 * Carrega e valida o Certificado Digital A1 (PFX / PKCS#12)
 */
async function loadCertificate() {
  const password = CONFIG.CERT.PASSWORD;
  if (!password) {
    return {
      loaded: false,
      status: 'BLOCKED_ONLY_BY_NFE_CERT_PASSWORD',
      reason: 'NFE_CERT_PASSWORD ausente no ambiente'
    };
  }

  let pfxBuffer = null;

  // 1. Caminho local (se informado)
  if (CONFIG.CERT.LOCAL_PATH && fs.existsSync(CONFIG.CERT.LOCAL_PATH)) {
    pfxBuffer = fs.readFileSync(CONFIG.CERT.LOCAL_PATH);
  }
  // 2. Download do Google Drive
  else if (CONFIG.CERT.FILE_ID) {
    if (!fs.existsSync(CONFIG.PATHS.TEMP)) {
      fs.mkdirSync(CONFIG.PATHS.TEMP, { recursive: true });
    }
    tempCertPath = path.join(CONFIG.PATHS.TEMP, `cert_${Date.now()}.pfx`);
    
    await downloadDriveFile(CONFIG.CERT.FILE_ID, tempCertPath);
    pfxBuffer = fs.readFileSync(tempCertPath);
  } else {
    throw new Error('Nenhum certificado A1 configurado (NFE_CERT_DRIVE_FILE_ID ou NFE_CERT_LOCAL_PATH ausentes).');
  }

  // Parse do PKCS#12 via node-forge
  let p12Asn1;
  try {
    const p12Der = pfxBuffer.toString('binary');
    p12Asn1 = forge.asn1.fromDer(p12Der);
  } catch (err) {
    throw new Error('Arquivo PFX corrompido ou formato binario invalido: ' + err.message);
  }

  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);
  } catch (err) {
    throw new Error('Falha ao abrir certificado A1 com a senha fornecida (senha incorreta ou formato invalido).');
  }

  // Extracao do certificado e chave privada
  let certObj = null;
  let keyObj = null;
  const caCerts = [];

  for (const safeContent of p12.safeContents) {
    for (const safeBag of safeContent.safeBags) {
      if (safeBag.type === forge.pki.oids.certBag) {
        const cert = safeBag.cert;
        if (!certObj) {
          certObj = cert;
        } else {
          caCerts.push(cert);
        }
      } else if (safeBag.type === forge.pki.oids.pkcs8ShroudedKeyBag || safeBag.type === forge.pki.oids.keyBag) {
        keyObj = safeBag.key;
      }
    }
  }

  if (!certObj) {
    throw new Error('Nenhum certificado encontrado dentro do arquivo PFX.');
  }
  if (!keyObj) {
    throw new Error('Nenhuma chave privada encontrada dentro do arquivo PFX.');
  }

  const notBefore = certObj.validity.notBefore;
  const notAfter = certObj.validity.notAfter;
  const now = new Date();

  const isExpired = now.getTime() > notAfter.getTime();
  const isNotYetValid = now.getTime() < notBefore.getTime();

  // Informacoes do Titular
  let commonName = '';
  for (const attr of certObj.subject.attributes) {
    if (attr.name === 'commonName' || attr.type === forge.pki.oids.commonName) {
      commonName = attr.value;
      break;
    }
  }

  const pemCert = forge.pki.certificateToPem(certObj);
  const pemKey = forge.pki.privateKeyToPem(keyObj);
  const pemCa = caCerts.map(c => forge.pki.certificateToPem(c)).join('\n');

  return {
    loaded: true,
    commonName,
    notBefore,
    notAfter,
    isExpired,
    isNotYetValid,
    isValid: !isExpired && !isNotYetValid,
    pemCert,
    pemKey,
    pemCa,
    certForge: certObj,
    keyForge: keyObj
  };
}

/**
 * Remove com seguranca o arquivo PFX temporario
 */
function cleanupCertificate() {
  if (tempCertPath && fs.existsSync(tempCertPath)) {
    try {
      fs.unlinkSync(tempCertPath);
    } catch (_) {}
    tempCertPath = null;
  }
}

module.exports = {
  checkCertificateAccess,
  loadCertificate,
  cleanupCertificate
};
