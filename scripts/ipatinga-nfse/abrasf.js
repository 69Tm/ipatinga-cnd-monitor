'use strict';

const { CONFIG } = require('./config');
const { parseXml, getXmlValue, getXmlNode, ensureArray } = require('./xml');
const {
  normalizeCnpj,
  formatCnpj,
  parseCurrency,
  parseAliquot,
  formatDateBr,
  formatDateIso,
  parseIsoDate,
  parseCompetencia
} = require('./validators');

/**
 * Monta o cabeçalho ABRASF 2.04
 */
function buildCabecalho() {
  return `<cabecalho versao="${CONFIG.ABRASF.VERSAO}" xmlns="${CONFIG.ABRASF.SCHEMA_NAMESPACE}"><versaoDados>${CONFIG.ABRASF.VERSAO}</versaoDados></cabecalho>`;
}

/**
 * Monta o payload ConsultarNfseFaixaEnvio
 */
function buildConsultarNfseFaixaEnvio({ from = 1, to = 50, page = 1, cnpj = null, im = null }) {
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
  const substituicaoNode = getXmlNode(compNode, ['NfseSubstituicao', 'tc:NfseSubstituicao']);

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
  const codigoTribMunicipio = servicoNode ? getXmlValue(servicoNode, ['CodigoTributacaoMunicipio', 'tc:CodigoTributacaoMunicipio']) : '';
  const codigoMunicipioPrestacao = servicoNode ? getXmlValue(servicoNode, ['CodigoMunicipio', 'tc:CodigoMunicipio']) : '';
  const municipioIncidencia = servicoNode ? getXmlValue(servicoNode, ['MunicipioIncidencia', 'tc:MunicipioIncidencia']) : '';
  const issRetido = servicoNode ? getXmlValue(servicoNode, ['IssRetido', 'tc:IssRetido']) : '2';

  const valorServicos = valoresServicoNode ? getXmlValue(valoresServicoNode, ['ValorServicos', 'tc:ValorServicos']) : (valoresNfseNode ? getXmlValue(valoresNfseNode, ['ValorServicos', 'tc:ValorServicos']) : null);
  const valorLiquido = valoresServicoNode ? getXmlValue(valoresServicoNode, ['ValorLiquidoNfse', 'tc:ValorLiquidoNfse']) : (valoresNfseNode ? getXmlValue(valoresNfseNode, ['ValorLiquidoNfse', 'tc:ValorLiquidoNfse']) : valorServicos);
  const baseCalculo = valoresNfseNode ? getXmlValue(valoresNfseNode, ['BaseCalculo', 'tc:BaseCalculo']) : (valoresServicoNode ? getXmlValue(valoresServicoNode, ['BaseCalculo', 'tc:BaseCalculo']) : null);
  const aliquota = valoresNfseNode ? getXmlValue(valoresNfseNode, ['Aliquota', 'tc:Aliquota']) : (valoresServicoNode ? getXmlValue(valoresServicoNode, ['Aliquota', 'tc:Aliquota']) : null);
  const valorIss = valoresNfseNode ? getXmlValue(valoresNfseNode, ['ValorIss', 'tc:ValorIss']) : (valoresServicoNode ? getXmlValue(valoresServicoNode, ['ValorIss', 'tc:ValorIss']) : null);

  // Tomador
  const tomadorNode = (infDps && getXmlNode(infDps, ['Tomador', 'tc:Tomador', 'TomadorServico', 'tc:TomadorServico'])) ||
                      getXmlNode(infNfse, ['TomadorServico', 'tc:TomadorServico', 'Tomador', 'tc:Tomador']);
  const identTomador = tomadorNode ? getXmlNode(tomadorNode, ['IdentificacaoTomador', 'tc:IdentificacaoTomador']) : null;
  const cpfCnpjTomador = identTomador ? getXmlNode(identTomador, ['CpfCnpj', 'tc:CpfCnpj']) : null;
  const cnpjTomador = cpfCnpjTomador ? (getXmlValue(cpfCnpjTomador, ['Cnpj', 'tc:Cnpj']) || getXmlValue(cpfCnpjTomador, ['Cpf', 'tc:Cpf'])) : (tomadorNode ? (getXmlValue(tomadorNode, ['Cnpj', 'tc:Cnpj']) || getXmlValue(tomadorNode, ['Cpf', 'tc:Cpf'])) : null);
  const razaoSocialTomador = tomadorNode ? getXmlValue(tomadorNode, ['RazaoSocial', 'tc:RazaoSocial']) : '';

  // Situação (Normal, Cancelada, Substituída)
  let status = 'NORMAL';
  let situacaoDetalhe = 'Normal';
  let dataCancelamento = null;

  if (cancelamentoNode !== null) {
    status = 'CANCELADA';
    const confirmacao = getXmlNode(cancelamentoNode, ['Confirmacao', 'tc:Confirmacao']);
    dataCancelamento = confirmacao ? getXmlValue(confirmacao, ['DataHora', 'tc:DataHora']) : null;
    situacaoDetalhe = `Cancelada em ${dataCancelamento ? formatDateBr(dataCancelamento) : 'data desconhecida'}`;
  } else if (substituicaoNode !== null) {
    status = 'SUBSTITUIDA';
    situacaoDetalhe = 'Substituída';
  }

  // Descobre Local Prestação (Ex: Guanhães/MG ou Ipatinga/MG)
  let localPrestacao = 'Ipatinga/MG';
  if (codigoMunicipioPrestacao === '3128006' || String(discriminacao).toUpperCase().includes('GUANHÃES') || String(discriminacao).toUpperCase().includes('GUANHAES')) {
    localPrestacao = 'Guanhães/MG';
  } else if (codigoMunicipioPrestacao === '3131307') {
    localPrestacao = 'Ipatinga/MG';
  } else if (codigoMunicipioPrestacao) {
    localPrestacao = `IBGE ${codigoMunicipioPrestacao}`;
  }

  // Descobre NBS ou código tributação nacional se presente
  let nbs = '';
  if (outrasInformacoes && outrasInformacoes.includes('NBS')) {
    const match = outrasInformacoes.match(/NBS[:\s]*([0-9.]+)/i);
    if (match) nbs = match[1].replace(/\D/g, '');
  } else if (itemListaServico) {
    nbs = '123011900'; // Padrão saúde humana / hospitalar se aplicável
  }

  return {
    numero: String(numero || '').trim(),
    codigoVerificacao: String(codigoVerificacao || '').trim(),
    chaveAcesso: String(chaveAcesso || '').trim(),
    dataEmissao: dataEmissaoRaw,
    competencia: parseCompetencia(competenciaRaw || dataEmissaoRaw),
    tomador: razaoSocialTomador ? razaoSocialTomador.trim() : '',
    cnpjTomador: cnpjTomador ? formatCnpj(cnpjTomador) : '',
    cnpjTomadorClean: cnpjTomador ? normalizeCnpj(cnpjTomador) : '',
    discriminacao: String(discriminacao || '').trim(),
    valorServicos: parseCurrency(valorServicos),
    valorLiquido: parseCurrency(valorLiquido || valorServicos),
    codigoTribNacional: itemListaServico || '04.03.01',
    codigoTribMunicipal: codigoTribMunicipio || '403',
    localPrestacao,
    aliquota: parseAliquot(aliquota),
    issApurado: parseCurrency(valorIss),
    issRetido: issRetido === '1',
    nbs: nbs || '123011900',
    status,
    situacaoDetalhe,
    dataCancelamento,
    outrasInformacoes: String(outrasInformacoes || '').trim()
  };
}

/**
 * Realiza o parse da resposta XML de consulta da Prefeitura (ConsultarNfseFaixaResposta ou ServicoPrestado)
 */
function parseConsultarNfseResposta(xmlString) {
  const parsed = parseXml(xmlString);
  const root = getXmlNode(parsed, [
    'ConsultarNfseFaixaResposta', 'tc:ConsultarNfseFaixaResposta',
    'ConsultarNfseServicoPrestadoResposta', 'tc:ConsultarNfseServicoPrestadoResposta',
    'ConsultarNfseResposta', 'tc:ConsultarNfseResposta'
  ]) || parsed;

  const listaNfseNode = getXmlNode(root, ['ListaNfse', 'tc:ListaNfse']);
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
    success: mensagens.every(msg => !msg.codigo || String(msg.codigo).toUpperCase() === 'L000'),
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
