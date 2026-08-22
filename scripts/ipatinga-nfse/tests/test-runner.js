'use strict';

console.log('====================================================');
console.log('   INICIANDO BATERIA DE TESTES UNITARIOS NFS-E     ');
console.log('====================================================');

async function run() {
 try {
  await require('./test-validators');
  await require('./test-xml');
  await require('./test-sync');
  await require('./test-sheets');
  await require('./test-soap');
  await require('./test-wsdl');
  await require('./test-certificate');
  await require('./test-safety');
  await require('./test-patterns');
  await require('./test-report');
  console.log('\n🎉 TODOS OS TESTES PASSARAM COM SUCESSO! ✅\n');
 } catch (err) {
  console.error('\n❌ FALHA NOS TESTES:', err);
  process.exit(1);
 }
}
run();
