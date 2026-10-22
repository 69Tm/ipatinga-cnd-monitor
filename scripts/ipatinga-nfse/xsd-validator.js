'use strict';

const fs = require('fs');
const path = require('path');
const { validateXML } = require('xmllint-wasm');

const SCHEMAS_DIR = path.join(__dirname, 'schemas', 'abrasf-2.04');
const MAIN_SCHEMA_PATH = path.join(SCHEMAS_DIR, 'schema_2.04.xsd');
const XMLDSIG_SCHEMA_PATH = path.join(SCHEMAS_DIR, 'xmldsig-core-schema.xsd');

const NATIONAL_SCHEMAS_DIR = path.join(__dirname, 'schemas', 'national-v1.01', 'Schemas', '1.01');
const NATIONAL_DPS_SCHEMA_PATH = path.join(NATIONAL_SCHEMAS_DIR, 'DPS_v1.01.xsd');
const NATIONAL_COMPLEXOS_PATH = path.join(NATIONAL_SCHEMAS_DIR, 'tiposComplexos_v1.01.xsd');
const NATIONAL_SIMPLES_PATH = path.join(NATIONAL_SCHEMAS_DIR, 'tiposSimples_v1.01.xsd');
const NATIONAL_XMLDSIG_PATH = path.join(NATIONAL_SCHEMAS_DIR, 'xmldsig-core-schema.xsd');

let cachedMainSchema = null;
let cachedXmldsigSchema = null;

let cachedNationalDpsSchema = null;
let cachedNationalComplexos = null;
let cachedNationalSimples = null;
let cachedNationalXmldsig = null;

function loadSchemas() {
  if (!cachedMainSchema) {
    cachedMainSchema = fs.readFileSync(MAIN_SCHEMA_PATH, 'utf8');
  }
  if (!cachedXmldsigSchema) {
    cachedXmldsigSchema = fs.readFileSync(XMLDSIG_SCHEMA_PATH, 'utf8');
  }
  return { main: cachedMainSchema, xmldsig: cachedXmldsigSchema };
}

function loadNationalSchemas() {
  if (!cachedNationalDpsSchema) {
    cachedNationalDpsSchema = fs.readFileSync(NATIONAL_DPS_SCHEMA_PATH, 'utf8');
  }
  if (!cachedNationalComplexos) {
    cachedNationalComplexos = fs.readFileSync(NATIONAL_COMPLEXOS_PATH, 'utf8');
  }
  if (!cachedNationalSimples) {
    let rawSimples = fs.readFileSync(NATIONAL_SIMPLES_PATH, 'utf8');
    // Normaliza syntax issue do W3C XML Schema pattern em TSSerieDPS (^ e $ literais removidos para conformidade W3C)
    rawSimples = rawSimples.replace('value="^0{0,4}\\d{1,5}$"', 'value="0{0,4}\\d{1,5}"');
    cachedNationalSimples = rawSimples;
  }
  if (!cachedNationalXmldsig) {
    cachedNationalXmldsig = fs.readFileSync(NATIONAL_XMLDSIG_PATH, 'utf8');
  }
  return {
    dps: cachedNationalDpsSchema,
    complexos: cachedNationalComplexos,
    simples: cachedNationalSimples,
    xmldsig: cachedNationalXmldsig
  };
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

/**
 * Validação XSD oficial da DPS Nacional v1.01 (SEFIN/ADN)
 */
async function validateNationalDpsAgainstOfficialXsd(xmlString) {
  const schemas = loadNationalSchemas();

  try {
    const res = await validateXML({
      xml: [
        {
          fileName: 'DPS.xml',
          contents: String(xmlString || '').trim()
        }
      ],
      schema: [
        {
          fileName: 'DPS_v1.01.xsd',
          contents: schemas.dps
        }
      ],
      preload: [
        {
          fileName: 'tiposComplexos_v1.01.xsd',
          contents: schemas.complexos
        },
        {
          fileName: 'tiposSimples_v1.01.xsd',
          contents: schemas.simples
        },
        {
          fileName: 'xmldsig-core-schema.xsd',
          contents: schemas.xmldsig
        }
      ]
    });

    return {
      valid: res.valid,
      errors: res.errors.map(e => e.message || e.rawMessage || String(e)),
      rawOutput: res.rawOutput,
      schemaFile: 'DPS_v1.01.xsd',
      engine: 'xmllint-wasm (libxml2 W3C XML Schema 1.0)'
    };
  } catch (err) {
    return {
      valid: false,
      errors: [err.message],
      rawOutput: err.message,
      schemaFile: 'DPS_v1.01.xsd',
      engine: 'xmllint-wasm (libxml2 W3C XML Schema 1.0)'
    };
  }
}

module.exports = {
  SCHEMAS_DIR,
  NATIONAL_SCHEMAS_DIR,
  validateXmlAgainstOfficialXsd,
  validateNationalDpsAgainstOfficialXsd
};
