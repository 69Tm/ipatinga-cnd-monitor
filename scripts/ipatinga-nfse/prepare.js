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
      issRetido: firstField(item, ['ISS Retido', 'iss_retido']) || '2',
      exigibilidadeIss: firstField(item, ['Exigibilidade ISS', 'exigibilidade_iss']) || '1',
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
      periodo: firstField(item, ['Período', 'periodo', 'competencia']),
      notasSolicitadas: firstField(item, ['Notas solicitadas', 'notas_solicitadas']),
      valores: firstField(item, ['Valores', 'valores', 'valor']),
      descricaoObrigatoria: firstField(item, ['Descrição obrigatória', 'descricao_obrigatoria', 'descricao']),
      status: firstField(item, ['Status', 'status']),
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
      cnpj: firstField(item, ['CNPJ', 'cnpj']),
      razaoSocial: firstField(item, ['Razão Social', 'razao_social']),
      nomeCurto: firstField(item, ['Nome Curto', 'nome_curto']),
      logradouro: firstField(item, ['Logradouro', 'logradouro', 'endereco']),
      numero: firstField(item, ['Número', 'numero']),
      complemento: firstField(item, ['Complemento', 'complemento']),
      bairro: firstField(item, ['Bairro', 'bairro']),
      codigoMunicipio: firstField(item, ['Cód. Município', 'codigo_municipio']),
      municipio: firstField(item, ['Município', 'municipio']),
      uf: firstField(item, ['UF', 'uf']),
      cep: firstField(item, ['CEP', 'cep']),
      email: firstField(item, ['E-mail', 'email']),
      categoriasConhecidas: firstField(item, ['Categorias Conhecidas', 'categorias_conhecidas']),
      statusHomologacao: firstField(item, ['Status Homologação', 'status_homologacao']),
      fonteEndereco: firstField(item, ['Fonte Endereço', 'fonte_endereco']),
      validadoEm: firstField(item, ['Validado Em', 'validado_em'])
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

function competenceDate(value) {
  const match = String(parseCompetencia(value) || '').match(/^(\d{2})\/(\d{4})$/);
  return match ? `${match[2]}-${match[1]}-01` : '';
}

function resolveMunicipioIbge(localPrestacao) {
  const norm = normalizeLabel(localPrestacao);
  if (norm.includes('guanhaes')) return '3128006';
  if (norm.includes('ipatinga')) return '3131307';
  if (norm.includes('itabira')) return '3131703';
  return '';
}

function buildUnsignedCandidateXml(candidate) {
  const itemLista = String(candidate.codigoTribNacional || '').split('.').slice(0, 2).join('.');
  const rpsNum = candidate.rpsNumero || '999999';
  const rpsSer = candidate.rpsSerie || 'A';
  const rpsTip = candidate.rpsTipo || '1';
  const xmlId = candidate.xmlId || `RPS${rpsNum}${rpsSer.replace(/[^A-Za-z0-9]/g, '')}`;
  const codMunPrestacao = candidate.codigoMunicipioPrestacao;
  const codMunIncidencia = candidate.codigoMunicipioIncidenciaIss;
  const issRetido = candidate.issRetido || '2';
  const exigibilidadeIss = candidate.exigibilidadeIss || '1';
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

  return `<GerarNfseEnvio xmlns="${CONFIG.ABRASF.SCHEMA_NAMESPACE}">` +
    `<Rps><InfDeclaracaoPrestacaoServico Id="${escapeXml(xmlId)}">` +
    `<Rps><IdentificacaoRps><Numero>${escapeXml(rpsNum)}</Numero><Serie>${escapeXml(rpsSer)}</Serie><Tipo>${escapeXml(rpsTip)}</Tipo></IdentificacaoRps>` +
    `<DataEmissao>${escapeXml(candidate.dataEmissao)}</DataEmissao><Status>1</Status></Rps>` +
    `<Competencia>${escapeXml(candidate.competenciaData)}</Competencia>` +
    `<Servico><Valores><ValorServicos>${candidate.valor.toFixed(2)}</ValorServicos></Valores>` +
    `<IssRetido>${escapeXml(issRetido)}</IssRetido><ItemListaServico>${escapeXml(itemLista)}</ItemListaServico>` +
    cnaeTag +
    `<CodigoTributacaoMunicipio>${escapeXml(candidate.codigoTribMunicipal)}</CodigoTributacaoMunicipio>` +
    `<Discriminacao>${escapeXml(candidate.descricao)}</Discriminacao>` +
    `<CodigoMunicipio>${escapeXml(codMunPrestacao)}</CodigoMunicipio>` +
    `<CodigoPais>1058</CodigoPais><ExigibilidadeISS>${escapeXml(exigibilidadeIss)}</ExigibilidadeISS><MunicipioIncidencia>${escapeXml(codMunIncidencia)}</MunicipioIncidencia>` +
    nbsTag +
    `</Servico>` +
    `<Prestador><CpfCnpj><Cnpj>${CONFIG.PRESTADOR.CNPJ_DIGITS}</Cnpj></CpfCnpj><InscricaoMunicipal>${CONFIG.PRESTADOR.INSCRICAO_MUNICIPAL}</InscricaoMunicipal></Prestador>` +
    `<TomadorServico><IdentificacaoTomador><CpfCnpj><Cnpj>${escapeXml(candidate.cnpjTomador)}</Cnpj></CpfCnpj></IdentificacaoTomador>` +
    `<RazaoSocial>${escapeXml(candidate.tomador)}</RazaoSocial>` +
    enderecoXml +
    `</TomadorServico>` +
    `<OptanteSimplesNacional>${CONFIG.PRESTADOR.OPTANTE_SIMPLES_NACIONAL}</OptanteSimplesNacional><IncentivoFiscal>2</IncentivoFiscal>` +
    `</InfDeclaracaoPrestacaoServico></Rps></GerarNfseEnvio>`;
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

function buildControlledCandidate({ requestId = 'fixture-controlada', environment = 'production', now = new Date() }) {
  const isProduction = environment === 'production';
  const descricao = isProduction
    ? 'Dr Túlio Athélio Sathler Siman: Referente a Plantões Médicos P.S SUS no Mês 08/2026- R$ 10,00. Banco Inter (077) Agência 0001 Conta 13618683-0 PIX CNPJ 31.302.407/0001-05'
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

  candidate.validationErrors = validateCandidate(candidate);
  candidate.xmlCandidate = buildUnsignedCandidateXml(candidate);

  return {
    operation: 'prepare',
    status: 'SUCCESS',
    validationStatus: candidate.validationErrors.length ? 'REVISAO_MANUAL' : 'READY_TO_ISSUE',
    requestId,
    candidates: [candidate],
    blockingReasons: candidate.validationErrors,
    warnings: []
  };
}

function buildHomologationFixture(requestId = 'fixture-homologation', now = new Date()) {
  return buildControlledCandidate({ requestId, environment: 'homologation', now });
}

function findMatchingPattern(categoria, patterns) {
  const normCat = normalizeLabel(categoria);
  return patterns.find(p => {
    const normPId = normalizeLabel(p.patternId);
    const normPNome = normalizeLabel(p.nome);
    const normPCat = normalizeLabel(p.categoria);
    return normCat.includes(normPId) || normCat.includes(normPNome) || normCat.includes(normPCat) ||
           normPNome.includes(normCat) || normPCat.includes(normCat);
  }) || null;
}

function findTomador(cnpj, tomadores) {
  const normCnpj = normalizeCnpj(cnpj);
  return tomadores.find(t => normalizeCnpj(t.cnpj) === normCnpj) || null;
}

function prepareDemand({ requestId, demandas, tomadores, patterns, notas = [], now = new Date() }) {
  const demanda = demandas.find(d => String(d.requestId).trim() === String(requestId).trim());
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

  // Se a demanda já foi emitida / concluída
  if (String(demanda.status).toUpperCase().includes('CONCLU') || (demanda.nfseResultantes && String(demanda.nfseResultantes).trim() !== '')) {
    return {
      operation: 'prepare',
      status: 'SUCCESS',
      validationStatus: 'ALREADY_ISSUED',
      requestId,
      candidates: [],
      blockingReasons: [],
      warnings: ['Demanda já consta como CONCLUÍDA na planilha']
    };
  }

  const blockingReasons = [];
  const warnings = [];

  const notasSolicitadas = splitList(demanda.notasSolicitadas);
  const valores = splitList(demanda.valores).map(parseCurrency);
  const descricoes = splitList(demanda.descricaoObrigatoria, notasSolicitadas.length);

  if (notasSolicitadas.length === 0) blockingReasons.push('NO_NOTES_REQUESTED');
  if (notasSolicitadas.length !== valores.length) blockingReasons.push('COUNTS_MISMATCH_NOTES_VS_VALUES');
  if (descricoes.length > 0 && descricoes.length !== notasSolicitadas.length) {
    blockingReasons.push('COUNTS_MISMATCH_DESCRIPTIONS');
  }

  const compDate = competenceDate(demanda.periodo);
  if (!compDate) blockingReasons.push('INVALID_DEMAND_COMPETENCE');

  const candidates = [];

  notasSolicitadas.forEach((catSolicitada, idx) => {
    const pattern = findMatchingPattern(catSolicitada, patterns);
    const valor = valores[idx] || 0;
    const descFromDemand = descricoes[idx] || '';

    if (!pattern) {
      blockingReasons.push('PATTERN_NOT_IDENTIFIED');
      blockingReasons.push(`PATTERN_NOT_FOUND_FOR_${normalizeLabel(catSolicitada)}`);
      return;
    }

    const tomador = findTomador(pattern.cnpjTomador, tomadores);
    if (!tomador) {
      blockingReasons.push(`TOMADOR_NOT_FOUND_FOR_${pattern.cnpjTomador}`);
      return;
    }

    let finalDescricao = '';
    let descriptionFromDemand = false;

    if (descFromDemand) {
      finalDescricao = descFromDemand;
      descriptionFromDemand = true;
    } else if (pattern.template) {
      finalDescricao = pattern.template
        .replace(/{MM\/AAAA}/g, parseCompetencia(demanda.periodo) || demanda.periodo)
        .replace(/{VALOR}/g, valor.toLocaleString('pt-BR', { minimumFractionDigits: 2 }))
        .replace(/{BLOCO_BANCARIO_VALIDADO}/g, 'Banco Inter (077) Agência 0001 Conta 13618683-0 PIX CNPJ 31.302.407/0001-05');
    }

    const codMunPrestacao = pattern.codigoMunicipioPrestacao || resolveMunicipioIbge(pattern.localPrestacao);
    const codMunIncidencia = pattern.codigoMunicipioIncidenciaIss;
    const issRetido = pattern.issRetido || '2';
    const exigibilidadeIss = pattern.exigibilidadeIss || '1';

    const candidate = {
      requestId,
      sequence: idx + 1,
      patternId: pattern.patternId,
      categoria: pattern.categoria || catSolicitada,
      tomador: tomador.razaoSocial || pattern.tomador,
      cnpjTomador: normalizeCnpj(tomador.cnpj || pattern.cnpjTomador),
      enderecoTomador: {
        logradouro: tomador.logradouro,
        numero: tomador.numero,
        complemento: tomador.complemento,
        bairro: tomador.bairro,
        codigoMunicipio: tomador.codigoMunicipio,
        uf: tomador.uf,
        cep: tomador.cep
      },
      valor,
      competencia: parseCompetencia(demanda.periodo) || demanda.periodo,
      competenciaData: compDate,
      descricao: finalDescricao,
      descriptionFromDemand,
      codigoTribNacional: pattern.codigoTribNacional,
      codigoTribMunicipal: pattern.codigoTribMunicipal,
      localPrestacao: pattern.localPrestacao,
      codigoMunicipioPrestacao: codMunPrestacao,
      codigoMunicipioIncidenciaIss: codMunIncidencia,
      issRetido: String(issRetido),
      exigibilidadeIss: String(exigibilidadeIss),
      nbs: pattern.nbs,
      codigoCnae: null,
      aliquotaIss: null,
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
