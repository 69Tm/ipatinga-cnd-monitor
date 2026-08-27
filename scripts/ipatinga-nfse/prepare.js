'use strict';

const crypto = require('crypto');
const { XMLValidator } = require('fast-xml-parser');
const { CONFIG, sanitize } = require('./config');
const { readSheetValues, appendSheetValues, updateSheetValues } = require('./google');
const {
  normalizeCnpj,
  formatCnpj,
  parseCurrency,
  formatCurrency,
  parseIsoDate,
  parseCompetencia,
  onlyDigits
} = require('./validators');
const { KNOWN_PATTERNS, TOMADORES_DEFAULTS } = require('./patterns');

function normalizeLabel(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .toLowerCase();
}

function getPaymentInstructions() {
  const envVal = process.env.NFE_PAYMENT_INSTRUCTIONS;
  if (envVal && envVal.trim()) {
    return envVal.trim();
  }
  return '';
}

function demandRows(rawRows) {
  if (!rawRows || rawRows.length <= 1) return [];
  const rows = [];
  const headers = (rawRows[0] || []).map(h => String(h || '').trim().toLowerCase());
  
  // Mapeamento dinâmico de cabeçalhos por nome ou índice padrão
  const getIdx = (colName, fallbackIdx) => {
    const idx = headers.findIndex(h => h.includes(colName.toLowerCase()));
    return idx >= 0 ? idx : fallbackIdx;
  };

  const idxReqId = headers.includes('message id') ? getIdx('message id', 2) : 0;
  const idxPeriodo = getIdx('período', idxReqId === 2 ? 3 : 1);
  const idxNotasSol = getIdx('notas solicitadas', idxReqId === 2 ? 4 : 2);
  const idxValores = getIdx('valores', idxReqId === 2 ? 5 : 3);
  const idxDescricao = getIdx('descrição obrigatória', idxReqId === 2 ? 7 : 4);
  const idxStatus = getIdx('status', idxReqId === 2 ? 8 : 5);
  const idxNfse = getIdx('nfs-e resultantes', idxReqId === 2 ? 9 : 6);
  const idxDataProc = getIdx('data demanda', idxReqId === 2 ? 0 : 7);

  for (let i = 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    const requestId = String(r[idxReqId] || '').trim();
    if (!requestId) continue;

    // Ignora linha de teste legado corrompida
    if (requestId === 'e2e-integration-test-live-1') {
      continue;
    }

    rows.push({
      rowIndex: i + 1,
      requestId,
      periodo: String(r[idxPeriodo] || '').trim(),
      notasSolicitadasRaw: String(r[idxNotasSol] || '').trim(),
      notasSolicitadas: String(r[idxNotasSol] || '').split(';').map(s => s.trim()).filter(Boolean),
      valoresRaw: String(r[idxValores] || '').trim(),
      valores: String(r[idxValores] || '').split(';').map(s => s.trim()).filter(Boolean),
      descricaoObrigatoriaRaw: String(r[idxDescricao] || '').trim(),
      descricaoObrigatoria: String(r[idxDescricao] || '').split('||').map(s => s.trim()).filter(Boolean),
      status: String(r[idxStatus] || '').trim(),
      nfseResultantes: String(r[idxNfse] || '').trim(),
      dataProcessamento: String(r[idxDataProc] || '').trim()
    });
  }
  return rows;
}

function tomadorRows(rawRows) {
  if (!rawRows || rawRows.length <= 1) return [];
  const rows = [];
  for (let i = 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    const cnpj = normalizeCnpj(r[0]);
    if (!cnpj) continue;

    rows.push({
      rowIndex: i + 1,
      cnpj,
      cnpjFormatado: formatCnpj(cnpj),
      razaoSocial: String(r[1] || '').trim(),
      nomeCurto: String(r[2] || '').trim(),
      logradouro: String(r[3] || '').trim(),
      numero: String(r[4] || '').trim(),
      complemento: String(r[5] || '').trim(),
      bairro: String(r[6] || '').trim(),
      codigoMunicipio: String(r[7] || '').trim(),
      municipio: String(r[8] || '').trim(),
      uf: String(r[9] || '').trim(),
      cep: String(r[10] || '').trim(),
      email: String(r[11] || '').trim(),
      categorias: String(r[12] || '').trim(),
      statusHomologacao: String(r[13] || '').trim()
    });
  }
  return rows;
}

function patternRows(rawRows) {
  if (!rawRows || rawRows.length <= 1) return [];
  const rows = [];
  for (let i = 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    const patternId = String(r[0] || '').trim();
    if (!patternId) continue;

    rows.push({
      rowIndex: i + 1,
      patternId,
      nome: String(r[1] || '').trim(),
      tomador: String(r[2] || '').trim(),
      cnpjTomador: normalizeCnpj(r[3]),
      categoria: String(r[4] || '').trim(),
      template: String(r[5] || '').trim(),
      codigoTribNacional: String(r[6] || '').trim(),
      codigoTribMunicipal: String(r[7] || '').trim(),
      localPrestacao: String(r[8] || '').trim(),
      codigoIbgePrestacao: String(r[9] || '').trim(),
      codigoMunicipioIncidenciaIss: String(r[10] || '').trim(),
      issRetido: String(r[11] || '').trim(),
      exigibilidadeIss: String(r[12] || '').trim(),
      nbs: String(r[13] || '').trim(),
      confianca: String(r[14] || '').trim(),
      status: String(r[15] || '').trim()
    });
  }
  return rows;
}

function validateCandidate(candidate) {
  const errors = [];

  if (!candidate.tomador) errors.push('TOMADOR_MISSING');
  if (!candidate.cnpjTomador || !/^\d{14}$/.test(candidate.cnpjTomador)) errors.push('CNPJ_TOMADOR_INVALID');
  if (!candidate.valor || candidate.valor <= 0) errors.push('VALOR_INVALID');
  if (!candidate.descricao) errors.push('DESCRICAO_MISSING');
  if (!candidate.codigoTribNacional) errors.push('ITEM_LISTA_SERVICO_MISSING');
  if (!candidate.codigoTribMunicipal) errors.push('CODIGO_TRIBUTACAO_MUNICIPIO_MISSING');
  if (!candidate.codigoMunicipioPrestacao) errors.push('SERVICE_LOCATION_IBGE_MISSING');
  if (!candidate.codigoMunicipioIncidenciaIss) errors.push('ISS_INCIDENCE_LOCATION_IBGE_MISSING');
  if (!candidate.issRetido) errors.push('ISS_RETIDO_MISSING');
  if (!candidate.exigibilidadeIss) errors.push('EXIGIBILIDADE_ISS_MISSING');
  if (!candidate.competenciaData || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.competenciaData)) errors.push('COMPETENCIA_DATA_INVALID');

  if (!candidate.enderecoTomador) {
    errors.push('ENDERECO_TOMADOR_MISSING');
  } else {
    const end = candidate.enderecoTomador;
    if (!end.logradouro) errors.push('ENDERECO_LOGRADOURO_MISSING');
    if (!end.numero) errors.push('ENDERECO_NUMERO_MISSING');
    if (!end.bairro) errors.push('ENDERECO_BAIRRO_MISSING');
    if (!end.codigoMunicipio || !/^\d{7}$/.test(end.codigoMunicipio)) errors.push('ENDERECO_COD_MUNICIPIO_INVALID');
    if (!end.uf || end.uf.length !== 2) errors.push('ENDERECO_UF_INVALID');
    if (!end.cep || !/^\d{8}$/.test(end.cep)) errors.push('ENDERECO_CEP_INVALID');
  }

  return errors;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildUnsignedCandidateXml(candidate) {
  const itemLista = String(candidate.codigoTribNacional || '').split('.').slice(0, 2).join('.');
  const nbsTag = candidate.nbs ? `<cNBS>${escapeXml(candidate.nbs.replace(/\D/g, ''))}</cNBS>` : '';
  const cnaeTag = candidate.codigoCnae ? `<CodigoCnae>${escapeXml(candidate.codigoCnae)}</CodigoCnae>` : '';

  let enderecoXml = '';
  if (candidate.enderecoTomador) {
    const end = candidate.enderecoTomador;
    const complTag = end.complemento ? `<Complemento>${escapeXml(end.complemento)}</Complemento>` : '';
    enderecoXml = `<Endereco>` +
      `<Endereco>${escapeXml(end.logradouro || end.endereco)}</Endereco>` +
      `<Numero>${escapeXml(end.numero)}</Numero>` +
      complTag +
      `<Bairro>${escapeXml(end.bairro)}</Bairro>` +
      `<CodigoMunicipio>${escapeXml(end.codigoMunicipio)}</CodigoMunicipio>` +
      `<Uf>${escapeXml(end.uf)}</Uf>` +
      `<Cep>${escapeXml(String(end.cep || '').replace(/\D/g, ''))}</Cep>` +
    `</Endereco>`;
  }

  let valoresXml = `<ValorServicos>${candidate.valor.toFixed(2)}</ValorServicos>`;
  if (candidate.valorDeducoes !== undefined && candidate.valorDeducoes !== null && candidate.valorDeducoes > 0) {
    valoresXml += `<ValorDeducoes>${Number(candidate.valorDeducoes).toFixed(2)}</ValorDeducoes>`;
  }
  if (candidate.valorPis !== undefined && candidate.valorPis !== null && candidate.valorPis > 0) {
    valoresXml += `<ValorPis>${Number(candidate.valorPis).toFixed(2)}</ValorPis>`;
  }
  if (candidate.valorCofins !== undefined && candidate.valorCofins !== null && candidate.valorCofins > 0) {
    valoresXml += `<ValorCofins>${Number(candidate.valorCofins).toFixed(2)}</ValorCofins>`;
  }
  if (candidate.valorInss !== undefined && candidate.valorInss !== null && candidate.valorInss > 0) {
    valoresXml += `<ValorInss>${Number(candidate.valorInss).toFixed(2)}</ValorInss>`;
  }
  if (candidate.valorIr !== undefined && candidate.valorIr !== null && candidate.valorIr > 0) {
    valoresXml += `<ValorIr>${Number(candidate.valorIr).toFixed(2)}</ValorIr>`;
  }
  if (candidate.valorCsll !== undefined && candidate.valorCsll !== null && candidate.valorCsll > 0) {
    valoresXml += `<ValorCsll>${Number(candidate.valorCsll).toFixed(2)}</ValorCsll>`;
  }
  if (candidate.outrasRetencoes !== undefined && candidate.outrasRetencoes !== null && candidate.outrasRetencoes > 0) {
    valoresXml += `<OutrasRetencoes>${Number(candidate.outrasRetencoes).toFixed(2)}</OutrasRetencoes>`;
  }
  if (candidate.valTotTributos !== undefined && candidate.valTotTributos !== null && candidate.valTotTributos > 0) {
    valoresXml += `<ValTotTributos>${Number(candidate.valTotTributos).toFixed(2)}</ValTotTributos>`;
  }
  if (candidate.valorIss !== undefined && candidate.valorIss !== null && candidate.valorIss > 0) {
    valoresXml += `<ValorIss>${Number(candidate.valorIss).toFixed(2)}</ValorIss>`;
  }
  if (candidate.aliquotaIss !== undefined && candidate.aliquotaIss !== null && candidate.aliquotaIss > 0) {
    valoresXml += `<Aliquota>${Number(candidate.aliquotaIss).toFixed(4)}</Aliquota>`;
  }

  return `<GerarNfseEnvio xmlns="http://www.abrasf.org.br/nfse.xsd">` +
    `<Rps>` +
      `<InfDeclaracaoPrestacaoServico Id="${escapeXml(candidate.xmlId || 'RPS1A')}">` +
        `<Rps>` +
          `<IdentificacaoRps>` +
            `<Numero>${escapeXml(candidate.rpsNumero || '1')}</Numero>` +
            `<Serie>${escapeXml(candidate.rpsSerie || 'A')}</Serie>` +
            `<Tipo>${escapeXml(candidate.rpsTipo || '1')}</Tipo>` +
          `</IdentificacaoRps>` +
          `<DataEmissao>${escapeXml(candidate.dataEmissao)}</DataEmissao>` +
          `<Status>1</Status>` +
        `</Rps>` +
        `<Competencia>${escapeXml(candidate.competenciaData)}</Competencia>` +
        `<Servico>` +
          `<Valores>` +
            valoresXml +
          `</Valores>` +
          `<IssRetido>${escapeXml(candidate.issRetido)}</IssRetido>` +
          `<ItemListaServico>${escapeXml(itemLista)}</ItemListaServico>` +
          cnaeTag +
          `<CodigoTributacaoMunicipio>${escapeXml(candidate.codigoTribMunicipal)}</CodigoTributacaoMunicipio>` +
          `<Discriminacao>${escapeXml(candidate.descricao)}</Discriminacao>` +
          `<CodigoMunicipio>${escapeXml(candidate.codigoMunicipioPrestacao)}</CodigoMunicipio>` +
          `<CodigoPais>1058</CodigoPais>` +
          `<ExigibilidadeISS>${escapeXml(candidate.exigibilidadeIss)}</ExigibilidadeISS>` +
          `<MunicipioIncidencia>${escapeXml(candidate.codigoMunicipioIncidenciaIss)}</MunicipioIncidencia>` +
          nbsTag +
        `</Servico>` +
        `<Prestador>` +
          `<CpfCnpj><Cnpj>${escapeXml(CONFIG.PRESTADOR.CNPJ_DIGITS)}</Cnpj></CpfCnpj>` +
          `<InscricaoMunicipal>${escapeXml(CONFIG.PRESTADOR.INSCRICAO_MUNICIPAL)}</InscricaoMunicipal>` +
        `</Prestador>` +
        `<TomadorServico>` +
          `<IdentificacaoTomador>` +
            `<CpfCnpj><Cnpj>${escapeXml(candidate.cnpjTomador)}</Cnpj></CpfCnpj>` +
          `</IdentificacaoTomador>` +
          `<RazaoSocial>${escapeXml(candidate.tomador)}</RazaoSocial>` +
          enderecoXml +
        `</TomadorServico>` +
        `<OptanteSimplesNacional>${escapeXml(CONFIG.PRESTADOR.OPTANTE_SIMPLES_NACIONAL)}</OptanteSimplesNacional>` +
        `<IncentivoFiscal>2</IncentivoFiscal>` +
      `</InfDeclaracaoPrestacaoServico>` +
    `</Rps>` +
  `</GerarNfseEnvio>`;
}

function buildHomologationFixture(options = {}) {
  const requestId = options.requestId || `fixture-homologation-${Date.now()}`;
  const now = new Date();
  const competencia = `${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
  const competenciaData = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const paymentBlock = getPaymentInstructions();

  const candidate = {
    requestId,
    sequence: 1,
    patternId: 'HIC_PLANTOES_PS_SUS',
    categoria: 'HIC — Plantões PS SUS (HOMOLOGAÇÃO)',
    tomador: 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO',
    cnpjTomador: '20724357000120',
    enderecoTomador: {
      logradouro: 'CAPITAO BERNARDO',
      numero: '257',
      complemento: '',
      bairro: 'CENTRO',
      codigoMunicipio: '3128006',
      uf: 'MG',
      cep: '39740000'
    },
    valor: 100.00,
    competencia,
    competenciaData,
    descricao: paymentBlock
      ? `SERVICOS MEDICOS DE PLANTAO HOSPITALAR SUS - TESTE HOMOLOGACAO\n\n${paymentBlock}`
      : `SERVICOS MEDICOS DE PLANTAO HOSPITALAR SUS - TESTE HOMOLOGACAO`,
    descriptionFromDemand: false,
    codigoTribNacional: '04.03.01',
    codigoTribMunicipal: '403',
    localPrestacao: 'Guanhães/MG',
    codigoMunicipioPrestacao: '3128006',
    codigoMunicipioIncidenciaIss: '3131307',
    issRetido: '2',
    exigibilidadeIss: '1',
    nbs: '123011900',
    codigoCnae: null,
    aliquotaIss: null,
    valorIss: null,
    rpsStatus: 'PENDING_ALLOCATION',
    rpsNumero: '',
    rpsSerie: 'A',
    rpsTipo: '1',
    dataEmissao: now.toISOString().slice(0, 10),
    xmlId: 'RPS_FIXTURE_1'
  };

  candidate.validationErrors = validateCandidate(candidate);
  candidate.xmlCandidate = buildUnsignedCandidateXml(candidate);

  return {
    operation: 'prepare',
    status: 'SUCCESS',
    validationStatus: 'READY_TO_ISSUE',
    requestId,
    candidates: [candidate],
    blockingReasons: [],
    warnings: []
  };
}

function buildControlledCandidate({ requestId, environment = 'production' }) {
  if (environment === 'production' && process.env.NFE_ALLOW_CONTROLLED_PRODUCTION_TEST !== 'true') {
    throw new Error('CONTROLLED_PRODUCTION_TEST_DISABLED: Fixtures controladas em produção exigem NFE_ALLOW_CONTROLLED_PRODUCTION_TEST=true.');
  }

  const now = new Date();
  const competencia = `${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
  const competenciaData = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const paymentBlock = getPaymentInstructions();

  const candidate = {
    requestId,
    sequence: 1,
    patternId: 'HIC_PLANTOES_PS_SUS',
    categoria: 'HIC — Plantões PS SUS (PRODUÇÃO CONTROLADA)',
    tomador: 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO',
    cnpjTomador: '20724357000120',
    enderecoTomador: {
      logradouro: 'CAPITAO BERNARDO',
      numero: '257',
      complemento: '',
      bairro: 'CENTRO',
      codigoMunicipio: '3128006',
      municipio: 'GUANHAES',
      uf: 'MG',
      cep: '39740000'
    },
    valor: 10.00,
    competencia,
    competenciaData,
    descricao: paymentBlock
      ? `SERVICOS MEDICOS DE PLANTAO HOSPITALAR SUS - TESTE CONTROLADO PRODUCAO\n\n${paymentBlock}`
      : `SERVICOS MEDICOS DE PLANTAO HOSPITALAR SUS - TESTE CONTROLADO PRODUCAO`,
    descriptionFromDemand: false,
    codigoTribNacional: '04.03.01',
    codigoTribMunicipal: '403',
    localPrestacao: 'Guanhães/MG',
    codigoMunicipioPrestacao: '3128006',
    codigoMunicipioIncidenciaIss: '3131307',
    issRetido: '2',
    exigibilidadeIss: '1',
    nbs: '123011900',
    codigoCnae: null,
    aliquotaIss: null,
    valorIss: null,
    rpsStatus: 'PENDING_ALLOCATION',
    rpsNumero: '',
    rpsSerie: 'A',
    rpsTipo: '1',
    dataEmissao: now.toISOString().slice(0, 10),
    xmlId: 'RPS_CONTROLLED_1'
  };

  candidate.validationErrors = validateCandidate(candidate);
  candidate.xmlCandidate = buildUnsignedCandidateXml(candidate);

  return {
    operation: 'prepare',
    status: 'SUCCESS',
    validationStatus: 'READY_TO_ISSUE',
    requestId,
    candidates: [candidate],
    blockingReasons: [],
    warnings: []
  };
}

function matchPattern(categoriaDemanda, patterns) {
  const normDemanda = normalizeLabel(categoriaDemanda);
  return patterns.find(p => {
    const normPattNome = normalizeLabel(p.nome);
    const normPattCat = normalizeLabel(p.categoria);
    const normPattId = normalizeLabel(p.patternId);
    return normDemanda === normPattNome ||
           normDemanda === normPattCat ||
           normDemanda === normPattId ||
           (normDemanda.includes('hic') && normPattId.includes('hic_plantoes') && normDemanda.includes('plant')) ||
           (normDemanda.includes('hic') && normPattId.includes('hic_producao') && normDemanda.includes('prod')) ||
           (normDemanda.includes('cisurg') && normPattId.includes('cisurg'));
  }) || null;
}

function matchTomador(tomadorRef, tomadores) {
  const cleanCnpj = normalizeCnpj(tomadorRef);
  if (cleanCnpj) {
    const byCnpj = tomadores.find(t => t.cnpj === cleanCnpj);
    if (byCnpj) return byCnpj;
  }

  const normName = normalizeLabel(tomadorRef);
  return tomadores.find(t => {
    const normRazao = normalizeLabel(t.razaoSocial);
    const normCurto = normalizeLabel(t.nomeCurto);
    return (normRazao && normName.includes(normRazao)) ||
           (normCurto && normName.includes(normCurto)) ||
           (normName.includes('carmo') && normRazao.includes('carmo')) ||
           (normName.includes('cisurg') && normRazao.includes('cisurg'));
  }) || null;
}

function prepareDemand({ requestId, demandas, tomadores, patterns, notas = [], now = new Date() }) {
  const demanda = demandas.find(d => d.requestId === requestId);
  if (!demanda) {
    return {
      operation: 'prepare',
      status: 'FAILED',
      validationStatus: 'REVISAO_MANUAL',
      requestId,
      candidates: [],
      blockingReasons: ['DEMAND_NOT_FOUND'],
      warnings: []
    };
  }

  if (demanda.status === 'CONCLUÍDA' || demanda.nfseResultantes) {
    return {
      operation: 'prepare',
      status: 'SUCCESS',
      validationStatus: 'ALREADY_ISSUED',
      requestId,
      candidates: [],
      blockingReasons: ['DEMAND_ALREADY_COMPLETED'],
      warnings: []
    };
  }

  const blockingReasons = [];
  const warnings = [];

  const notasSolicitadas = demanda.notasSolicitadas;
  const valores = demanda.valores;
  const descricoes = demanda.descricaoObrigatoria;

  if (notasSolicitadas.length === 0) {
    blockingReasons.push('NO_NOTES_REQUESTED');
  }

  if (notasSolicitadas.length !== valores.length) {
    blockingReasons.push('NOTES_COUNT_VALUE_COUNT_MISMATCH');
  }

  const competencia = parseCompetencia(demanda.periodo);
  if (!competencia) {
    blockingReasons.push('COMPETENCE_INVALID');
  }

  // Gera data ISO da competência (ex: 2026-08-01)
  let competenciaData = '';
  if (competencia && /^\d{2}\/\d{4}$/.test(competencia)) {
    const [mes, ano] = competencia.split('/');
    competenciaData = `${ano}-${mes}-01`;
  }

  const candidates = [];

  notasSolicitadas.forEach((notaSolicitada, idx) => {
    const rawValorStr = valores[idx];
    const valor = parseCurrency(rawValorStr);
    const valorStr = formatCurrency(valor);
    const descricaoObrig = descricoes[idx] || (descricoes.length === 1 ? descricoes[0] : '');

    const pattern = matchPattern(notaSolicitada, patterns);
    if (!pattern) {
      blockingReasons.push(`PATTERN_NOT_IDENTIFIED: ${notaSolicitada}`);
      return;
    }

    const tomador = matchTomador(pattern.cnpjTomador || pattern.tomador, tomadores);
    if (!tomador) {
      blockingReasons.push(`TOMADOR_NOT_IDENTIFIED: ${pattern.tomador || pattern.cnpjTomador}`);
      return;
    }

    // Validação estrita do endereço do tomador (para XSD)
    if (!tomador.logradouro || !tomador.numero || !tomador.bairro || !tomador.codigoMunicipio || !tomador.uf || !tomador.cep) {
      blockingReasons.push(`TOMADOR_ADDRESS_INCOMPLETE: ${tomador.razaoSocial}`);
    }

    // Montagem da Descrição
    let descricaoFinal = '';
    let descriptionFromDemand = false;

    if (descricaoObrig) {
      descricaoFinal = descricaoObrig;
      descriptionFromDemand = true;
    } else if (pattern.template) {
      const paymentBlock = getPaymentInstructions();
      descricaoFinal = pattern.template
        .replace(/{MM\/AAAA}/g, competencia)
        .replace(/{VALOR}/g, valorStr)
        .replace(/{BLOCO_BANCARIO_VALIDADO}/g, paymentBlock)
        .replace(/{BLOCO_BANCARIO}/g, paymentBlock)
        .trim();
    } else {
      blockingReasons.push(`DESCRIPTION_UNRESOLVABLE: item ${idx + 1}`);
    }

    // Regra CISURG: Exige espelho mensal exato
    if (normalizeLabel(pattern.patternId).includes('cisurg') && !descriptionFromDemand) {
      blockingReasons.push(`CISURG_REQUIRES_EXPLICIT_MONTHLY_MIRROR_DESCRIPTION: item ${idx + 1}`);
    }

    const candidate = {
      requestId,
      rowIndex: demanda.rowIndex || null,
      sequence: idx + 1,
      patternId: pattern.patternId,
      categoria: pattern.categoria || notaSolicitada,
      tomador: tomador.razaoSocial,
      cnpjTomador: tomador.cnpj,
      enderecoTomador: {
        logradouro: tomador.logradouro,
        numero: tomador.numero,
        complemento: tomador.complemento || '',
        bairro: tomador.bairro,
        codigoMunicipio: tomador.codigoMunicipio,
        uf: tomador.uf,
        cep: tomador.cep
      },
      valor,
      competencia,
      competenciaData,
      descricao: descricaoFinal,
      descriptionFromDemand,
      codigoTribNacional: pattern.codigoTribNacional,
      codigoTribMunicipal: pattern.codigoTribMunicipal,
      localPrestacao: pattern.localPrestacao,
      codigoMunicipioPrestacao: pattern.codigoIbgePrestacao,
      codigoMunicipioIncidenciaIss: pattern.codigoMunicipioIncidenciaIss,
      issRetido: pattern.issRetido,
      exigibilidadeIss: pattern.exigibilidadeIss,
      nbs: pattern.nbs,
      codigoCnae: null,
      aliquotaIss: null, // Motor fiscal não fixa alíquota; prefeitura apura no Simples Nacional
      valorIss: null,
      rpsStatus: 'PENDING_ALLOCATION',
      rpsNumero: '',
      rpsSerie: 'A',
      rpsTipo: '1',
      dataEmissao: now.toISOString().slice(0, 10),
      xmlId: `RPS_PREPARE_${idx + 1}`
    };

    candidate.validationErrors = validateCandidate(candidate);
    if (candidate.validationErrors.length > 0) {
      blockingReasons.push(...candidate.validationErrors);
    } else {
      candidate.xmlCandidate = buildUnsignedCandidateXml(candidate);
    }

    candidates.push(candidate);
  });

  const validationStatus = blockingReasons.length > 0 ? 'REVISAO_MANUAL' : 'READY_TO_ISSUE';

  return {
    operation: 'prepare',
    status: 'SUCCESS',
    validationStatus,
    requestId,
    candidates,
    blockingReasons: Array.from(new Set(blockingReasons)),
    warnings
  };
}

async function handlePrepare({ requestId, environment = 'homologation', dryRun = false }, dependencies = {}) {
  const read = dependencies.readSheetValues || readSheetValues;
  const update = dependencies.updateSheetValues || updateSheetValues;
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;

  if (requestId.startsWith('fixture-homologation') || requestId.startsWith('fixture-controlada')) {
    if (environment === 'production' && process.env.NFE_ALLOW_CONTROLLED_PRODUCTION_TEST !== 'true') {
      throw new Error('CONTROLLED_PRODUCTION_TEST_DISABLED: Fixtures controladas em produção exigem NFE_ALLOW_CONTROLLED_PRODUCTION_TEST=true.');
    }
    return environment === 'production'
      ? buildControlledCandidate({ requestId, environment })
      : buildHomologationFixture({ requestId });
  }

  const [demandasRaw, tomadoresRaw, patternsRaw, notasRaw] = await Promise.all([
    read(spreadsheetId, `${CONFIG.SHEETS.TABS.DEMANDAS}!A:Z`),
    read(spreadsheetId, `${CONFIG.SHEETS.TABS.TOMADORES}!A:S`),
    read(spreadsheetId, `${CONFIG.SHEETS.TABS.PADROES}!A:X`),
    read(spreadsheetId, `${CONFIG.SHEETS.TABS.NOTAS}!A:X`)
  ]);

  const prepared = prepareDemand({
    requestId,
    demandas: demandRows(demandasRaw),
    tomadores: tomadorRows(tomadoresRaw),
    patterns: patternRows(patternsRaw),
    notas: notasRaw
  });

  return prepared;
}

module.exports = {
  demandRows,
  tomadorRows,
  patternRows,
  validateCandidate,
  buildUnsignedCandidateXml,
  buildHomologationFixture,
  buildControlledCandidate,
  prepareDemand,
  handlePrepare,
  getPaymentInstructions
};
