'use strict';

console.log('====================================================');
console.log('   INICIANDO BATERIA DE TESTES UNITARIOS NFS-E     ');
console.log('====================================================');

async function run() {
  try {
    await require('./test-validators');
    await require('./test-xml');
    await require('./test-xsd');
    await require('./test-xmldsig');
    await require('./test-ledger');
    await require('./test-migrations');
    await require('./test-sync');
    await require('./test-sheets');
    await require('./test-soap');
    await require('./test-wsdl');
    await require('./test-certificate');
    await require('./test-safety');
    await require('./test-preflight');
    await require('./test-fiscal-xml');
    await require('./test-patterns');
    await require('./test-report');
    await require('./test-prepare');
    await require('./test-issue');
    await require('./test-apps-script-engine');
    await require('./test-gmail-api-adapter');
    console.log('\n🎉 TODOS OS TESTES PASSARAM COM SUCESSO! ✅\n');
  } catch (err) {
    console.error('\n❌ FALHA NOS TESTES:', err);
    process.exit(1);
  }
}
run();
