'use strict';

const { CONFIG } = require('./config');
const { parseXml, getXmlNode, getXmlValue, findXmlNode, findXmlValue, ensureArray } = require('./xml');
const {
  formatCnpj,
  parseCurrency,
  parseAliquot,
  formatDateBr,
  parseCompetencia,
  onlyDigits
} = require('./validators');

/**
 * Constrói o cabeçalho SOAP padrão ABRASF 2.04
 */
function buildCabecalho(versao = '2.04') {
  return `<cabecalho xmlns="${CONFIG.ABRASF.SCHEMA_NAMESPACE}" versao="${versao}">` +
    `<versaoDados>${versao}</versaoDados>` +
  `</cabecalho>`;
}

/**
 * Constrói a mensagem XML para a operação ConsultarNfseFaixaEnvio
 */
function buildConsultarNfseFaixaEnvio({
  from = 1,
  to = 50,
  page = 1,
  numeroInicial = null,
  numeroFinal = null,
  pagina = null,
  cnpj = null,
  im = null
}) {
  const finalFrom = numeroInicial !== null && numeroInicial !== undefined ? numeroInicial : from;
  const finalTo = numeroFinal !== null && numeroFinal !== undefined ? numeroFinal : to;
  const finalPage = pagina !== null && pagina !== undefined ? pagina : page;
  const cnpjClean = cnpj || CONFIG.PRESTADOR.CNPJ_DIGITS;
  const imClean = im || CONFIG.PRESTADOR.INSCRICAO_MUNICIPAL;

  return `<ConsultarNfseFaixaEnvio xmlns="${CONFIG.ABRASF.SCHEMA_NAMESPACE}">` +
    `<Prestador>` +
      `<CpfCnpj><Cnpj>${cnpjClean}</Cnpj></CpfCnpj>` +
      `<InscricaoMunicipal>${imClean}</InscricaoMunicipal>` +
    `</Prestador>` +
    `<Faixa>` +
      `<NumeroNfseInicial>${finalFrom}</NumeroNfseInicial>` +
      `<NumeroNfseFinal>${finalTo}</NumeroNfseFinal>` +
    `</Faixa>` +
    `<Pagina>${finalPage}</Pagina>` +
  `</ConsultarNfseFaixaEnvio>`;
}

/**
 * Extrai dados padronizados de um nó InfNfse
 */
function extractNfseData(compNfseNode) {
  const infNfse = getXmlNode(compNfseNode, ['InfNfse', 'tc:InfNfse']) ||
                  getXmlNode(compNfseNode, ['Nfse', 'tc:Nfse']) ||
                  compNfseNode;

  const cancelamentoNode = getXmlNode(compNfseNode, ['NfseCancelamento', 'tc:NfseCancelamento', 'Cancelamento', 'tc:Cancelamento']);
  const substituicaoNode = getXmlNode(compNfseNode, ['NfseSubstituicao', 'tc:NfseSubstituicao', 'Substituicao', 'tc:Substituicao']);

  const numero = getXmlValue(infNfse, ['Numero', 'tc:Numero']) || findXmlValue(infNfse, 'Numero');
  const codigoVerificacao = getXmlValue(infNfse, ['CodigoVerificacao', 'tc:CodigoVerificacao']) || findXmlValue(infNfse, 'CodigoVerificacao');
  const dataEmissaoRaw = getXmlValue(infNfse, ['DataEmissao', 'tc:DataEmissao']) || findXmlValue(infNfse, 'DataEmissao');
  const outrasInformacoes = getXmlValue(infNfse, ['OutrasInformacoes', 'tc:OutrasInformacoes']);

  // DPS / Declaracao Prestacao Servico
  const dpsNode = getXmlNode(infNfse, [
    'DeclaracaoPrestacaoServico', 'tc:DeclaracaoPrestacaoServico',
    'InfDeclaracaoPrestacaoServico', 'tc:InfDeclaracaoPrestacaoServico',
    'Rps', 'tc:Rps'
  ]) || findXmlNode(infNfse, 'InfDeclaracaoPrestacaoServico');
  const infDps = dpsNode ? (getXmlNode(dpsNode, ['InfDeclaracaoPrestacaoServico', 'tc:InfDeclaracaoPrestacaoServico']) || dpsNode) : null;

  const competenciaRaw = (infDps && (getXmlValue(infDps, ['Competencia', 'tc:Competencia']) || findXmlValue(infDps, 'Competencia'))) ||
                         getXmlValue(infNfse, ['Competencia', 'tc:Competencia']) ||
                         findXmlValue(infNfse, 'Competencia');
  const chaveAcesso = (infDps && (getXmlValue(infDps, ['ChaveAcesso', 'tc:ChaveAcesso']) || findXmlValue(infDps, 'ChaveAcesso'))) ||
                      getXmlValue(infNfse, ['ChaveAcesso', 'tc:ChaveAcesso']) ||
                      findXmlValue(infNfse, 'ChaveAcesso');

  // Serviço & Valores
  const servicoNode = (infDps && (getXmlNode(infDps, ['Servico', 'tc:Servico']) || findXmlNode(infDps, 'Servico'))) ||
                      getXmlNode(infNfse, ['Servico', 'tc:Servico']) ||
                      findXmlNode(infNfse, 'Servico');
  const valoresServicoNode = servicoNode ? (getXmlNode(servicoNode, ['Valores', 'tc:Valores']) || findXmlNode(servicoNode, 'Valores')) : null;
  const valoresNfseNode = getXmlNode(infNfse, ['ValoresNfse', 'tc:ValoresNfse']) || findXmlNode(infNfse, 'ValoresNfse');

  const discriminacao = servicoNode ? (getXmlValue(servicoNode, ['Discriminacao', 'tc:Discriminacao']) || findXmlValue(servicoNode, 'Discriminacao')) : '';
  const itemListaServico = servicoNode ? (getXmlValue(servicoNode, ['ItemListaServico', 'tc:ItemListaServico']) || findXmlValue(servicoNode, 'ItemListaServico')) : '';
  const codigoCnae = servicoNode ? (getXmlValue(servicoNode, ['CodigoCnae', 'tc:CodigoCnae']) || findXmlValue(servicoNode, 'CodigoCnae')) : '';
  const codigoTribMunicipal = servicoNode ? (getXmlValue(servicoNode, ['CodigoTributacaoMunicipio', 'tc:CodigoTributacaoMunicipio']) || findXmlValue(servicoNode, 'CodigoTributacaoMunicipio')) : '';
  const codigoMunicipioPrestacao = servicoNode ? (getXmlValue(servicoNode, ['CodigoMunicipio', 'tc:CodigoMunicipio']) || findXmlValue(servicoNode, 'CodigoMunicipio')) : '';
  const municipioIncidencia = servicoNode ? (getXmlValue(servicoNode, ['MunicipioIncidencia', 'tc:MunicipioIncidencia']) || findXmlValue(servicoNode, 'MunicipioIncidencia')) : '';
  const issRetido = servicoNode ? (getXmlValue(servicoNode, ['IssRetido', 'tc:IssRetido']) || findXmlValue(servicoNode, 'IssRetido')) : '';

  const valorServicos = (valoresServicoNode && (getXmlValue(valoresServicoNode, ['ValorServicos', 'tc:ValorServicos']) || findXmlValue(valoresServicoNode, 'ValorServicos'))) ||
                        (valoresNfseNode && (getXmlValue(valoresNfseNode, ['ValorServicos', 'tc:ValorServicos']) || findXmlValue(valoresNfseNode, 'ValorServicos'))) || '0';
  const valorDeducoes = (valoresServicoNode && (getXmlValue(valoresServicoNode, ['ValorDeducoes', 'tc:ValorDeducoes']) || findXmlValue(valoresServicoNode, 'ValorDeducoes'))) ||
                        (valoresNfseNode && (getXmlValue(valoresNfseNode, ['ValorDeducoes', 'tc:ValorDeducoes']) || findXmlValue(valoresNfseNode, 'ValorDeducoes'))) || '0';
  const valorPis = (valoresServicoNode && (getXmlValue(valoresServicoNode, ['ValorPis', 'tc:ValorPis']) || findXmlValue(valoresServicoNode, 'ValorPis'))) ||
                   (valoresNfseNode && (getXmlValue(valoresNfseNode, ['ValorPis', 'tc:ValorPis']) || findXmlValue(valoresNfseNode, 'ValorPis'))) || '0';
  const valorCofins = (valoresServicoNode && (getXmlValue(valoresServicoNode, ['ValorCofins', 'tc:ValorCofins']) || findXmlValue(valoresServicoNode, 'ValorCofins'))) ||
                      (valoresNfseNode && (getXmlValue(valoresNfseNode, ['ValorCofins', 'tc:ValorCofins']) || findXmlValue(valoresNfseNode, 'ValorCofins'))) || '0';
  const valorInss = (valoresServicoNode && (getXmlValue(valoresServicoNode, ['ValorInss', 'tc:ValorInss']) || findXmlValue(valoresServicoNode, 'ValorInss'))) ||
                    (valoresNfseNode && (getXmlValue(valoresNfseNode, ['ValorInss', 'tc:ValorInss']) || findXmlValue(valoresNfseNode, 'ValorInss'))) || '0';
  const valorIr = (valoresServicoNode && (getXmlValue(valoresServicoNode, ['ValorIr', 'tc:ValorIr']) || findXmlValue(valoresServicoNode, 'ValorIr'))) ||
                  (valoresNfseNode && (getXmlValue(valoresNfseNode, ['ValorIr', 'tc:ValorIr']) || findXmlValue(valoresNfseNode, 'ValorIr'))) || '0';
  const valorCsll = (valoresServicoNode && (getXmlValue(valoresServicoNode, ['ValorCsll', 'tc:ValorCsll']) || findXmlValue(valoresServicoNode, 'ValorCsll'))) ||
                    (valoresNfseNode && (getXmlValue(valoresNfseNode, ['ValorCsll', 'tc:ValorCsll']) || findXmlValue(valoresNfseNode, 'ValorCsll'))) || '0';
  const outrasRetencoes = (valoresServicoNode && (getXmlValue(valoresServicoNode, ['OutrasRetencoes', 'tc:OutrasRetencoes']) || findXmlValue(valoresServicoNode, 'OutrasRetencoes'))) ||
                          (valoresNfseNode && (getXmlValue(valoresNfseNode, ['OutrasRetencoes', 'tc:OutrasRetencoes']) || findXmlValue(valoresNfseNode, 'OutrasRetencoes'))) || '0';
  const valTotTributos = (valoresServicoNode && (getXmlValue(valoresServicoNode, ['ValTotTributos', 'tc:ValTotTributos']) || findXmlValue(valoresServicoNode, 'ValTotTributos'))) ||
                         (valoresNfseNode && (getXmlValue(valoresNfseNode, ['ValTotTributos', 'tc:ValTotTributos']) || findXmlValue(valoresNfseNode, 'ValTotTributos'))) || '0';
  const valorIss = (valoresServicoNode && (getXmlValue(valoresServicoNode, ['ValorIss', 'tc:ValorIss']) || findXmlValue(valoresServicoNode, 'ValorIss'))) ||
                   (valoresNfseNode && (getXmlValue(valoresNfseNode, ['ValorIss', 'tc:ValorIss']) || findXmlValue(valoresNfseNode, 'ValorIss'))) || '0';
  const aliquota = (valoresServicoNode && (getXmlValue(valoresServicoNode, ['Aliquota', 'tc:Aliquota']) || findXmlValue(valoresServicoNode, 'Aliquota'))) ||
                   (valoresNfseNode && (getXmlValue(valoresNfseNode, ['Aliquota', 'tc:Aliquota']) || findXmlValue(valoresNfseNode, 'Aliquota'))) || '0';

  // Tomador
  const tomadorNode = (infDps && (getXmlNode(infDps, ['Tomador', 'tc:Tomador', 'TomadorServico', 'tc:TomadorServico']) || findXmlNode(infDps, 'TomadorServico') || findXmlNode(infDps, 'Tomador'))) ||
                      getXmlNode(infNfse, ['TomadorServico', 'tc:TomadorServico', 'Tomador', 'tc:Tomador']) ||
                      findXmlNode(infNfse, 'TomadorServico') ||
                      findXmlNode(infNfse, 'Tomador');
  const tomadorIdent = tomadorNode ? (getXmlNode(tomadorNode, ['IdentificacaoTomador', 'tc:IdentificacaoTomador']) || findXmlNode(tomadorNode, 'IdentificacaoTomador')) : null;
  const tomadorCpfCnpj = tomadorIdent ? (getXmlNode(tomadorIdent, ['CpfCnpj', 'tc:CpfCnpj']) || findXmlNode(tomadorIdent, 'CpfCnpj')) : null;

  const cnpjTomadorRaw = (tomadorCpfCnpj && (getXmlValue(tomadorCpfCnpj, ['Cnpj', 'tc:Cnpj']) || getXmlValue(tomadorCpfCnpj, ['Cpf', 'tc:Cpf']) || findXmlValue(tomadorCpfCnpj, 'Cnpj') || findXmlValue(tomadorCpfCnpj, 'Cpf'))) || '';
  const razaoSocialTomador = tomadorNode ? (getXmlValue(tomadorNode, ['RazaoSocial', 'tc:RazaoSocial']) || findXmlValue(tomadorNode, 'RazaoSocial')) : '';

  // Local da prestação descritivo
  let localPrestacaoDesc = '';
  if (codigoMunicipioPrestacao === '3128006') localPrestacaoDesc = 'Guanhães/MG';
  else if (codigoMunicipioPrestacao === '3131703') localPrestacaoDesc = 'Itabira/MG';
  else if (codigoMunicipioPrestacao === '3131307') localPrestacaoDesc = 'Ipatinga/MG';
  else if (codigoMunicipioPrestacao) localPrestacaoDesc = `IBGE ${codigoMunicipioPrestacao}`;

  // NBS
  let nbs = '';
  if (servicoNode) {
    nbs = getXmlValue(servicoNode, ['cNBS', 'tc:cNBS', 'NBS', 'tc:NBS']) || findXmlValue(servicoNode, 'cNBS') || findXmlValue(servicoNode, 'NBS') || '';
  }

  // Situação da NFS-e
  let status = 'NORMAL';
  let situacaoDetalhe = 'Normal';
  let dataCancelamento = null;

  if (cancelamentoNode) {
    status = 'CANCELADA';
    situacaoDetalhe = 'Cancelada';
    const confCanc = getXmlNode(cancelamentoNode, ['Confirmacao', 'tc:Confirmacao']);
    const infCanc = confCanc ? getXmlNode(confCanc, ['InfConfirmacaoCancelamento', 'tc:InfConfirmacaoCancelamento']) : null;
    dataCancelamento = infCanc ? getXmlValue(infCanc, ['DataHora', 'tc:DataHora']) : null;
  } else if (substituicaoNode !== null && substituicaoNode !== undefined) {
    status = 'SUBSTITUIDA';
    situacaoDetalhe = 'Substituída';
  }

  return {
    numero: String(numero || '').trim(),
    codigoVerificacao: String(codigoVerificacao || '').trim(),
    dataEmissao: formatDateBr(dataEmissaoRaw),
    competencia: parseCompetencia(competenciaRaw),
    chaveAcesso: String(chaveAcesso || '').trim(),
    tomador: String(razaoSocialTomador || '').trim(),
    cnpjTomador: formatCnpj(cnpjTomadorRaw),
    discriminacao: String(discriminacao || '').trim(),
    valorServicos: parseCurrency(valorServicos),
    valorDeducoes: parseCurrency(valorDeducoes),
    valorPis: parseCurrency(valorPis),
    valorCofins: parseCurrency(valorCofins),
    valorInss: parseCurrency(valorInss),
    valorIr: parseCurrency(valorIr),
    valorCsll: parseCurrency(valorCsll),
    outrasRetencoes: parseCurrency(outrasRetencoes),
    valTotTributos: parseCurrency(valTotTributos),
    codigoTribNacional: String(itemListaServico || ''),
    codigoTribMunicipal: String(codigoTribMunicipal || ''),
    codigoCnae: String(codigoCnae || ''),
    localPrestacao: localPrestacaoDesc,
    codigoMunicipioPrestacao: String(codigoMunicipioPrestacao || ''),
    municipioIncidencia: String(municipioIncidencia || ''),
    aliquota: parseAliquot(aliquota),
    issApurado: parseCurrency(valorIss),
    issRetido: issRetido === '1',
    nbs,
    status,
    situacaoDetalhe,
    dataCancelamento,
    outrasInformacoes: String(outrasInformacoes || '').trim()
  };
}

/**
 * Realiza o parse da resposta XML de consulta da Prefeitura (ConsultarNfseFaixaResposta, ServicoPrestado ou ConsultarNfseRpsResposta)
 */
function parseConsultarNfseResposta(xmlString) {
  const parsed = parseXml(xmlString);
  const root = getXmlNode(parsed, [
    'ConsultarNfseFaixaResposta', 'tc:ConsultarNfseFaixaResposta',
    'ConsultarNfseServicoPrestadoResposta', 'tc:ConsultarNfseServicoPrestadoResposta',
    'ConsultarNfseRpsResposta', 'tc:ConsultarNfseRpsResposta',
    'ConsultarNfseResposta', 'tc:ConsultarNfseResposta'
  ]) || parsed;

  const listaNfse = getXmlNode(root, ['ListaNfse', 'tc:ListaNfse']);
  const compNfseList = listaNfse ? ensureArray(getXmlNode(listaNfse, ['CompNfse', 'tc:CompNfse'])) : [];

  // Se veio direto em CompNfse na raiz
  if (compNfseList.length === 0) {
    const directComp = getXmlNode(root, ['CompNfse', 'tc:CompNfse']);
    if (directComp) {
      compNfseList.push(...ensureArray(directComp));
    }
  }

  const notas = compNfseList
    .filter(Boolean)
    .map(comp => extractNfseData(comp))
    .filter(n => n.numero && n.numero !== '');

  const listaMensagem = getXmlNode(root, ['ListaMensagemRetorno', 'tc:ListaMensagemRetorno']);
  const mensagens = [];

  if (listaMensagem) {
    const msgs = ensureArray(getXmlNode(listaMensagem, ['MensagemRetorno', 'tc:MensagemRetorno']));
    for (const m of msgs.filter(Boolean)) {
      mensagens.push({
        codigo: getXmlValue(m, ['Codigo', 'tc:Codigo']),
        mensagem: getXmlValue(m, ['Mensagem', 'tc:Mensagem']),
        correcao: getXmlValue(m, ['Correcao', 'tc:Correcao'])
      });
    }
  }

  return {
    success: true,
    totalNotas: notas.length,
    notas,
    mensagens
  };
}

module.exports = {
  buildCabecalho,
  buildConsultarNfseFaixaEnvio,
  extractNfseData,
  parseConsultarNfseResposta
};
