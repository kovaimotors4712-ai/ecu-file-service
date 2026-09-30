'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let server;
let baseUrl;

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

test.after(() => {
  if (server && !server.killed) server.kill();
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
  assert.equal((await healthResponse.json()).paymentConfigured, false);
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
