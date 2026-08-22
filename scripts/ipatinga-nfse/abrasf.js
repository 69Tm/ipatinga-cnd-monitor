'use strict';

const { CONFIG } = require('./config');
const { getXmlNode, getXmlValue, ensureArray, parseXml } = require('./xml');
const {
  formatCnpj,
  formatDateBr,
  formatCurrencyBr,
  parseAliquot,
  parseCurrency,
  normalizeCnpj
} = require('./validators');

/**
 * Monta o cabeçalho padrão ABRASF 2.04
 */
function buildCabecalho(versao = CONFIG.ABRASF.VERSAO) {
  return `<cabecalho xmlns="${CONFIG.ABRASF.SCHEMA_NAMESPACE}" versao="${versao}">` +
    `<versaoDados>${versao}</versaoDados>` +
  `</cabecalho>`;
}

/**
 * Monta o payload ConsultarNfseFaixaEnvio
 */
function buildConsultarNfseFaixaEnvio({ from, to, page = 1, cnpj = null, im = null }) {
  const cnpjClean = cnpj ? normalizeCnpj(cnpj) : CONFIG.PRESTADOR.CNPJ_DIGITS;
  const imClean = im || CONFIG.PRESTADOR.INSCRICAO_MUNICIPAL;

  return `<ConsultarNfseFaixaEnvio xmlns="${CONFIG.ABRASF.SCHEMA_NAMESPACE}">` +
    `<Prestador>` +
      `<CpfCnpj><Cnpj>${cnpjClean}</Cnpj></CpfCnpj>` +
      `<InscricaoMunicipal>${imClean}</InscricaoMunicipal>` +
    `</Prestador>` +
    `<Faixa>` +
      `<NumeroNfseInicial>${from}</NumeroNfseInicial>` +
      `<NumeroNfseFinal>${to}</NumeroNfseFinal>` +
    `</Faixa>` +
    `<Pagina>${page}</Pagina>` +
  `</ConsultarNfseFaixaEnvio>`;
}

/**
 * Monta o payload ConsultarNfseServicoPrestadoEnvio
 */
function buildConsultarNfseServicoPrestadoEnvio({ dataInicial, dataFinal, page = 1, cnpj = null, im = null }) {
  const cnpjClean = cnpj ? normalizeCnpj(cnpj) : CONFIG.PRESTADOR.CNPJ_DIGITS;
  const imClean = im || CONFIG.PRESTADOR.INSCRICAO_MUNICIPAL;

  return `<ConsultarNfseServicoPrestadoEnvio xmlns="${CONFIG.ABRASF.SCHEMA_NAMESPACE}">` +
    `<Prestador>` +
      `<CpfCnpj><Cnpj>${cnpjClean}</Cnpj></CpfCnpj>` +
      `<InscricaoMunicipal>${imClean}</InscricaoMunicipal>` +
    `</Prestador>` +
    `<PeriodoEmissao>` +
      `<DataInicial>${dataInicial}</DataInicial>` +
      `<DataFinal>${dataFinal}</DataFinal>` +
    `</PeriodoEmissao>` +
    `<Pagina>${page}</Pagina>` +
  `</ConsultarNfseServicoPrestadoEnvio>`;
}

/**
 * Normaliza e extrai os dados de uma única NFS-e (nó CompNfse ou Nfse)
 */
function parseCompNfse(compNode) {
  if (!compNode) return null;

  const nfseNode = getXmlNode(compNode, ['Nfse', 'tc:Nfse']) || compNode;
  const infNfse = getXmlNode(nfseNode, ['InfNfse', 'tc:InfNfse']) || nfseNode;
  const cancelamentoNode = getXmlNode(compNode, ['NfseCancelamento', 'tc:NfseCancelamento']);
  const substituicaoNode = getXmlNode(compNode, ['NfseSubstituicao', 'tc:NfseSubstituicao']) ?? (compNode.NfseSubstituicao !== undefined ? compNode.NfseSubstituicao : null);

  // Identificação da Nota
  const numero = getXmlValue(infNfse, ['Numero', 'tc:Numero']);
  const codigoVerificacao = getXmlValue(infNfse, ['CodigoVerificacao', 'tc:CodigoVerificacao']);
  const dataEmissaoRaw = getXmlValue(infNfse, ['DataEmissao', 'tc:DataEmissao']);
  const outrasInformacoes = getXmlValue(infNfse, ['OutrasInformacoes', 'tc:OutrasInformacoes']);

  // DPS / Declaracao Prestacao Servico
  const dpsNode = getXmlNode(infNfse, [
    'DeclaracaoPrestacaoServico', 'tc:DeclaracaoPrestacaoServico',
    'InfDeclaracaoPrestacaoServico', 'tc:InfDeclaracaoPrestacaoServico'
  ]);
  const infDps = dpsNode ? (getXmlNode(dpsNode, ['InfDeclaracaoPrestacaoServico', 'tc:InfDeclaracaoPrestacaoServico']) || dpsNode) : null;

  const competenciaRaw = (infDps && getXmlValue(infDps, ['Competencia', 'tc:Competencia'])) ||
                         getXmlValue(infNfse, ['Competencia', 'tc:Competencia']);
  const chaveAcesso = (infDps && getXmlValue(infDps, ['ChaveAcesso', 'tc:ChaveAcesso'])) ||
                      getXmlValue(infNfse, ['ChaveAcesso', 'tc:ChaveAcesso']);

  // Serviço & Valores
  const servicoNode = (infDps && getXmlNode(infDps, ['Servico', 'tc:Servico'])) ||
                      getXmlNode(infNfse, ['Servico', 'tc:Servico']);
  const valoresServicoNode = servicoNode ? getXmlNode(servicoNode, ['Valores', 'tc:Valores']) : null;
  const valoresNfseNode = getXmlNode(infNfse, ['ValoresNfse', 'tc:ValoresNfse']);

  const discriminacao = servicoNode ? getXmlValue(servicoNode, ['Discriminacao', 'tc:Discriminacao']) : '';
  const itemListaServico = servicoNode ? getXmlValue(servicoNode, ['ItemListaServico', 'tc:ItemListaServico']) : '';
  const codigoCnae = servicoNode ? getXmlValue(servicoNode, ['CodigoCnae', 'tc:CodigoCnae']) : '';
  const codigoTribMunicipal = servicoNode ? getXmlValue(servicoNode, ['CodigoTributacaoMunicipio', 'tc:CodigoTributacaoMunicipio']) : '';
  const codigoMunicipioPrestacao = servicoNode ? getXmlValue(servicoNode, ['CodigoMunicipio', 'tc:CodigoMunicipio']) : '';
  const municipioIncidencia = servicoNode ? getXmlValue(servicoNode, ['MunicipioIncidencia', 'tc:MunicipioIncidencia']) : '';
  const issRetido = servicoNode ? getXmlValue(servicoNode, ['IssRetido', 'tc:IssRetido']) : '';

  const valorServicos = (valoresServicoNode && getXmlValue(valoresServicoNode, ['ValorServicos', 'tc:ValorServicos'])) ||
                        (valoresNfseNode && getXmlValue(valoresNfseNode, ['ValorServicos', 'tc:ValorServicos'])) || '0';
  const valorDeducoes = (valoresServicoNode && getXmlValue(valoresServicoNode, ['ValorDeducoes', 'tc:ValorDeducoes'])) ||
                        (valoresNfseNode && getXmlValue(valoresNfseNode, ['ValorDeducoes', 'tc:ValorDeducoes'])) || '0';
  const valorPis = (valoresServicoNode && getXmlValue(valoresServicoNode, ['ValorPis', 'tc:ValorPis'])) ||
                   (valoresNfseNode && getXmlValue(valoresNfseNode, ['ValorPis', 'tc:ValorPis'])) || '0';
  const valorCofins = (valoresServicoNode && getXmlValue(valoresServicoNode, ['ValorCofins', 'tc:ValorCofins'])) ||
                      (valoresNfseNode && getXmlValue(valoresNfseNode, ['ValorCofins', 'tc:ValorCofins'])) || '0';
  const valorInss = (valoresServicoNode && getXmlValue(valoresServicoNode, ['ValorInss', 'tc:ValorInss'])) ||
                    (valoresNfseNode && getXmlValue(valoresNfseNode, ['ValorInss', 'tc:ValorInss'])) || '0';
  const valorIr = (valoresServicoNode && getXmlValue(valoresServicoNode, ['ValorIr', 'tc:ValorIr'])) ||
                  (valoresNfseNode && getXmlValue(valoresNfseNode, ['ValorIr', 'tc:ValorIr'])) || '0';
  const valorCsll = (valoresServicoNode && getXmlValue(valoresServicoNode, ['ValorCsll', 'tc:ValorCsll'])) ||
                    (valoresNfseNode && getXmlValue(valoresNfseNode, ['ValorCsll', 'tc:ValorCsll'])) || '0';
  const outrasRetencoes = (valoresServicoNode && getXmlValue(valoresServicoNode, ['OutrasRetencoes', 'tc:OutrasRetencoes'])) ||
                          (valoresNfseNode && getXmlValue(valoresNfseNode, ['OutrasRetencoes', 'tc:OutrasRetencoes'])) || '0';
  const valTotTributos = (valoresServicoNode && getXmlValue(valoresServicoNode, ['ValTotTributos', 'tc:ValTotTributos'])) ||
                         (valoresNfseNode && getXmlValue(valoresNfseNode, ['ValTotTributos', 'tc:ValTotTributos'])) || '0';
  const valorIss = (valoresServicoNode && getXmlValue(valoresServicoNode, ['ValorIss', 'tc:ValorIss'])) ||
                   (valoresNfseNode && getXmlValue(valoresNfseNode, ['ValorIss', 'tc:ValorIss'])) || '0';
  const aliquota = (valoresServicoNode && getXmlValue(valoresServicoNode, ['Aliquota', 'tc:Aliquota'])) ||
                   (valoresNfseNode && getXmlValue(valoresNfseNode, ['Aliquota', 'tc:Aliquota'])) || '0';

  // Tomador
  const tomadorNode = (infDps && getXmlNode(infDps, ['Tomador', 'tc:Tomador', 'TomadorServico', 'tc:TomadorServico'])) ||
                      getXmlNode(infNfse, ['TomadorServico', 'tc:TomadorServico', 'Tomador', 'tc:Tomador']);
  const tomadorIdent = tomadorNode ? getXmlNode(tomadorNode, ['IdentificacaoTomador', 'tc:IdentificacaoTomador']) : null;
  const tomadorCpfCnpj = tomadorIdent ? getXmlNode(tomadorIdent, ['CpfCnpj', 'tc:CpfCnpj']) : null;

  const cnpjTomadorRaw = (tomadorCpfCnpj && (getXmlValue(tomadorCpfCnpj, ['Cnpj', 'tc:Cnpj']) || getXmlValue(tomadorCpfCnpj, ['Cpf', 'tc:Cpf']))) || '';
  const razaoSocialTomador = tomadorNode ? getXmlValue(tomadorNode, ['RazaoSocial', 'tc:RazaoSocial']) : '';

  // Local da prestação descritivo
  let localPrestacaoDesc = '';
  if (codigoMunicipioPrestacao === '3128006') localPrestacaoDesc = 'Guanhães/MG';
  else if (codigoMunicipioPrestacao === '3131703') localPrestacaoDesc = 'Itabira/MG';
  else if (codigoMunicipioPrestacao === '3131307') localPrestacaoDesc = 'Ipatinga/MG';
  else if (codigoMunicipioPrestacao) localPrestacaoDesc = `IBGE ${codigoMunicipioPrestacao}`;

  // NBS
  let nbs = '';
  if (servicoNode) {
    nbs = getXmlValue(servicoNode, ['cNBS', 'tc:cNBS', 'NBS', 'tc:NBS']) || '';
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
    competencia: formatDateBr(competenciaRaw),
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

  const listaNfseNode = getXmlNode(root, ['ListaNfse', 'tc:ListaNfse']);
  const directComp = getXmlNode(root, ['CompNfse', 'tc:CompNfse']);
  const listaMensagemNode = getXmlNode(root, ['ListaMensagemRetorno', 'tc:ListaMensagemRetorno', 'ListaMensagensRetorno', 'tc:ListaMensagensRetorno']);

  const notas = [];
  const mensagens = [];

  if (listaNfseNode) {
    const compList = ensureArray(getXmlNode(listaNfseNode, ['CompNfse', 'tc:CompNfse']));
    for (const comp of compList) {
      const parsedNote = parseCompNfse(comp);
      if (parsedNote && parsedNote.numero) {
        notas.push(parsedNote);
      }
    }
  } else if (directComp) {
    const compList = ensureArray(directComp);
    for (const comp of compList) {
      const parsedNote = parseCompNfse(comp);
      if (parsedNote && parsedNote.numero) {
        notas.push(parsedNote);
      }
    }
  }

  if (listaMensagemNode) {
    const msgList = ensureArray(getXmlNode(listaMensagemNode, ['MensagemRetorno', 'tc:MensagemRetorno']));
    for (const msg of msgList) {
      mensagens.push({
        codigo: getXmlValue(msg, ['Codigo', 'tc:Codigo']),
        mensagem: getXmlValue(msg, ['Mensagem', 'tc:Mensagem']),
        correcao: getXmlValue(msg, ['Correcao', 'tc:Correcao'])
      });
    }
  }

  // Ordena notas por número crescente
  notas.sort((a, b) => Number(a.numero || 0) - Number(b.numero || 0));

  return {
    // Ipatinga retorna E212 para faixa válida sem NFS-e; L000 aparece em fixtures/implementações ABRASF.
    success: mensagens.every(msg => !msg.codigo || ['L000', 'E212'].includes(String(msg.codigo).toUpperCase())),
    notas,
    mensagens,
    totalNotas: notas.length
  };
}

module.exports = {
  buildCabecalho,
  buildConsultarNfseFaixaEnvio,
  buildConsultarNfseServicoPrestadoEnvio,
  parseCompNfse,
  parseConsultarNfseResposta
};
