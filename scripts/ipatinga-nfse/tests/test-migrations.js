'use strict';

const assert = require('assert');
const { transformLegacyLedgerRow, LEDGER_HEADERS, ensureLedgerSheet } = require('../ledger');
const { buildTomadoresRows, KNOWN_PATTERNS } = require('../patterns');

console.log('Running test-migrations.js...');

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

// 3. Testa migração da aba Tomadores v1 -> v2
const legacyTomadoresRows = [
  ['CNPJ', 'Razão Social', 'Nome Curto', 'Município', 'E-mail', 'Categorias Conhecidas', 'Status Homologação', 'Primeiro Uso', 'Último Uso', 'Qtd NFS-e'],
  ['20.724.357/0001-20', 'ASSOCIACAO DE CARIDADE NOSSA SENHORA DO CARMO', 'HIC', 'GUANHAES', 'financeiro@hicguanhaes.com.br', 'HIC', 'HOMOLOGADO', '01/2026', '08/2026', '11'],
  ['50.098.089/0001-49', 'CONSORCIO INTERMUNICIPAL DE SAUDE DA REGIAO DO MEDIO PIRACICABA - CISURG', 'CISURG', 'ITABIRA', 'samu192cisurg@gmail.com', 'CISURG', 'HOMOLOGADO', '06/2026', '08/2026', '4']
];

const migratedTomadores = buildTomadoresRows([], legacyTomadoresRows);
assert.strictEqual(migratedTomadores.length, 3);
assert.strictEqual(migratedTomadores[0].length, 19);
// Verifica HIC
assert.strictEqual(migratedTomadores[1][0], '20.724.357/0001-20');
assert.strictEqual(migratedTomadores[1][2], 'HIC Guanhães');
assert.strictEqual(migratedTomadores[1][3], 'CAPITAO BERNARDO');
assert.strictEqual(migratedTomadores[1][4], '257');
assert.strictEqual(migratedTomadores[1][7], '3128006');
assert.strictEqual(migratedTomadores[1][11], 'financeiro@hicguanhaes.com.br', 'E-mail preservado na coluna L');
assert.strictEqual(migratedTomadores[1][18], 11, 'Qtd NFS-e preservada na coluna S');

// Verifica CISURG
assert.strictEqual(migratedTomadores[2][0], '50.098.089/0001-49');
assert.strictEqual(migratedTomadores[2][2], 'CISURG Médio Piracicaba');
assert.strictEqual(migratedTomadores[2][3], 'RUA SAO PAULO');
assert.strictEqual(migratedTomadores[2][4], '377');
assert.strictEqual(migratedTomadores[2][7], '3131703');
assert.strictEqual(migratedTomadores[2][11], 'samu192cisurg@gmail.com', 'E-mail CISURG preservado na coluna L');
assert.strictEqual(migratedTomadores[2][18], 4, 'Qtd NFS-e CISURG preservada');

console.log('✓ test-migrations.js PASSED');
