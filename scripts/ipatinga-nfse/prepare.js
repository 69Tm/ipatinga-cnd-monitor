'use strict';

const { CONFIG } = require('./config');
const { readSheetValues } = require('./google');
const { isValidCnpj, normalizeCnpj, parseCurrency, parseCompetencia } = require('./validators');
const { validateXmlAgainstOfficialXsd } = require('./xsd-validator');

function normalizeLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function rowObject(headers, row) {
  const result = {};
  headers.forEach((header, index) => { result[normalizeLabel(header)] = row[index] ?? ''; });
  return result;
}

function firstField(record, aliases) {
  for (const alias of aliases) {
    const value = record[normalizeLabel(alias)];
    if (value !== undefined && String(value).trim() !== '') return value;
  }
  return '';
}

function splitList(value, expected = null) {
  if (Array.isArray(value)) return value;
  const text = String(value || '').trim();
  if (!text) return [];
  let result = text.split(/\s*(?:;|\|\|)\s*/).map(item => item.trim()).filter(Boolean);
  if (expected === 1 && result.length > 1) result = [text];
  return result;
}

function patternRows(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).filter(row => row.some(Boolean)).map(row => {
    const item = rowObject(headers, row);
    return {
      patternId: firstField(item, ['ID Padrão', 'pattern_id']),
      nome: firstField(item, ['Nome Padrão', 'nome']),
      tomador: firstField(item, ['Tomador']),
      cnpjTomador: firstField(item, ['CNPJ Tomador', 'cnpj_tomador']),
      categoria: firstField(item, ['Categoria']),
      template: firstField(item, ['Template / Descrição Oficial', 'template']),
      codigoTribNacional: firstField(item, ['Cód. Trib. Nacional', 'codigo_tributacao_nacional']),
      codigoTribMunicipal: firstField(item, ['Cód. Trib. Municipal', 'codigo_tributacao_municipal']),
      localPrestacao: firstField(item, ['Local Prestação', 'local_prestacao']),
      codigoMunicipioPrestacao: firstField(item, ['Cód. Município Prestação', 'codigo_municipio_prestacao']),
      codigoMunicipioIncidenciaIss: firstField(item, ['Cód. Município Incidência', 'Cód. Município Incidência ISS', 'codigo_municipio_incidencia', 'codigo_municipio_incidencia_iss']),
      issRetido: firstField(item, ['ISS Retido', 'iss_retido']),
      exigibilidadeIss: firstField(item, ['Exigibilidade ISS', 'exigibilidade_iss']),
      nbs: firstField(item, ['NBS']),
      confianca: firstField(item, ['Confiança', 'confianca']),
      status: firstField(item, ['Status'])
    };
  });
}

function demandRows(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).filter(row => row.some(Boolean)).map(row => {
    const item = rowObject(headers, row);
    return {
      requestId: firstField(item, ['Message ID', 'request_id', 'id']),
      periodo: firstField(item, ['Período', 'periodo']),
      notasSolicitadas: splitList(firstField(item, ['Notas solicitadas', 'notas_solicitadas'])),
      valores: splitList(firstField(item, ['Valores', 'valores'])),
      descricaoObrigatoria: splitList(firstField(item, ['Descrição obrigatória', 'descricao_obrigatoria'])),
      status: firstField(item, ['Status']),
      nfseResultantes: firstField(item, ['NFS-e resultantes', 'nfse_resultantes'])
    };
  });
}

function tomadorRows(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).filter(row => row.some(Boolean)).map(row => {
    const item = rowObject(headers, row);
    return {
      cnpj: normalizeCnpj(firstField(item, ['CNPJ', 'cnpj'])),
      razaoSocial: firstField(item, ['Razão Social', 'razao_social']),
      nomeCurto: firstField(item, ['Nome Curto', 'nome_curto']),
      logradouro: firstField(item, ['Logradouro', 'endereco']),
      numero: firstField(item, ['Número', 'numero']),
      complemento: firstField(item, ['Complemento', 'complemento']),
      bairro: firstField(item, ['Bairro', 'bairro']),
      codigoMunicipio: firstField(item, ['Cód. Município', 'codigo_municipio']),
      municipio: firstField(item, ['Município', 'municipio']),
      uf: firstField(item, ['UF', 'uf']),
      cep: firstField(item, ['CEP', 'cep']),
      statusHomologacao: firstField(item, ['Status Homologação', 'status_homologacao'])
    };
  });
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
  const issRetido = candidate.issRetido;
  const exigibilidadeIss = candidate.exigibilidadeIss;
  const codMunPrestacao = candidate.codigoMunicipioPrestacao;
  const codMunIncidencia = candidate.codigoMunicipioIncidenciaIss;
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
      `<InfDeclaracaoPrestacaoServico Id="${escapeXml(candidate.xmlId)}">` +
        `<Rps>` +
          `<IdentificacaoRps>` +
            `<Numero>${escapeXml(candidate.rpsNumero)}</Numero>` +
            `<Serie>${escapeXml(candidate.rpsSerie)}</Serie>` +
            `<Tipo>${escapeXml(candidate.rpsTipo)}</Tipo>` +
          `</IdentificacaoRps>` +
          `<DataEmissao>${escapeXml(candidate.dataEmissao)}</DataEmissao>` +
          `<Status>1</Status>` +
        `</Rps>` +
        `<Competencia>${escapeXml(candidate.competenciaData)}</Competencia>` +
        `<Servico>` +
          `<Valores>` +
            valoresXml +
          `</Valores>` +
          `<IssRetido>${escapeXml(issRetido)}</IssRetido>` +
          `<ItemListaServico>${escapeXml(itemLista)}</ItemListaServico>` +
          cnaeTag +
          `<CodigoTributacaoMunicipio>${escapeXml(candidate.codigoTribMunicipal)}</CodigoTributacaoMunicipio>` +
          `<Discriminacao>${escapeXml(candidate.descricao)}</Discriminacao>` +
          `<CodigoMunicipio>${escapeXml(codMunPrestacao)}</CodigoMunicipio>` +
          `<CodigoPais>1058</CodigoPais>` +
          `<ExigibilidadeISS>${escapeXml(exigibilidadeIss)}</ExigibilidadeISS>` +
          `<MunicipioIncidencia>${escapeXml(codMunIncidencia)}</MunicipioIncidencia>` +
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

function validateCandidate(candidate) {
  const errors = [];
  if (!candidate.requestId) errors.push('REQUEST_ID_MISSING');
  if (!isValidCnpj(candidate.cnpjTomador)) errors.push('CNPJ_TOMADOR_INVALID');
  if (!candidate.tomador) errors.push('TOMADOR_NAME_MISSING');
  if (!candidate.valor || candidate.valor <= 0) errors.push('SERVICE_VALUE_INVALID');
  if (!candidate.competenciaData) errors.push('COMPETENCE_INVALID');
  if (!candidate.descricao) errors.push('DESCRIPTION_MISSING');
  if (!candidate.codigoTribNacional) errors.push('NATIONAL_TAX_CODE_MISSING');
  if (!candidate.codigoTribMunicipal) errors.push('MUNICIPAL_TAX_CODE_MISSING');
  if (!candidate.codigoMunicipioPrestacao) errors.push('SERVICE_LOCATION_IBGE_MISSING');
  if (!candidate.codigoMunicipioIncidenciaIss) errors.push('ISS_INCIDENCE_LOCATION_IBGE_MISSING');
  if (!candidate.issRetido) errors.push('ISS_RETIDO_MISSING');
  if (!candidate.exigibilidadeIss) errors.push('EXIGIBILIDADE_ISS_MISSING');
  if (!candidate.nbs) errors.push('NBS_MISSING');
  if (!candidate.enderecoTomador || !candidate.enderecoTomador.logradouro || !candidate.enderecoTomador.numero || !candidate.enderecoTomador.bairro || !candidate.enderecoTomador.codigoMunicipio || !candidate.enderecoTomador.uf || !candidate.enderecoTomador.cep) {
    errors.push('TAKER_ADDRESS_INCOMPLETE');
  }
  if (normalizeLabel(candidate.patternId).includes('cisurg') && !candidate.descriptionFromDemand) {
    errors.push('CISURG_MONTHLY_MIRROR_DESCRIPTION_REQUIRED');
  }
  return errors;
}

function getPaymentInstructions() {
  return process.env.NFE_PAYMENT_INSTRUCTIONS || '';
}

function buildControlledCandidate({ requestId = 'fixture-controlada', environment = 'production', now = new Date() }) {
  const isProduction = environment === 'production';
  const paymentBlock = getPaymentInstructions();
  const paymentSuffix = paymentBlock ? ` ${paymentBlock}` : '';
  
  const descricao = isProduction
    ? `Dr Túlio Athélio Sathler Siman: Referente a Plantões Médicos P.S SUS no Mês 08/2026- R$ 10,00.${paymentSuffix}`
    : 'TESTE DE HOMOLOGACAO - SEM VALOR FISCAL - AUTOMACAO DEXMED';

  const candidate = {
    requestId,
    sequence: 1,
    patternId: 'HIC_PLANTOES_PS_SUS',
    categoria: 'HIC — Plantões PS SUS',
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
    valor: 10.00,
    competencia: '08/2026',
    competenciaData: '2026-08-01',
    descricao,
    descriptionFromDemand: true,
    codigoTribNacional: '04.03.01',
    codigoTribMunicipal: '403',
    localPrestacao: 'Guanhães/MG',
    codigoMunicipioPrestacao: '3128006',
    codigoMunicipioIncidenciaIss: '3131307', // Regra: ISS devido em Ipatinga
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
    xmlId: 'RPS_PREPARE_1'
  };

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

function buildHomologationFixture({ requestId = 'fixture-homologation-1', now = new Date() } = {}) {
  const candidate = {
    requestId,
    sequence: 1,
    patternId: 'HIC_PLANTOES_PS_SUS',
    categoria: 'HIC — Plantões PS SUS',
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
    competencia: '08/2026',
    competenciaData: '2026-08-01',
    descricao: 'HOMOLOGACAO - AUTOMACAO DEXMED',
    descriptionFromDemand: true,
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
    xmlId: 'RPS_PREPARE_1'
  };

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

function matchTomador(cnpjOrName, tomadores) {
  const cleanCnpj = normalizeCnpj(cnpjOrName);
  const normName = normalizeLabel(cnpjOrName);

  return tomadores.find(t => {
    if (cleanCnpj && t.cnpj === cleanCnpj) return true;
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

  const blockingReasons = [];
  const warnings = [];

  if (demanda.status === 'CONCLUÍDA' || demanda.nfseResultantes) {
    blockingReasons.push('DEMAND_ALREADY_COMPLETED');
  }

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
    const valorStr = valores[idx];
    const valor = parseCurrency(valorStr);
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

    if (descricaoObrig && descricaoObrig.trim() !== '') {
      descricaoFinal = descricaoObrig.trim();
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
      codigoMunicipioPrestacao: pattern.codigoMunicipioPrestacao,
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
  const spreadsheetId = dependencies.spreadsheetId || CONFIG.SHEETS.SPREADSHEET_ID;

  if (requestId.startsWith('fixture-homologation') || requestId.startsWith('fixture-controlada')) {
    if (environment === 'production' && process.env.NFE_ALLOW_CONTROLLED_PRODUCTION_TEST !== 'true') {
      throw new Error('CONTROLLED_PRODUCTION_TEST_DISABLED: Fixtures controladas em produção exigem NFE_ALLOW_CONTROLLED_PRODUCTION_TEST=true.');
    }
    const fixture = buildControlledCandidate({ requestId, environment });
    const xsdRes = await validateXmlAgainstOfficialXsd(fixture.candidates[0].xmlCandidate, 'GerarNfseEnvio');
    fixture.xsdValidation = xsdRes.valid ? 'VALIDATED_OFFICIAL_XSD' : 'INVALID';
    return fixture;
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

  if (prepared.candidates.length > 0 && prepared.candidates[0].xmlCandidate) {
    const xsdRes = await validateXmlAgainstOfficialXsd(prepared.candidates[0].xmlCandidate, 'GerarNfseEnvio');
    prepared.xsdValidation = xsdRes.valid ? 'VALIDATED_OFFICIAL_XSD' : 'INVALID';
    if (!xsdRes.valid) {
      prepared.validationStatus = 'REVISAO_MANUAL';
      prepared.blockingReasons.push(`XSD_ERROR: ${xsdRes.errors.join('; ')}`);
    }
  }

  return prepared;
}

module.exports = {
  patternRows,
  demandRows,
  tomadorRows,
  buildUnsignedCandidateXml,
  validateCandidate,
  buildControlledCandidate,
  buildHomologationFixture,
  prepareDemand,
  handlePrepare
};
