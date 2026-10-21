'use strict';

const { routeProvider } = require('./provider-router');

class LegacyAbrasfProvider {
  constructor({ issueDate, callSoapOperation }) {
    this.issueDate = issueDate;
    this.callSoapOperation = callSoapOperation;
  }

  async submit(args) {
    const route = routeProvider({ taxRegime: 'SIMPLES_NACIONAL', emissionDate: this.issueDate });
    if (route.provider !== 'LEGACY_ABRASF' || !route.writeAllowed) {
      throw new Error('LEGACY_ABRASF_WRITER_DISABLED_FOR_CURRENT_DEXMED');
    }
    if (typeof this.callSoapOperation !== 'function') throw new Error('LEGACY_ABRASF_TRANSPORT_MISSING');
    return this.callSoapOperation(args);
  }
}

module.exports = { LegacyAbrasfProvider };
