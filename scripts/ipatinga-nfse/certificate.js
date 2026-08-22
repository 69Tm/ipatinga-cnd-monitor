'use strict';

const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const { CONFIG, sanitize } = require('./config');
const { downloadDriveFile, getDriveFileMetadata } = require('./google');
const { normalizeCnpj } = require('./validators');

let tempCertPath = null;
const ICP_BRASIL_CNPJ_OID = '2.16.76.1.3.3';

function publicKeysMatch(certPublicKey, privateKey) {
  if (!certPublicKey || !privateKey) return false;
  if (certPublicKey.n && certPublicKey.e && privateKey.n && privateKey.e) {
    return certPublicKey.n.compareTo(privateKey.n) === 0 && certPublicKey.e.compareTo(privateKey.e) === 0;
  }
  return false;
}

function extractCertificateCnpj(cert) {
  const candidates = [];
  for (const attr of cert.subject.attributes || []) {
    if (attr.type === ICP_BRASIL_CNPJ_OID && attr.value) candidates.push(attr.value);
  }
  const san = (cert.extensions || []).find(ext => ext.name === 'subjectAltName');
  for (const altName of san?.altNames || []) {
    if (altName.oid === ICP_BRASIL_CNPJ_OID && altName.value) candidates.push(altName.value);
  }
  for (const candidate of candidates) {
    const digits = String(candidate).replace(/\D/g, '');
    if (digits.length === 14) return digits;
  }
  return null;
}

function validateExtendedKeyUsage(cert) {
  const eku = (cert.extensions || []).find(ext => ext.name === 'extKeyUsage');
  if (!eku) return { present: false, compatible: true };
  const compatible = Boolean(eku.clientAuth || eku.anyExtendedKeyUsage);
  if (!compatible) throw new Error('CERT_EKU_INCOMPATIBLE: certificado nao permite autenticacao de cliente.');
  return { present: true, compatible };
}

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
  const certificates = [];
  const privateKeys = [];

  for (const safeContent of p12.safeContents) {
    for (const safeBag of safeContent.safeBags) {
      if (safeBag.type === forge.pki.oids.certBag) {
        certificates.push(safeBag.cert);
      } else if (safeBag.type === forge.pki.oids.pkcs8ShroudedKeyBag || safeBag.type === forge.pki.oids.keyBag) {
        privateKeys.push(safeBag.key);
      }
    }
  }

  if (certificates.length === 0) {
    throw new Error('Nenhum certificado encontrado dentro do arquivo PFX.');
  }
  if (privateKeys.length === 0) {
    throw new Error('Nenhuma chave privada encontrada dentro do arquivo PFX.');
  }

  let certObj = null;
  let keyObj = null;
  for (const key of privateKeys) {
    const matchingCert = certificates.find(cert => publicKeysMatch(cert.publicKey, key));
    if (matchingCert) {
      certObj = matchingCert;
      keyObj = key;
      break;
    }
  }
  if (!certObj || !keyObj) throw new Error('CERT_KEY_MISMATCH: certificado e private key nao correspondem.');
  const caCerts = certificates.filter(cert => cert !== certObj);
  const notBefore = certObj.validity.notBefore;
  const notAfter = certObj.validity.notAfter;
  const now = new Date();

  const isExpired = now.getTime() > notAfter.getTime();
  const isNotYetValid = now.getTime() < notBefore.getTime();
  if (isExpired || isNotYetValid) throw new Error('CERTIFICATE_INVALID_DATE: certificado expirado ou ainda nao valido.');

  // Informacoes do Titular
  let commonName = '';
  for (const attr of certObj.subject.attributes) {
    if (attr.name === 'commonName' || attr.type === forge.pki.oids.commonName) {
      commonName = attr.value;
      break;
    }
  }
  const expectedCnpj = normalizeCnpj(CONFIG.PRESTADOR.CNPJ);
  const certificateCnpj = extractCertificateCnpj(certObj);
  if (certificateCnpj && certificateCnpj !== expectedCnpj) {
    throw new Error('CERT_CNPJ_MISMATCH: CNPJ do certificado difere do prestador configurado.');
  }
  if (!certificateCnpj && !String(commonName).toUpperCase().includes('DEXMED')) {
    throw new Error('CERT_SUBJECT_MISMATCH: titular do certificado nao e compativel com DEXMED.');
  }
  const eku = validateExtendedKeyUsage(certObj);
  const warnings = certificateCnpj ? [] : ['CERT_CNPJ_NOT_EXTRACTED'];

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
    isValid: true,
    keyMatchesCertificate: true,
    certificateCnpj,
    eku,
    warnings,
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
  cleanupCertificate,
  publicKeysMatch,
  extractCertificateCnpj,
  validateExtendedKeyUsage
};
