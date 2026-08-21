'use strict';

const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const { CONFIG, sanitize } = require('./config');
const { downloadDriveFile, getDriveFileMetadata } = require('./google');
const { normalizeCnpj } = require('./validators');

let tempCertPath = null;

/**
 * Carrega e valida o Certificado Digital A1 (PFX / PKCS#12)
 */
async function loadCertificate() {
  const password = CONFIG.CERT.PASSWORD;
  if (!password) {
    throw new Error('NFE_CERT_PASSWORD nao configurado. Certificado A1 requer senha.');
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
    
    // Valida se nao e o PDF de instalacao antes de baixar
    try {
      const meta = await getDriveFileMetadata(CONFIG.CERT.FILE_ID);
      if (meta.name && meta.name.toLowerCase().endsWith('.pdf')) {
        throw new Error(`O arquivo '${meta.name}' no Google Drive e um PDF, nao o certificado PFX.`);
      }
    } catch (err) {
      if (err.message.includes('PDF')) throw err;
      // Se nao conseguir metadados, tenta baixar normalmente
    }

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
  loadCertificate,
  cleanupCertificate
};
