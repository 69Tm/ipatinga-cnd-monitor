'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseWsdlContract } = require('../wsdl');

console.log('Running test-wsdl.js...');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'ipatinga-wsdl-contract.xml'), 'utf8');
const contract = parseWsdlContract(fixture);
assert.strictEqual(contract.service, 'AbrasfService');
assert.strictEqual(contract.port, 'AbrasfPort');
assert.strictEqual(contract.binding, 'AbrasfBinding');
assert.strictEqual(contract.operation, 'ConsultarNfseFaixa');
assert.strictEqual(contract.soapAction, 'nfs#ConsultarNfseFaixa');
assert.strictEqual(contract.requestWrapper, 'ConsultarNfseFaixaRequest');
assert.deepStrictEqual(contract.requestFields, ['nfseCabecMsg', 'nfseDadosMsg']);
assert.throws(() => parseWsdlContract(fixture.replace('nfs#ConsultarNfseFaixa', 'wrong')), /WSDL_CONTRACT_MISMATCH/);
assert.throws(() => parseWsdlContract('<broken>'), /WSDL_INVALID_XML/);
console.log('✓ test-wsdl.js PASSED');
