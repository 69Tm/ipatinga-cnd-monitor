'use strict';

console.log('====================================================');
console.log('   INICIANDO BATERIA DE TESTES UNITARIOS NFS-E     ');
console.log('====================================================');

try {
  require('./test-validators');
  require('./test-xml');
  require('./test-sync');
  require('./test-patterns');
  console.log('\n🎉 TODOS OS TESTES PASSARAM COM SUCESSO! ✅\n');
} catch (err) {
  console.error('\n❌ FALHA NOS TESTES:', err);
  process.exit(1);
}
