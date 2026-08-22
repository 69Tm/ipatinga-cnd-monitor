'use strict';

const fs = require('fs');
const path = require('path');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { isValidCnpj } = require('./validators');

const SCHEMAS_DIR = path.join(__dirname, 'schemas', 'abrasf-2.04');

/**
 * Validação semântica e estrutural estrita baseada nos Schemas XSD ABRASF 2.04
 */
function validateXmlAgainstAbrasf204(xmlString, rootElementName = 'GerarNfseEnvio') {
  const errors = [];

  // 1. Validação de XML bem-formado
  const xmlValidation = XMLValidator.validate(xmlString);
  if (xmlValidation !== true) {
    return {
      valid: false,
      errors: [`XML_SYNTAX_ERROR: ${xmlValidation.err.msg}`],
      rootElementName
    };
  }

  // 2. Parser com preservação de nós
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    processEntities: false
  });
  const parsed = parser.parse(xmlString);

  const root = parsed[rootElementName];
  if (!root) {
    errors.push(`ROOT_ELEMENT_MISMATCH: Esperado '${rootElementName}'`);
    return { valid: false, errors, rootElementName };
  }

  if (rootElementName === 'GerarNfseEnvio') {
    const rps = root.Rps;
    if (!rps) {
      errors.push('RPS_WRAPPER_MISSING: Elemento <Rps> é obrigatório em GerarNfseEnvio');
      return { valid: false, errors, rootElementName };
    }

    const dps = rps.InfDeclaracaoPrestacaoServico || rps;
    if (!dps) {
      errors.push('INF_DPS_MISSING: Elemento <InfDeclaracaoPrestacaoServico> é obrigatório');
      return { valid: false, errors, rootElementName };
    }

    // Validação de Atributo Id
    const dpsId = dps['@_Id'] || rps['@_Id'];
    if (!dpsId) {
      errors.push('ID_ATTRIBUTE_MISSING: Atributo Id em InfDeclaracaoPrestacaoServico é obrigatório');
    }

    // RPS Identification
    const rpsIdent = dps.Rps?.IdentificacaoRps;
    if (!rpsIdent || !rpsIdent.Numero || !rpsIdent.Serie || !rpsIdent.Tipo) {
      errors.push('RPS_IDENTIFICATION_INCOMPLETE: Numero, Serie e Tipo são obrigatórios no RPS');
    }

    // Competência
    if (!dps.Competencia || !/^\d{4}-\d{2}-\d{2}$/.test(String(dps.Competencia))) {
      errors.push('COMPETENCIA_INVALID_FORMAT: Competencia deve seguir o padrão YYYY-MM-DD');
    }

    // Serviço e Valores
    const servico = dps.Servico;
    if (!servico) {
      errors.push('SERVICO_ELEMENT_MISSING');
    } else {
      const valores = servico.Valores;
      if (!valores || typeof valores.ValorServicos !== 'number' || valores.ValorServicos <= 0) {
        errors.push('VALOR_SERVICOS_INVALID: ValorServicos deve ser numérico maior que zero');
      }
      if (!servico.ItemListaServico) {
        errors.push('ITEM_LISTA_SERVICO_MISSING');
      }
      if (!servico.CodigoTributacaoMunicipio) {
        errors.push('CODIGO_TRIB_MUNICIPIO_MISSING');
      }
      if (!servico.Discriminacao || String(servico.Discriminacao).trim().length === 0) {
        errors.push('DISCRIMINACAO_MISSING');
      }
      if (!servico.CodigoMunicipio || !/^\d{7}$/.test(String(servico.CodigoMunicipio))) {
        errors.push('CODIGO_MUNICIPIO_IBGE_INVALID: Código de município deve conter 7 dígitos');
      }
    }

    // Prestador
    const prestador = dps.Prestador;
    const prestadorCnpj = prestador?.CpfCnpj?.Cnpj;
    if (!prestadorCnpj || !isValidCnpj(prestadorCnpj)) {
      errors.push('PRESTADOR_CNPJ_INVALID');
    }
    if (!prestador?.InscricaoMunicipal) {
      errors.push('PRESTADOR_IM_MISSING');
    }

    // Tomador
    const tomador = dps.Tomador;
    const tomadorCnpj = tomador?.IdentificacaoTomador?.CpfCnpj?.Cnpj;
    if (!tomadorCnpj || !isValidCnpj(tomadorCnpj)) {
      errors.push('TOMADOR_CNPJ_INVALID');
    }
    if (!tomador?.RazaoSocial) {
      errors.push('TOMADOR_RAZAO_SOCIAL_MISSING');
    }

    // Optante Simples e Incentivo
    if (![1, 2, '1', '2'].includes(dps.OptanteSimplesNacional)) {
      errors.push('OPTANTE_SIMPLES_NACIONAL_INVALID');
    }
    if (![1, 2, '1', '2'].includes(dps.IncentivoFiscal)) {
      errors.push('INCENTIVO_FISCAL_INVALID');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    rootElementName,
    schemaVersion: 'ABRASF 2.04'
  };
}

module.exports = {
  SCHEMAS_DIR,
  validateXmlAgainstAbrasf204
};
