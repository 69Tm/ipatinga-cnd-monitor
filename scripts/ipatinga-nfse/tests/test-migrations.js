'use strict';

const assert = require('assert');
const { transformLegacyLedgerRow, LEDGER_HEADERS, migrateHistoricalLedgerStorage, RPS_STATUS } = require('../ledger');
const { buildTomadoresRows, KNOWN_PATTERNS } = require('../patterns');

console.log('Running test-migrations.js...');

async function run() {
  // 1. Testa migração da aba RPS v1 -> v2 (onde coluna M era erro legado)
  const legacyRow13 = [
    'homologation', 'fixture-homologation-live-2', '1', '1003', 'A', '1',
    'SUBMITTED_ASYNC_PROCESSING', '2026-08-22T15:00:00Z', '2026-08-22T15:00:05Z',
    '', '', '2026-08-22T15:00:10Z', 'TIMEOUT_ON_GERARNFSE'
  ];

  const transformed13 = transformLegacyLedgerRow(legacyRow13);
  assert.strictEqual(transformed13.length, LEDGER_HEADERS.length);
  assert.strictEqual(transformed13[12], '1', 'attempt_count deve ser 1 para submetido');
  assert.strictEqual(transformed13[13], '2026-08-22T15:00:05Z', 'last_attempt_at preservado');
  assert.strictEqual(transformed13[16], 'TIMEOUT_ON_GERARNFSE', 'error legado preservado na coluna Q');

  // 2. Testa caso onde houve shift acidental (attempt_count continha string de erro)
  const corruptedRow = [
    'homologation', 'fixture-homologation-live-3', '1', '1004', 'A', '1',
    'REJECTED_CORRECTABLE', '2026-08-22T15:00:00Z', '2026-08-22T15:00:05Z',
    '', '', '2026-08-22T15:00:10Z', 'ERRO_SCHEMA_EL78', '', '', '', ''
  ];
  const transformedCorrupted = transformLegacyLedgerRow(corruptedRow);
  assert.strictEqual(transformedCorrupted[12], '1', 'attempt_count numérico corrigido');
  assert.strictEqual(transformedCorrupted[16], 'ERRO_SCHEMA_EL78', 'error restaurado');

  // 3. Testa migrateHistoricalLedgerStorage
  const mockStorageToMigrate = [
    LEDGER_HEADERS,
    ['production', 'fixture-controlada-prod-1787530132367', '1', '101', 'A', '1', 'FAILED_SAFE', '2026-08-23T22:00:00Z', '2026-08-23T22:00:01Z', '', '', '', '1', '2026-08-23T22:00:01Z', '', '', 'SOAP_HTTP_ERROR_500: SOAP-ERROR: Parsing WSDL: Couldn\'t load from https://abrasfipatinga.meumunicipio.online/ws/nfs?wsdl'],
    ['production', 'fixture-controlada-prod-rejeitado', '1', '102', 'A', '1', 'FAILED_SAFE', '2026-08-23T22:00:00Z', '2026-08-23T22:00:01Z', '', '', '', '5', '2026-08-23T22:00:01Z', 'E10', 'Erro fiscal não deve migrar', 'ERRO_FISCAL_DETERMINISTICO']
  ];

  let updateCalled = false;
  const migRes = await migrateHistoricalLedgerStorage({
    spreadsheetId: 'mock-ss-id',
    readSheetValues: async () => mockStorageToMigrate,
    updateSheetValues: async (_id, range, rows) => {
      updateCalled = true;
      if (range.includes('A2:Q2')) {
        mockStorageToMigrate[1] = rows[0];
      }
    }
  });

  assert.strictEqual(migRes.migratedCount, 1, 'Deve migrar exatamente a linha 101 com falha de infra');
  assert.strictEqual(updateCalled, true);
  assert.strictEqual(mockStorageToMigrate[1][6], RPS_STATUS.PROVIDER_INFRA_UNAVAILABLE, 'RPS 101 migrado para PROVIDER_INFRA_UNAVAILABLE');
  assert.strictEqual(mockStorageToMigrate[1][3], '101');
  assert.strictEqual(mockStorageToMigrate[2][6], 'FAILED_SAFE', 'Erro fiscal deve permanecer FAILED_SAFE');

  // 4. Testa migração da aba Tomadores v1 -> v2 com caso regressivo de complemento
  const legacyTomadoresWithCorruptedComplemento = [
    ['CNPJ', 'Razão Social', 'Nome Curto', 'Logradouro', 'Número', 'Complemento', 'Bairro', 'Cód. Município', 'Município', 'UF', 'CEP', 'E-mail', 'Categorias Conhecidas', 'Status Homologação', 'Fonte Endereço', 'Validado Em', 'Primeiro Uso', 'Último Uso', 'Qtd NFS-e'],
    ['20.724.357/0001-20', 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO', 'HIC', 'CAPITAO BERNARDO', '257', 'HIC — Plantões Médicos PS SUS', 'CENTRO', '3128006', 'Guanhães', 'MG', '39740000', 'financeiro@hicguanhaes.com.br', 'HIC', 'HOMOLOGADO', 'NFS-e histórica', '2026-08-22', '01/2026', '08/2026', '11'],
    ['50.098.089/0001-49', 'CONSORCIO PUBLICO INTERMUNICIPAL DE SAUDE PARA GERENCIAMENTO DOS SERVICOS DE URGENCIA E EMERGENCIA DA REGIAO DO MEDIO PIRACICABA', 'CISURG', 'RUA SAO PAULO', '377', 'CISURG — Plantão médico presencial', 'AMAZONAS', '3131703', 'Itabira', 'MG', '35900352', 'samu192cisurg@gmail.com', 'CISURG', 'HOMOLOGADO', 'Portal Oficial CISURG', '2026-08-22', '06/2026', '08/2026', '4']
  ];

  const migratedTomadores = buildTomadoresRows([], legacyTomadoresWithCorruptedComplemento);
  assert.strictEqual(migratedTomadores.length, 3);
  assert.strictEqual(migratedTomadores[0].length, 19);

  // Verifica HIC
  const hic = migratedTomadores[1];
  assert.strictEqual(hic[0], '20.724.357/0001-20');
  assert.strictEqual(hic[1], 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO');
  assert.strictEqual(hic[2], 'HIC Guanhães');
  assert.strictEqual(hic[3], 'CAPITAO BERNARDO');
  assert.strictEqual(hic[4], '257');
  assert.strictEqual(hic[5], '', 'Complemento HIC deve ser estritamente vazio');
  assert.strictEqual(hic[6], 'CENTRO');
  assert.strictEqual(hic[7], '3128006');
  assert.strictEqual(hic[8], 'Guanhães');
  assert.strictEqual(hic[9], 'MG');
  assert.strictEqual(hic[10], '39740000');
  assert.strictEqual(hic[11], 'financeiro@hicguanhaes.com.br');
  assert.strictEqual(hic[12], 'HIC — Plantões Médicos PS SUS, HIC — Produção PS SUS');
  assert.strictEqual(hic[13], 'HOMOLOGADO');
  assert.strictEqual(hic[14], 'NFS-e histórica DEXMED');
  assert.strictEqual(hic[15], '2026-08-22');
  assert.strictEqual(hic[16], '01/2026');
  assert.strictEqual(hic[17], '08/2026');
  assert.strictEqual(hic[18], 11);

  // Verifica CISURG
  const cisurg = migratedTomadores[2];
  assert.strictEqual(cisurg[0], '50.098.089/0001-49');
  assert.strictEqual(cisurg[1], 'CONSORCIO PUBLICO INTERMUNICIPAL DE SAUDE PARA GERENCIAMENTO DOS SERVICOS DE URGENCIA E EMERGENCIA DA REGIAO DO MEDIO PIRACICABA');
  assert.strictEqual(cisurg[2], 'CISURG Médio Piracicaba');
  assert.strictEqual(cisurg[3], 'RUA SAO PAULO');
  assert.strictEqual(cisurg[4], '377');
  assert.strictEqual(cisurg[5], '', 'Complemento CISURG deve ser estritamente vazio');
  assert.strictEqual(cisurg[6], 'AMAZONAS');
  assert.strictEqual(cisurg[7], '3131703');
  assert.strictEqual(cisurg[8], 'Itabira');
  assert.strictEqual(cisurg[9], 'MG');
  assert.strictEqual(cisurg[10], '35900352');
  assert.strictEqual(cisurg[11], 'samu192cisurg@gmail.com');
  assert.strictEqual(cisurg[12], 'CISURG — Plantão médico presencial');
  assert.strictEqual(cisurg[13], 'HOMOLOGADO');
  assert.strictEqual(cisurg[14], 'Portal Oficial CISURG');
  assert.strictEqual(cisurg[15], '2026-08-22');
  assert.strictEqual(cisurg[16], '06/2026');
  assert.strictEqual(cisurg[17], '08/2026');
  assert.strictEqual(cisurg[18], 4);

  console.log('✓ test-migrations.js PASSED');
}

module.exports = run();
