'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { extractSoapOutput, callSoapOperation } = require('../soap');

console.log('Running test-soap.js...');

const validCert = { loaded: true, isValid: true, pemCert: 'cert', pemKey: 'key' };
const abrXml = '<ConsultarNfseFaixaResposta xmlns="http://www.abrasf.org.br/nfse.xsd"><ListaNfse/></ConsultarNfseFaixaResposta>';
const escaped = abrXml.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const okEnvelope = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ConsultarNfseFaixaResponse><ConsultarNfseFaixaResponse><outputXML>${escaped}</outputXML></ConsultarNfseFaixaResponse></ConsultarNfseFaixaResponse></soap:Body></soap:Envelope>`;
assert.strictEqual(extractSoapOutput(okEnvelope, 'ConsultarNfseFaixa'), abrXml);
assert.throws(() => extractSoapOutput('<broken>', 'ConsultarNfseFaixa'), /XML_INVALID/);
assert.throws(() => extractSoapOutput('<Envelope><Body/></Envelope>', 'ConsultarNfseFaixa'), /SOAP_OUTPUT_MISSING/);
assert.throws(() => extractSoapOutput('<Envelope><Body><Fault><faultcode>S</faultcode><faultstring>Falha</faultstring></Fault></Body></Envelope>', 'ConsultarNfseFaixa'), /SOAP_FAULT/);
const largeInnerXml = `<ConsultarNfseFaixaResposta>${'<CompNfse><Nfse/></CompNfse>'.repeat(1200)}</ConsultarNfseFaixaResposta>`;
const largeEscaped = largeInnerXml.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const largeEnvelope = `<Envelope><Body><ConsultarNfseFaixaResponse><outputXML>${largeEscaped}</outputXML></ConsultarNfseFaixaResponse></Body></Envelope>`;
assert.strictEqual(extractSoapOutput(largeEnvelope, 'ConsultarNfseFaixa'), largeInnerXml);

function transportFor({ status = 200, body = okEnvelope, error = null, timeout = false }) {
  return {
    request(...args) {
      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : () => {};
      const request = new EventEmitter();
      request.write = () => {};
      request.destroy = err => request.emit('error', err);
      request.setTimeout = (ms, cb) => {
        if (timeout && typeof cb === 'function') queueMicrotask(cb);
      };
      request.end = () => queueMicrotask(() => {
        if (timeout) return;
        if (error) return request.emit('error', new Error(error));
        const response = new EventEmitter();
        response.statusCode = status;
        response.setEncoding = () => {};
        callback(response);
        queueMicrotask(() => { response.emit('data', body); response.emit('end'); });
      });
      return request;
    }
  };
}

async function invoke(transport) {
  return callSoapOperation({
    environment: 'production', operation: 'ConsultarNfseFaixa',
    cabecMsg: '<cabecalho/>', dadosMsg: '<dados/>', certData: validCert, transport, timeoutMs: 5
  });
}

async function run() {
  assert.strictEqual((await invoke(transportFor({}))).statusCode, 200);
  await assert.rejects(invoke(transportFor({ status: 500, body: 'erro' })), /SOAP_HTTP_ERROR/);
  await assert.rejects(invoke(transportFor({ error: 'ECONNRESET' })), /SOAP_TRANSPORT_ERROR.*ECONNRESET/);
  await assert.rejects(invoke(transportFor({ timeout: true })), /SOAP_TRANSPORT_ERROR.*SOAP_TIMEOUT/);
  await assert.rejects(invoke(transportFor({ body: '<invalid>' })), /XML_INVALID|SOAP_OUTPUT_MISSING/);
  
  // Operação não suportada
  await assert.rejects(callSoapOperation({ environment: 'production', operation: 'OperacaoInexistente', certData: validCert }), /SOAP_OPERATION_NOT_ALLOWED/);
  
  // Kill switch em GerarNfse
  process.env.NFE_ISSUE_KILL_SWITCH = 'true';
  await assert.rejects(callSoapOperation({ environment: 'production', operation: 'GerarNfse', certData: validCert }), /NFE_ISSUE_KILL_SWITCH_ACTIVE/);
  process.env.NFE_ISSUE_KILL_SWITCH = 'false';

  console.log('✓ test-soap.js PASSED');
}

module.exports = run();
