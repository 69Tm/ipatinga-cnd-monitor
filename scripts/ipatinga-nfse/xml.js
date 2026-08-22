'use strict';

const { XMLParser, XMLBuilder, XMLValidator } = require('fast-xml-parser');
const crypto = require('crypto');

const defaultParserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  cdataPropName: '__cdata'
};

const xmlParser = new XMLParser(defaultParserOptions);
const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  indentBy: '  ',
  suppressEmptyNode: true
});

function parseXml(xmlString) {
  if (!xmlString || typeof xmlString !== 'string') throw new Error('XML_EMPTY');
  // Se contiver entidades HTML não decodificadas
  let clean = xmlString.trim();
  if (clean.includes('&lt;') && !clean.startsWith('<')) {
    clean = clean
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }
  const validation = XMLValidator.validate(clean);
  if (validation !== true) throw new Error('XML_INVALID: ' + validation.err.msg);
  return xmlParser.parse(clean);
}

function buildXml(jsObj) {
  return xmlBuilder.build(jsObj);
}

/**
 * Helper para buscar valores em nós XML que podem ou não conter prefixos de namespace (ex: tns:, tc:)
 */
function getXmlValue(node, tagNames) {
  if (!node || typeof node !== 'object') return null;
  const tags = Array.isArray(tagNames) ? tagNames : [tagNames];
  for (const tag of tags) {
    for (const key of Object.keys(node)) {
      const cleanKey = key.includes(':') ? key.split(':')[1] : key;
      if (cleanKey.toLowerCase() === tag.toLowerCase()) {
        const val = node[key];
        if (val === null || val === undefined) return null;
        if (typeof val === 'object') {
          if (val['#text'] !== undefined) return String(val['#text']).trim();
          if (val['__cdata'] !== undefined) return String(val['__cdata']).trim();
        }
        return String(val).trim();
      }
    }
  }
  return null;
}

function getXmlNode(node, tagNames) {
  if (!node || typeof node !== 'object') return null;
  const tags = Array.isArray(tagNames) ? tagNames : [tagNames];
  for (const tag of tags) {
    for (const key of Object.keys(node)) {
      const cleanKey = key.includes(':') ? key.split(':')[1] : key;
      if (cleanKey.toLowerCase() === tag.toLowerCase()) {
        return node[key];
      }
    }
  }
  return null;
}

/**
 * Garante que uma lista XML (que pode vir como objeto único se houver só 1 item) seja sempre um array
 */
function ensureArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

function findXmlNode(node, tagName) {
  if (!node || typeof node !== 'object') return null;
  const expected = String(tagName).toLowerCase();
  for (const [key, value] of Object.entries(node)) {
    const cleanKey = key.includes(':') ? key.split(':').pop() : key;
    if (cleanKey.toLowerCase() === expected) return value;
    if (value && typeof value === 'object') {
      const nested = findXmlNode(value, tagName);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function findXmlValue(node, tagName) {
  const found = findXmlNode(node, tagName);
  if (found === null || found === undefined) return null;
  if (typeof found === 'object') {
    if (found['#text'] !== undefined) return String(found['#text']).trim();
    if (found.__cdata !== undefined) return String(found.__cdata).trim();
  }
  return typeof found === 'string' || typeof found === 'number' ? String(found).trim() : null;
}

module.exports = {
  parseXml,
  buildXml,
  getXmlValue,
  getXmlNode,
  ensureArray,
  findXmlNode,
  findXmlValue
};
