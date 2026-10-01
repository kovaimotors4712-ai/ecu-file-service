'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'https://local-test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'sb_publishable_local-test';
process.env.RAZORPAY_KEY_ID = 'rzp_test_LocalOnly123';
process.env.RAZORPAY_KEY_SECRET = 'test-only-not-a-real-secret-value';
process.env.PAYMENT_GATE_PROOF_SECRET = 'test-only-proof-secret-value-at-least-32-chars';
process.env.PAYMENT_GATE_SCHEMA_READY = 'true';
const paymentStateDir = path.join(os.tmpdir(), `efsi-payment-flow-test-${process.pid}`);
process.env.PAYMENT_STATE_DIR = paymentStateDir;
const { createHttpServer, setTestUpstreamRequest } = require('./server');

let server;
let baseUrl;
let paymentTestSequence = 0;

function upstreamResponse(status, payload) {
  const text = JSON.stringify(payload);
  const bytes = Buffer.from(text);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => name.toLowerCase() === 'content-type' ? 'application/json' : null },
    body: { cancel: async () => {} },
    json: async () => JSON.parse(text),
    text: async () => text,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function paymentFixture(configuration = {}) {
  const sequence = ++paymentTestSequence;
  const customerId = `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  const razorpayOrderId = `order_Test${sequence}Local`;
  const razorpayPaymentId = `pay_Test${sequence}Local`;
  const file = Buffer.from(`mock ECU upload ${sequence}`);
  const request = {
    category: 'ECU', vehicleBrand: 'Tata', vehicleType: 'Car', vehicleModel: 'Nexon',
    vehicleYear: '2022', ecuManufacturer: 'Bosch', ecuModel: 'MD1', readingTool: 'Kess',
    selectedServices: ['DTC OFF'], notes: 'Mock request', contactName: 'Test Customer',
    contactPhone: '+919876543210', contactEmail: 'test@example.invalid',
    originalName: 'test-ecu.bin', originalMime: 'application/octet-stream',
    originalSize: file.length, originalSha256: hash(file)
  };
  const calls = { orderCreate: null, razorpayOrderRead: 0, paymentRead: 0, rpc: null, storageUpload: 0 };
  const upstream = async (urlValue, options = {}) => {
    const url = new URL(urlValue);
    const method = options.method || 'GET';
    if (url.pathname === '/auth/v1/user') return upstreamResponse(200, { id: customerId });
    if (url.hostname === 'api.razorpay.com' && url.pathname === '/v1/orders' && method === 'POST') {
      calls.orderCreate = JSON.parse(options.body);
      return upstreamResponse(200, {
        id: razorpayOrderId, amount: calls.orderCreate.amount, currency: calls.orderCreate.currency,
        notes: calls.orderCreate.notes
      });
    }
    if (url.hostname === 'api.razorpay.com' && url.pathname === `/v1/orders/${razorpayOrderId}`) {
      calls.razorpayOrderRead += 1;
      return upstreamResponse(200, {
        id: razorpayOrderId, amount: calls.orderCreate.amount, currency: calls.orderCreate.currency,
        notes: calls.orderCreate.notes
      });
    }
    if (url.hostname === 'api.razorpay.com' && url.pathname === `/v1/payments/${razorpayPaymentId}`) {
      calls.paymentRead += 1;
      return upstreamResponse(200, {
        order_id: razorpayOrderId,
        status: configuration.paymentStatus || 'captured',
        amount: configuration.paymentAmount ?? calls.orderCreate.amount,
        currency: configuration.paymentCurrency || 'INR'
      });
    }
    if (url.pathname === '/rest/v1/rpc/efsi_create_paid_order') {
      calls.rpc = { body: JSON.parse(options.body), authorization: options.headers.Authorization };
      return upstreamResponse(configuration.rpcStatus ?? 200, configuration.rpcPayload ?? calls.rpc.body.p_order_id);
    }
    if (url.pathname.startsWith('/rest/v1/order_files')) {
      return upstreamResponse(method === 'GET' ? 200 : 201, method === 'GET' ? [] : {});
    }
    if (url.pathname.startsWith('/storage/v1/object/private-ecu-files/')) {
      if (method === 'GET') return upstreamResponse(404, { message: 'not found' });
      calls.storageUpload += 1;
      return upstreamResponse(200, {});
    }
    throw new Error(`Unexpected mocked upstream request: ${method} ${url.pathname}`);
  };
  return { customerId, razorpayOrderId, razorpayPaymentId, file, request, calls, upstream };
}

async function startPaymentTestServer(fixture) {
  await fs.rm(paymentStateDir, { recursive: true, force: true });
  setTestUpstreamRequest(fixture.upstream);
  const instance = createHttpServer();
  await new Promise((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(0, '127.0.0.1', resolve);
  });
  return {
    instance,
    url: `http://127.0.0.1:${instance.address().port}`
  };
}

async function stopPaymentTestServer(instance) {
  setTestUpstreamRequest(null);
  await new Promise((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
}

async function createAndVerify(fixture, base, { signature, request = fixture.request, skipCreate = false } = {}) {
  let createResponse = null;
  let createResult = null;
  if (!skipCreate) {
    createResponse = await fetch(`${base}/api/payment/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-customer-token' },
      body: JSON.stringify({ request: fixture.request })
    });
    createResult = await createResponse.json();
    if (!createResponse.ok) return { response: createResponse, result: createResult, createResponse, createResult };
  }
  const validSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${fixture.razorpayOrderId}|${fixture.razorpayPaymentId}`).digest('hex');
  const response = await fetch(`${base}/api/payment/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-customer-token' },
    body: JSON.stringify({
      razorpay_order_id: fixture.razorpayOrderId,
      razorpay_payment_id: fixture.razorpayPaymentId,
      razorpay_signature: signature || validSignature,
      request,
      fileBase64: fixture.file.toString('base64')
    })
  });
  return { response, result: await response.json(), createResponse, createResult, validSignature };
}

async function startIsolatedServer(overrides) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      SUPABASE_URL: 'https://local-test.supabase.co',
      SUPABASE_ANON_KEY: 'sb_publishable_local-test',
      RAZORPAY_KEY_ID: 'rzp_test_LocalOnly123',
      RAZORPAY_KEY_SECRET: 'test-only-not-a-real-secret-value',
      PAYMENT_GATE_PROOF_SECRET: 'test-only-proof-secret-value-at-least-32-chars',
      PAYMENT_GATE_SCHEMA_READY: 'false',
      PAYMENT_STATE_DIR: path.join(os.tmpdir(), `efsi-payment-state-test-${process.pid}-${port}`),
      ...overrides
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start in time.')), 5000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited during startup (${code}).`)); });
  });
  return { child, url: `http://127.0.0.1:${port}` };
}

test.before(async () => {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), PAYMENT_GATE_SCHEMA_READY: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start in time.')), 5000);
    server.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited during startup (${code}).`)); });
  });
});

test.after(async () => {
  if (server && !server.killed) server.kill();
  setTestUpstreamRequest(null);
  await fs.rm(paymentStateDir, { recursive: true, force: true });
});

test('serves the customer and admin pages', async () => {
  for (const route of ['/', '/admin.html']) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 200, `${route} should be served`);
  }
});

test('allows custom-domain and Render CORS origins and rejects other origins', async () => {
  for (const origin of ['https://ecufileservice.in', 'https://www.ecufileservice.in', 'https://ecu-file-service-india.onrender.com']) {
    const response = await fetch(`${baseUrl}/api/health`, { headers: { Origin: origin } });
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
  }
  const rejected = await fetch(`${baseUrl}/api/health`, { headers: { Origin: 'https://attacker.example' } });
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);
});

test('answers API preflight requests for allowed origins', async () => {
  const response = await fetch(`${baseUrl}/api/payment/create-order`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://ecufileservice.in',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type'
    }
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://ecufileservice.in');
});

test('does not serve project secrets, source, fixtures, or migrations', async () => {
  const routes = [
    '/.env', '/server.js', '/README.md', '/package-lock.json',
    '/TEST_ECU_FILE.bin', '/supabase/migrations/20260924_ecu_file_service.sql',
    '/supabase/migrations/20260924_razorpay_payment_gate.sql'
  ];
  for (const route of routes) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 404, `${route} must not be public`);
  }
});

test('serves pricing and reports payment disabled until schema readiness is explicit', async () => {
  const [pricingResponse, healthResponse] = await Promise.all([
    fetch(`${baseUrl}/api/pricing`),
    fetch(`${baseUrl}/api/health`)
  ]);
  assert.equal(pricingResponse.status, 200);
  const pricing = await pricingResponse.json();
  assert.equal(pricing.currency, 'INR');
  assert.ok(Number.isSafeInteger(pricing.fileVerificationPricePaise));
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.paymentConfigured, false);
  assert.equal(health.paymentReadiness.schemaReady, false);
  assert.ok(Object.values(health.paymentReadiness).every(value => typeof value === 'boolean'));
});

test('rejects payment-order creation while payment readiness is disabled', async () => {
  const response = await fetch(`${baseUrl}/api/payment/create-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(response.status, 503);
});

test('allows the explicit development Test Mode bypass without creating an order', async () => {
  const local = await startIsolatedServer({ NODE_ENV: 'development', PAYMENT_GATE_TEST_BYPASS: 'true' });
  try {
    const health = await fetch(`${local.url}/api/health`).then(response => response.json());
    assert.equal(health.paymentConfigured, true);
    const response = await fetch(`${local.url}/api/payment/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(response.status, 401);
  } finally { local.child.kill(); }
});

test('ignores the development bypass in production', async () => {
  const local = await startIsolatedServer({ NODE_ENV: 'production', PAYMENT_GATE_TEST_BYPASS: 'true' });
  try {
    const health = await fetch(`${local.url}/api/health`).then(response => response.json());
    assert.equal(health.paymentConfigured, false);
    const response = await fetch(`${local.url}/api/payment/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(response.status, 503);
  } finally { local.child.kill(); }
});

test('verified payment calls the paid-order RPC with the exact normalized contract and returns the created order', async () => {
  const fixture = paymentFixture();
  const local = await startPaymentTestServer(fixture);
  try {
    const { response, result } = await createAndVerify(fixture, local.url);
    assert.equal(response.status, 200);
    assert.deepEqual(result, { status: 'PAID', orderId: fixture.calls.orderCreate.notes.supabase_order_id });
    assert.equal(fixture.calls.paymentRead, 1);
    assert.equal(fixture.calls.storageUpload, 1);
    assert.deepEqual(Object.keys(fixture.calls.rpc.body), [
      'p_order_id', 'p_payment_order_id', 'p_payment_id', 'p_amount_paise',
      'p_request_sha256', 'p_payment_proof', 'p_order_json'
    ]);
    const rpcBody = fixture.calls.rpc.body;
    const requestJson = JSON.parse(rpcBody.p_order_json);
    assert.deepEqual(Object.keys(requestJson), [
      'category', 'vehicleBrand', 'vehicleType', 'vehicleModel', 'vehicleYear',
      'ecuManufacturer', 'ecuModel', 'readingTool', 'selectedServices', 'notes',
      'contactName', 'contactPhone', 'contactEmail', 'originalName', 'originalMime',
      'originalSize', 'originalSha256'
    ]);
    assert.equal(requestJson.vehicleYear, 2022);
    assert.equal(requestJson.originalSize, fixture.file.length);
    assert.equal(requestJson.originalSha256, hash(fixture.file));
    assert.equal(rpcBody.p_order_id, fixture.calls.orderCreate.notes.supabase_order_id);
    assert.equal(rpcBody.p_payment_order_id, fixture.razorpayOrderId);
    assert.equal(rpcBody.p_payment_id, fixture.razorpayPaymentId);
    assert.equal(rpcBody.p_amount_paise, fixture.calls.orderCreate.amount);
    assert.equal(rpcBody.p_request_sha256, fixture.calls.orderCreate.notes.request_sha256);
    assert.equal(hash(rpcBody.p_order_json), rpcBody.p_request_sha256);
    const proofPayload = [
      'EFSI_PAYMENT_CONFIRMATION_V1', fixture.customerId, rpcBody.p_order_id,
      fixture.razorpayOrderId, fixture.razorpayPaymentId, rpcBody.p_amount_paise,
      rpcBody.p_request_sha256
    ].join('|');
    assert.equal(rpcBody.p_payment_proof, crypto.createHmac('sha256', process.env.PAYMENT_GATE_PROOF_SECRET).update(proofPayload).digest('hex'));
    assert.equal(fixture.calls.rpc.authorization, 'Bearer test-customer-token');
  } finally { await stopPaymentTestServer(local.instance); }
});

test('recovers a paid callback after local payment state is lost', async () => {
  const fixture = paymentFixture();
  const local = await startPaymentTestServer(fixture);
  try {
    const createResponse = await fetch(`${local.url}/api/payment/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-customer-token' },
      body: JSON.stringify({ request: fixture.request })
    });
    assert.equal(createResponse.status, 200);
    await fs.rm(path.join(paymentStateDir, `${fixture.razorpayOrderId}.json`), { force: true });
    const { response, result } = await createAndVerify(fixture, local.url, { skipCreate: true });
    assert.equal(response.status, 200);
    assert.equal(result.status, 'PAID');
    assert.equal(fixture.calls.razorpayOrderRead, 1);
    assert.equal(fixture.calls.rpc.body.p_order_id, fixture.calls.orderCreate.notes.supabase_order_id);
  } finally { await stopPaymentTestServer(local.instance); }
});

test('recovers a legacy paid callback without creating another payment', async () => {
  const fixture = paymentFixture();
  fixture.calls.orderCreate = {
    amount: 9900,
    currency: 'INR',
    notes: {
      customer_id: fixture.customerId,
      request_sha256: hash(JSON.stringify({
        category: 'ECU', vehicleBrand: 'Tata', vehicleType: 'Car', vehicleModel: 'Nexon',
        vehicleYear: 2022, ecuManufacturer: 'Bosch', ecuModel: 'MD1', readingTool: 'Kess',
        selectedServices: ['DTC OFF'], notes: 'Mock request', contactName: 'Test Customer',
        contactPhone: '+919876543210', contactEmail: 'test@example.invalid',
        originalName: 'test-ecu.bin', originalMime: 'application/octet-stream',
        originalSize: fixture.file.length, originalSha256: hash(fixture.file)
      }))
    }
  };
  const local = await startPaymentTestServer(fixture);
  try {
    const { response, result } = await createAndVerify(fixture, local.url, { skipCreate: true });
    assert.equal(response.status, 200);
    assert.equal(result.status, 'PAID');
    assert.match(result.orderId, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(fixture.calls.razorpayOrderRead, 1);
    assert.equal(fixture.calls.orderCreate.notes.supabase_order_id, undefined);
  } finally { await stopPaymentTestServer(local.instance); }
});

test('logs a sanitized RPC failure and returns a safe retry response', async () => {
  const fixture = paymentFixture({
    rpcStatus: 400,
    rpcPayload: { code: '42501', message: 'Payment server proof is invalid for order_TestSafe1 test@example.invalid' }
  });
  const local = await startPaymentTestServer(fixture);
  const logged = [];
  const originalError = console.error;
  console.error = (...values) => logged.push(values);
  try {
    const { response, result, validSignature } = await createAndVerify(fixture, local.url);
    assert.equal(response.status, 502);
    assert.match(result.error, /do not pay again/i);
    assert.doesNotMatch(result.error, /42501|proof|test@example/i);
    const diagnostic = logged.find(([label]) => label === '[payment] paid-order RPC failed')?.[1];
    assert.equal(diagnostic.endpoint, '/api/payment/verify');
    assert.equal(diagnostic.operation, 'create_paid_order');
    assert.equal(diagnostic.rpcFunction, 'public.efsi_create_paid_order');
    assert.equal(diagnostic.httpStatus, 400);
    assert.equal(diagnostic.supabaseErrorCode, '42501');
    assert.equal(diagnostic.errorCategory, 'RPC_PROOF_INVALID');
    assert.doesNotMatch(JSON.stringify(diagnostic), /test@example\.invalid|order_Test|test-customer-token|[0-9a-f]{64}/i);
    assert.equal(JSON.stringify(diagnostic).includes(validSignature), false);
  } finally {
    console.error = originalError;
    await stopPaymentTestServer(local.instance);
  }
});

test('rejects a changed request hash before calling the RPC', async () => {
  const fixture = paymentFixture();
  const local = await startPaymentTestServer(fixture);
  try {
    const { response, result } = await createAndVerify(fixture, local.url, {
      request: { ...fixture.request, notes: 'Changed after checkout' }
    });
    assert.equal(response.status, 400);
    assert.match(result.error, /details changed/i);
    assert.equal(fixture.calls.rpc, null);
  } finally { await stopPaymentTestServer(local.instance); }
});

test('rejects an invalid payment signature before looking up payment status', async () => {
  const fixture = paymentFixture();
  const local = await startPaymentTestServer(fixture);
  try {
    const { response, result } = await createAndVerify(fixture, local.url, { signature: 'invalid' });
    assert.equal(response.status, 402);
    assert.match(result.error, /signature could not be verified/i);
    assert.equal(fixture.calls.paymentRead, 0);
    assert.equal(fixture.calls.rpc, null);
  } finally { await stopPaymentTestServer(local.instance); }
});

test('rejects a captured payment with the wrong amount', async () => {
  const fixture = paymentFixture({ paymentAmount: 1 });
  const local = await startPaymentTestServer(fixture);
  try {
    const { response, result } = await createAndVerify(fixture, local.url);
    assert.equal(response.status, 402);
    assert.match(result.error, /not confirmed as captured/i);
    assert.equal(fixture.calls.rpc, null);
  } finally { await stopPaymentTestServer(local.instance); }
});

test('rejects an authorized but uncaptured Razorpay payment', async () => {
  const fixture = paymentFixture({ paymentStatus: 'authorized' });
  const local = await startPaymentTestServer(fixture);
  try {
    const { response, result } = await createAndVerify(fixture, local.url);
    assert.equal(response.status, 402);
    assert.match(result.error, /not confirmed as captured/i);
    assert.equal(fixture.calls.rpc, null);
  } finally { await stopPaymentTestServer(local.instance); }
});

test('rejects unauthenticated verification without contacting upstream services', async () => {
  const fixture = paymentFixture();
  const local = await startPaymentTestServer(fixture);
  try {
    const response = await fetch(`${local.url}/api/payment/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(response.status, 401);
    assert.equal(fixture.calls.orderCreate, null);
    assert.equal(fixture.calls.rpc, null);
  } finally { await stopPaymentTestServer(local.instance); }
});

test('reports a malformed successful RPC response as a safe RPC failure', async () => {
  const fixture = paymentFixture({ rpcPayload: '20000000-0000-4000-8000-000000000000' });
  const local = await startPaymentTestServer(fixture);
  const logged = [];
  const originalError = console.error;
  console.error = (...values) => logged.push(values);
  try {
    const { response, result } = await createAndVerify(fixture, local.url);
    assert.equal(response.status, 502);
    assert.match(result.error, /could not be completed/i);
    assert.equal(logged.find(([label]) => label === '[payment] paid-order RPC failed')?.[1].errorCategory, 'RPC_UNKNOWN_ERROR');
  } finally {
    console.error = originalError;
    await stopPaymentTestServer(local.instance);
  }
});
