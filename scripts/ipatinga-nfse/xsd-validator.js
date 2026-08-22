'use strict';

const fs = require('fs');
const path = require('path');
const { validateXML } = require('xmllint-wasm');

const SCHEMAS_DIR = path.join(__dirname, 'schemas', 'abrasf-2.04');
const MAIN_SCHEMA_PATH = path.join(SCHEMAS_DIR, 'schema_2.04.xsd');
const XMLDSIG_SCHEMA_PATH = path.join(SCHEMAS_DIR, 'xmldsig-core-schema.xsd');

let cachedMainSchema = null;
let cachedXmldsigSchema = null;

function loadSchemas() {
  if (!cachedMainSchema) {
    cachedMainSchema = fs.readFileSync(MAIN_SCHEMA_PATH, 'utf8');
  }
  if (!cachedXmldsigSchema) {
    cachedXmldsigSchema = fs.readFileSync(XMLDSIG_SCHEMA_PATH, 'utf8');
  }
  return { main: cachedMainSchema, xmldsig: cachedXmldsigSchema };
}

/**
 * Validação XSD real contra o arquivo schema_2.04.xsd da Prefeitura de Ipatinga
 */
async function validateXmlAgainstOfficialXsd(xmlString, rootElementName = 'GerarNfseEnvio') {
  const schemas = loadSchemas();
  const xmlFilename = `${rootElementName}.xml`;

  try {
    const res = await validateXML({
      xml: [
        {
          fileName: xmlFilename,
          contents: String(xmlString || '').trim()
        }
      ],
      schema: [
        {
          fileName: 'schema_2.04.xsd',
          contents: schemas.main
        }
      ],
      preload: [
        {
          fileName: 'xmldsig-core-schema20020212.xsd',
          contents: schemas.xmldsig
        }
      ]
    });

    return {
      valid: res.valid,
      errors: res.errors.map(e => e.message || e.rawMessage || String(e)),
      rawOutput: res.rawOutput,
      schemaFile: 'schema_2.04.xsd',
      engine: 'xmllint-wasm (libxml2 W3C XML Schema 1.0)'
    };
  } catch (err) {
    return {
      valid: false,
      errors: [err.message],
      rawOutput: err.message,
      schemaFile: 'schema_2.04.xsd',
      engine: 'xmllint-wasm (libxml2 W3C XML Schema 1.0)'
    };
  }
}

module.exports = {
  SCHEMAS_DIR,
  validateXmlAgainstOfficialXsd
};
