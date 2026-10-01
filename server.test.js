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

function upstreamBinaryResponse(status, value) {
  const bytes = Buffer.from(value);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => name.toLowerCase() === 'content-type' ? 'application/octet-stream' : null },
    body: { cancel: async () => {} },
    json: async () => { throw new Error('Binary upstream response is not JSON.'); },
    text: async () => bytes.toString('utf8'),
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
  const calls = { orderCreate: null, razorpayOrderRead: 0, paymentRead: 0, rpc: null, rpcCount: 0, storageUpload: 0 };
  const localDatabase = { orders: new Map(), orderFiles: new Map(), objects: new Map() };
  const adminId = '20000000-0000-4000-8000-000000000001';
  const otherCustomerId = '30000000-0000-4000-8000-000000000001';
  const identity = options => {
    const authorization = options?.headers?.Authorization || options?.headers?.authorization || '';
    const token = String(authorization).replace(/^Bearer\s+/i, '');
    if (token === 'test-admin-token') return { id: adminId, role: 'admin' };
    if (token === 'test-other-customer-token') return { id: otherCustomerId, role: 'customer' };
    if (token === 'test-customer-token') return { id: customerId, role: 'customer' };
    return null;
  };
  const orderFilesFor = orderId => [...localDatabase.orderFiles.values()].filter(file => file.order_id === orderId);
  const upstream = async (urlValue, options = {}) => {
    const url = new URL(urlValue);
    const method = options.method || 'GET';
    if (url.pathname === '/auth/v1/user') {
      const user = identity(options);
      return user
        ? upstreamResponse(200, { id: user.id, app_metadata: user.role === 'admin' ? { role: 'admin' } : {} })
        : upstreamResponse(401, { message: 'Invalid test session.' });
    }
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
      calls.rpcCount += 1;
      calls.rpc = { body: JSON.parse(options.body), authorization: options.headers.Authorization };
      if (configuration.fullOrderStore) {
        const user = identity(options);
        const rpc = calls.rpc.body;
        if (!user || user.role !== 'customer' || user.id !== customerId) return upstreamResponse(401, { code: '42501', message: 'Authentication required.' });
        if (hash(rpc.p_order_json) !== rpc.p_request_sha256) return upstreamResponse(400, { code: '22023', message: 'Request hash mismatch.' });
        const proofPayload = ['EFSI_PAYMENT_CONFIRMATION_V1', user.id, rpc.p_order_id, rpc.p_payment_order_id, rpc.p_payment_id, rpc.p_amount_paise, rpc.p_request_sha256].join('|');
        const expectedProof = crypto.createHmac('sha256', process.env.PAYMENT_GATE_PROOF_SECRET).update(proofPayload).digest('hex');
        if (rpc.p_payment_proof !== expectedProof) return upstreamResponse(403, { code: '42501', message: 'Payment server proof is invalid.' });
        const existing = localDatabase.orders.get(rpc.p_order_id);
        if (existing) {
          if (existing.customer_id === user.id && existing.razorpay_order_id === rpc.p_payment_order_id && existing.razorpay_payment_id === rpc.p_payment_id && existing.payment_request_sha256 === rpc.p_request_sha256) return upstreamResponse(200, rpc.p_order_id);
          return upstreamResponse(409, { code: '23505', message: 'Order reference already exists.' });
        }
        if ([...localDatabase.orders.values()].some(order => order.razorpay_order_id === rpc.p_payment_order_id || order.razorpay_payment_id === rpc.p_payment_id)) return upstreamResponse(409, { code: '23505', message: 'Payment reference already used.' });
        const request = JSON.parse(rpc.p_order_json);
        const notes = [
          request.notes,
          `[EFSI_PRICE_SNAPSHOT_V1]\nfile_verification_paise=${rpc.p_amount_paise}`,
          `[EFSI_PAYMENT_V1]\npayment_status=PAID\npayment_provider=razorpay\nrazorpay_order_id=${rpc.p_payment_order_id}\nrazorpay_payment_id=${rpc.p_payment_id}\nrequest_sha256=${rpc.p_request_sha256}\npayment_proof=${expectedProof}`
        ].filter(Boolean).join('\n\n');
        localDatabase.orders.set(rpc.p_order_id, {
          id: rpc.p_order_id, customer_id: user.id, status: 'New', category: request.category,
          vehicle_brand: request.vehicleBrand, vehicle_type: request.vehicleType,
          vehicle_model: request.vehicleModel, vehicle_year: request.vehicleYear,
          ecu_manufacturer: request.ecuManufacturer, ecu_model: request.ecuModel,
          reading_tool: request.readingTool, selected_services: request.selectedServices,
          notes, contact_name: request.contactName, contact_phone: request.contactPhone,
          contact_email: request.contactEmail, payment_status: 'PAID',
          razorpay_order_id: rpc.p_payment_order_id, razorpay_payment_id: rpc.p_payment_id,
          verification_amount_paise: rpc.p_amount_paise, payment_request_sha256: rpc.p_request_sha256,
          paid_at: new Date().toISOString(), created_at: new Date().toISOString()
        });
        return upstreamResponse(200, rpc.p_order_id);
      }
      return upstreamResponse(configuration.rpcStatus ?? 200, configuration.rpcPayload ?? calls.rpc.body.p_order_id);
    }
    if (configuration.fullOrderStore && url.pathname === '/rest/v1/orders') {
      const user = identity(options);
      if (!user) return upstreamResponse(401, { message: 'Authentication required.' });
      if (method === 'GET') {
        let rows = [...localDatabase.orders.values()].filter(order => user.role === 'admin' || order.customer_id === user.id);
        const customerFilter = url.searchParams.get('customer_id');
        if (customerFilter?.startsWith('eq.')) rows = rows.filter(order => order.customer_id === customerFilter.slice(3));
        const idFilter = url.searchParams.get('id');
        if (idFilter?.startsWith('eq.')) rows = rows.filter(order => order.id === idFilter.slice(3));
        if (idFilter?.startsWith('in.(')) {
          const ids = idFilter.slice(4, -1).split(',');
          rows = rows.filter(order => ids.includes(order.id));
        }
        return upstreamResponse(200, rows.map(order => ({ ...order, order_files: orderFilesFor(order.id) })));
      }
      if (method === 'PATCH') {
        if (user.role !== 'admin') return upstreamResponse(403, { message: 'Row-level security denied order update.' });
        const idFilter = url.searchParams.get('id') || '';
        const order = localDatabase.orders.get(idFilter.replace(/^eq\./, ''));
        if (!order) return upstreamResponse(404, { message: 'Order not found.' });
        const next = JSON.parse(options.body).status;
        const allowed = ({ New: 'File Review', 'File Review': 'Processing', Processing: 'Completed' })[order.status];
        if (next !== allowed || (next === 'Completed' && !orderFilesFor(order.id).some(file => file.kind === 'processed'))) return upstreamResponse(400, { code: '23514', message: 'Invalid order status transition.' });
        order.status = next;
        return upstreamResponse(204, null);
      }
    }
    if (configuration.fullOrderStore && url.pathname === '/rest/v1/order_files') {
      const user = identity(options);
      if (!user) return upstreamResponse(401, { message: 'Authentication required.' });
      if (method === 'GET') {
        let rows = [...localDatabase.orderFiles.values()].filter(file => user.role === 'admin' || file.owner_id === user.id);
        const objectPathFilter = url.searchParams.get('object_path');
        if (objectPathFilter?.startsWith('eq.')) rows = rows.filter(file => file.object_path === objectPathFilter.slice(3));
        return upstreamResponse(200, rows);
      }
      if (method === 'POST') {
        const file = JSON.parse(options.body);
        const order = localDatabase.orders.get(file.order_id);
        const isOriginalOwner = user.role === 'customer' && order?.customer_id === user.id && order.payment_status === 'PAID' && file.kind === 'original' && file.owner_id === user.id && file.uploaded_by === user.id && file.object_path.startsWith(`${user.id}/${file.order_id}/original/`);
        const isAuthorizedAdmin = user.role === 'admin' && order && order.customer_id === file.owner_id && file.uploaded_by === user.id && file.kind === 'processed' && file.object_path.startsWith(`${order.customer_id}/${file.order_id}/processed/`);
        if (!isOriginalOwner && !isAuthorizedAdmin) return upstreamResponse(403, { message: 'Row-level security denied order-file registration.' });
        if ([...localDatabase.orderFiles.values()].some(existing => existing.object_path === file.object_path)) return upstreamResponse(409, { code: '23505', message: 'Object path already registered.' });
        const stored = { ...file, id: crypto.randomUUID(), created_at: new Date().toISOString() };
        localDatabase.orderFiles.set(stored.id, stored);
        return upstreamResponse(201, stored);
      }
    }
    if (configuration.fullOrderStore && url.pathname.startsWith('/storage/v1/object/private-ecu-files/')) {
      const user = identity(options);
      if (!user) return upstreamResponse(401, { message: 'Authentication required.' });
      const objectPath = url.pathname.split('/').slice(5).map(decodeURIComponent).join('/');
      const parts = objectPath.split('/');
      const order = localDatabase.orders.get(parts[1]);
      if (!order) return upstreamResponse(404, { message: 'Object not found.' });
      if (method === 'GET') {
        const file = [...localDatabase.orderFiles.values()].find(item => item.object_path === objectPath);
        if (!file || (user.role !== 'admin' && order.customer_id !== user.id)) return upstreamResponse(404, { message: 'Object not found.' });
        const object = localDatabase.objects.get(objectPath);
        return object ? upstreamBinaryResponse(200, object) : upstreamResponse(404, { message: 'Object not found.' });
      }
      if (method === 'POST') {
        const isOriginalOwner = user.role === 'customer' && user.id === order.customer_id && order.status === 'New' && order.payment_status === 'PAID' && parts[0] === user.id && parts[2] === 'original';
        const isAuthorizedAdmin = user.role === 'admin' && parts[0] === order.customer_id && (parts[2] === 'original' || parts[2] === 'processed');
        if (!isOriginalOwner && !isAuthorizedAdmin) return upstreamResponse(403, { message: 'Storage row-level security denied upload.' });
        if (localDatabase.objects.has(objectPath)) return upstreamResponse(409, { message: 'Object already exists.' });
        localDatabase.objects.set(objectPath, Buffer.from(options.body));
        calls.storageUpload += 1;
        return upstreamResponse(200, {});
      }
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
  return { customerId, adminId, otherCustomerId, razorpayOrderId, razorpayPaymentId, file, request, calls, localDatabase, upstream };
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

test('full mocked payment-to-delivery lifecycle keeps the order private and idempotent', async () => {
  const fixture = paymentFixture({ fullOrderStore: true });
  fixture.file = await fs.readFile(path.join(__dirname, 'TEST_ECU_FILE.bin'));
  fixture.request.originalName = 'TEST_ECU_FILE.bin';
  fixture.request.originalSize = fixture.file.length;
  fixture.request.originalSha256 = hash(fixture.file);
  const local = await startPaymentTestServer(fixture);
  const customerHeaders = { Authorization: 'Bearer test-customer-token' };
  const adminHeaders = { Authorization: 'Bearer test-admin-token' };
  const customerOrders = id => `${local.url}/api/supabase/rest/v1/orders?select=*,order_files!order_files_order_id_fkey(*)&customer_id=eq.${encodeURIComponent(id)}&order=created_at.desc&limit=50`;
  const orderFiles = `${local.url}/api/supabase/rest/v1/order_files`;
  const storageUrl = objectPath => `${local.url}/api/supabase/storage/v1/object/private-ecu-files/${objectPath.split('/').map(encodeURIComponent).join('/')}`;
  try {
    const first = await createAndVerify(fixture, local.url);
    assert.equal(first.response.status, 200);
    assert.deepEqual(first.result, { status: 'PAID', orderId: fixture.calls.orderCreate.notes.supabase_order_id });
    assert.equal(fixture.calls.paymentRead, 1);
    assert.equal(fixture.calls.rpcCount, 1);
    assert.equal(fixture.localDatabase.orders.size, 1);

    const orderId = first.result.orderId;
    const order = fixture.localDatabase.orders.get(orderId);
    assert.equal(order.customer_id, fixture.customerId);
    assert.equal(order.status, 'New');
    assert.equal(order.payment_status, 'PAID');
    assert.equal(order.verification_amount_paise, 9900);
    assert.equal(order.razorpay_order_id, fixture.razorpayOrderId);
    assert.equal(order.razorpay_payment_id, fixture.razorpayPaymentId);
    assert.equal(order.payment_request_sha256, fixture.calls.orderCreate.notes.request_sha256);

    const adminVerification = await fetch(`${local.url}/api/admin/payment-status`, {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderIds: [orderId] })
    });
    assert.equal(adminVerification.status, 200);
    assert.deepEqual(await adminVerification.json(), { verified: { [orderId]: true } });

    const adminOrderResponse = await fetch(`${local.url}/api/supabase/rest/v1/orders?select=*,order_files!order_files_order_id_fkey(*)&order=created_at.desc`, { headers: adminHeaders });
    assert.equal(adminOrderResponse.status, 200);
    const adminOrders = await adminOrderResponse.json();
    assert.equal(adminOrders.length, 1);
    const originalRecord = adminOrders[0].order_files.find(file => file.kind === 'original');
    assert.ok(originalRecord);
    const originalDownload = await fetch(storageUrl(originalRecord.object_path), { headers: adminHeaders });
    assert.equal(originalDownload.status, 200);
    assert.deepEqual(Buffer.from(await originalDownload.arrayBuffer()), fixture.file);

    const processedBytes = Buffer.from('FINAL TEST ECU FILE - NOT MODIFIED');
    const processedPath = `${fixture.customerId}/${orderId}/processed/final-test-output.bin`;
    const finalUpload = await fetch(storageUrl(processedPath), {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/octet-stream' }, body: processedBytes
    });
    assert.equal(finalUpload.status, 200);
    const finalRecordResponse = await fetch(orderFiles, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_id: orderId, owner_id: fixture.customerId, kind: 'processed', bucket_id: 'private-ecu-files',
        object_path: processedPath, original_name: 'final-test-output.bin',
        mime_type: 'application/octet-stream', size_bytes: processedBytes.length, uploaded_by: fixture.adminId
      })
    });
    assert.equal(finalRecordResponse.status, 201);
    assert.notEqual(processedPath, originalRecord.object_path);
    assert.deepEqual(fixture.localDatabase.objects.get(originalRecord.object_path), fixture.file);

    const duplicateFinalUpload = await fetch(storageUrl(processedPath), {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('OVERWRITE MUST FAIL')
    });
    assert.equal(duplicateFinalUpload.status, 409);
    assert.deepEqual(fixture.localDatabase.objects.get(processedPath), processedBytes);

    for (const status of ['File Review', 'Processing', 'Completed']) {
      const updated = await fetch(`${local.url}/api/supabase/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`, {
        method: 'PATCH', headers: { ...adminHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ status })
      });
      assert.equal(updated.status, 204);
    }
    assert.equal(fixture.localDatabase.orders.get(orderId).status, 'Completed');

    const customerOrderResponse = await fetch(customerOrders(fixture.customerId), { headers: customerHeaders });
    assert.equal(customerOrderResponse.status, 200);
    const visibleOrders = await customerOrderResponse.json();
    assert.equal(visibleOrders.length, 1);
    assert.equal(visibleOrders[0].id, orderId);
    assert.equal(visibleOrders[0].payment_status, 'PAID');
    assert.equal(visibleOrders[0].status, 'Completed');
    assert.ok(visibleOrders[0].order_files.some(file => file.kind === 'processed' && file.object_path === processedPath));

    const finalDownload = await fetch(storageUrl(processedPath), { headers: customerHeaders });
    assert.equal(finalDownload.status, 200);
    const downloadedFinalBytes = Buffer.from(await finalDownload.arrayBuffer());
    assert.deepEqual(downloadedFinalBytes, processedBytes);
    assert.notDeepEqual(downloadedFinalBytes, fixture.file);

    const otherCustomerOrders = await fetch(customerOrders(fixture.otherCustomerId), { headers: { Authorization: 'Bearer test-other-customer-token' } });
    assert.equal(otherCustomerOrders.status, 200);
    assert.deepEqual(await otherCustomerOrders.json(), []);
    const unauthorizedOriginal = await fetch(storageUrl(originalRecord.object_path), { headers: { Authorization: 'Bearer test-other-customer-token' } });
    assert.equal(unauthorizedOriginal.status, 404);
    const unauthorizedFinal = await fetch(storageUrl(processedPath), { headers: { Authorization: 'Bearer test-other-customer-token' } });
    assert.equal(unauthorizedFinal.status, 404);

    const duplicateVerification = await createAndVerify(fixture, local.url, { skipCreate: true });
    assert.equal(duplicateVerification.response.status, 200);
    assert.deepEqual(duplicateVerification.result, { status: 'PAID', orderId });
    assert.equal(fixture.calls.paymentRead, 1);
    assert.equal(fixture.calls.rpcCount, 1);
    assert.equal(fixture.localDatabase.orders.size, 1);
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

test('rejects a captured payment with the wrong currency', async () => {
  const fixture = paymentFixture({ paymentCurrency: 'USD' });
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
