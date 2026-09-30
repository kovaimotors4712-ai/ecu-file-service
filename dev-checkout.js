'use strict';

if (process.env.NODE_ENV !== 'development') {
  console.error('Checkout test server requires NODE_ENV=development.');
  process.exit(1);
}

process.env.PAYMENT_GATE_TEST_BYPASS = 'true';
require('./server');
