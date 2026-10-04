'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'https://local-test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'sb_publishable_local_test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_test_key';
process.env.RAZORPAY_KEY_ID = 'rzp_test_Local123';
process.env.RAZORPAY_KEY_SECRET = 'test-razorpay-secret-1234567890';
process.env.PAYPAL_CLIENT_ID = 'paypal_client_test_12345';
process.env.PAYPAL_CLIENT_SECRET = 'paypal_secret_test_12345';
process.env.PAYPAL_BASE_URL = 'https://api-m.sandbox.paypal.com';
process.env.RESEND_API_KEY = 're_test_123456789012';
process.env.EMAIL_FROM = 'ECU FILE SERVICE INDIA <noreply@example.invalid>';
process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@example.invalid';
process.env.PAYMENT_GATE_PROOF_SECRET = 'test-only-proof-secret-value-at-least-32-chars-long';
process.env.PAYMENT_GATE_SCHEMA_READY = 'true';
process.env.PUBLIC_APP_URL = 'https://ecufileservice.in';

const { createHttpServer, flushNotificationOutbox, cleanupExpiredCheckoutIntents, setTestUpstreamRequest } = require('./server');

const customerId = '10000000-0000-4000-8000-000000000001';
const adminId = '20000000-0000-4000-8000-000000000001';
const otherCustomerId = '30000000-0000-4000-8000-000000000001';
const tokens = {
  customer: 'test-customer-token',
  admin: 'test-admin-token',
  other: 'test-other-customer-token'
};

const clean = value => String(value ?? '').trim();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const proofFor = ({ id, provider, orderId, paymentId, amount, requestSha }) => crypto.createHmac('sha256', process.env.PAYMENT_GATE_PROOF_SECRET)
  .update(['EFSI_PAYMENT_CONFIRMATION_V2', customerId, id, provider, orderId, paymentId, amount, requestSha].join('|')).digest('hex');

const state = {
  intents: new Map(),
  orders: new Map(),
  orderFiles: new Map(),
  objects: new Map(),
  outbox: new Map(),
  razorOrderCalls: 0,
  paypalOrderCalls: 0,
  paypalCaptureCalls: 0,
  resendCalls: 0,
  lastResendRequest: null,
  nextOrderSequence: 1,
  nextIntentSequence: 1,
  razorPaymentStatus: 'captured',
  razorPaymentAmount: 9900,
  razorPaymentCurrency: 'INR',
  razorPaymentOrderId: null,
  razorOrderAmount: 9900,
  razorOrderCurrency: 'INR',
  razorOrderNotes: null,
  paypalOrderStatus: 'CREATED',
  resendShouldFail: false
};

function resetState() {
  for (const map of [state.intents, state.orders, state.orderFiles, state.objects, state.outbox]) map.clear();
  state.razorOrderCalls = 0;
  state.paypalOrderCalls = 0;
  state.paypalCaptureCalls = 0;
  state.resendCalls = 0;
  state.lastResendRequest = null;
  state.nextOrderSequence = 1;
  state.nextIntentSequence = 1;
  state.razorPaymentStatus = 'captured';
  state.razorPaymentAmount = 9900;
  state.razorPaymentCurrency = 'INR';
  state.razorPaymentOrderId = null;
  state.razorOrderAmount = 9900;
  state.razorOrderCurrency = 'INR';
  state.razorOrderNotes = null;
  state.paypalOrderStatus = 'CREATED';
  state.resendShouldFail = false;
}

function uuidFor(prefix, n) {
  const suffix = String(n).padStart(12, '0');
  return prefix === 'intent' ? `11000000-0000-4000-8000-${suffix}` : `22000000-0000-4000-8000-${suffix}`;
}

function response(status, payload, headers = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const bytes = Buffer.from(text);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => name.toLowerCase() === 'content-type' ? (headers['content-type'] || 'application/json') : null },
    body: { cancel: async () => {} },
    json: async () => JSON.parse(text),
    text: async () => text,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
}

function identity(options) {
  const auth = options?.headers?.Authorization || options?.headers?.authorization || '';
  const token = String(auth).replace(/^Bearer\s+/i, '');
  if (token === tokens.customer) return { id: customerId, role: 'customer' };
  if (token === tokens.admin) return { id: adminId, role: 'admin' };
  if (token === tokens.other) return { id: otherCustomerId, role: 'customer' };
  if (token === 'service_test_key') return { id: 'service-role', role: 'service' };
  return null;
}

function filteredRows(rows, searchParams) {
  const eq = name => {
    const value = searchParams.get(name);
    return value && value.startsWith('eq.') ? value.slice(3) : null;
  };
  const id = eq('id');
  const customer = eq('customer_id');
  const requestSha = eq('request_sha256');
  if (id) rows = rows.filter(row => row.id === id);
  if (customer) rows = rows.filter(row => row.customer_id === customer);
  if (requestSha) rows = rows.filter(row => row.request_sha256 === requestSha);
  return rows;
}

const upstream = async (urlValue, options = {}) => {
  const url = new URL(urlValue);
  const method = options.method || 'GET';
  if (url.pathname === '/auth/v1/user') {
    const user = identity(options);
    return user ? response(200, { id: user.id, email: user.role === 'admin' ? 'admin@example.invalid' : 'customer@example.invalid', app_metadata: user.role === 'admin' ? { role: 'admin' } : {} }) : response(401, { message: 'Invalid test session.' });
  }

  if (url.hostname === 'api.razorpay.com') {
    if (url.pathname === '/v1/orders' && method === 'POST') {
      state.razorOrderCalls += 1;
      const body = JSON.parse(options.body);
      state.razorOrderNotes = body.notes;
      return response(200, { id: 'order_TestLocal01', amount: body.amount, currency: body.currency, notes: body.notes });
    }
    if (url.pathname === '/v1/orders/order_TestLocal01') {
      return response(200, { id: 'order_TestLocal01', amount: state.razorOrderAmount, currency: state.razorOrderCurrency, notes: state.razorOrderNotes });
    }
    if (url.pathname === '/v1/payments/pay_TestLocal01') {
      return response(200, { order_id: state.razorPaymentOrderId || 'order_TestLocal01', status: state.razorPaymentStatus, amount: state.razorPaymentAmount, currency: state.razorPaymentCurrency });
    }
  }

  if (url.hostname === 'api-m.sandbox.paypal.com') {
    if (url.pathname === '/v1/oauth2/token' && method === 'POST') return response(200, { access_token: 'paypal-access-token', token_type: 'Bearer' });
    if (url.pathname === '/v2/checkout/orders' && method === 'POST') {
      state.paypalOrderCalls += 1;
      const body = JSON.parse(options.body);
      return response(200, {
        id: 'PAYPAL-ORDER-LOCAL-1', status: state.paypalOrderStatus, intent: body.intent,
        purchase_units: body.purchase_units, links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER-LOCAL-1' }]
      });
    }
    if (url.pathname === '/v2/checkout/orders/PAYPAL-ORDER-LOCAL-1' && method === 'GET') {
      const intent = [...state.intents.values()].find(item => item.provider_order_id === 'PAYPAL-ORDER-LOCAL-1');
      return response(200, {
        id: 'PAYPAL-ORDER-LOCAL-1', status: state.paypalOrderStatus, intent: 'CAPTURE',
        purchase_units: [{
          custom_id: intent?.id,
          reference_id: intent?.id,
          amount: { currency_code: 'INR', value: '99.00' },
          payments: state.paypalOrderStatus === 'COMPLETED' ? { captures: [{ id: 'CAPTURE-LOCAL-1', status: 'COMPLETED', amount: { currency_code: 'INR', value: '99.00' } }] } : undefined
        }]
      });
    }
    if (url.pathname === '/v2/checkout/orders/PAYPAL-ORDER-LOCAL-1/capture' && method === 'POST') {
      state.paypalCaptureCalls += 1;
      state.paypalOrderStatus = 'COMPLETED';
      return response(200, {
        id: 'PAYPAL-ORDER-LOCAL-1', status: 'COMPLETED', intent: 'CAPTURE',
        purchase_units: [{ payments: { captures: [{ id: 'CAPTURE-LOCAL-1', status: 'COMPLETED', amount: { currency_code: 'INR', value: '99.00' } }] } }]
      });
    }
  }

  if (url.hostname === 'api.resend.com' && url.pathname === '/emails' && method === 'POST') {
    state.resendCalls += 1;
    state.lastResendRequest = { headers: options.headers, body: JSON.parse(options.body) };
    if (state.resendShouldFail) return response(500, { message: 'synthetic Resend outage' });
    return response(200, { id: 'email-local-1' });
  }

  if (url.pathname === '/rest/v1/checkout_intents') {
    const user = identity(options);
    if (!user && !String(options.headers?.Authorization || '').includes('service_test_key')) return response(401, { message: 'Authentication required.' });
    if (method === 'GET') {
      let rows = [...state.intents.values()];
      if (user?.role === 'customer') rows = rows.filter(row => row.customer_id === user.id);
      else if (user?.role !== 'admin' && user?.role !== 'service') rows = [];
      rows = filteredRows(rows, url.searchParams);
      const statusFilter = url.searchParams.get('status');
      if (statusFilter?.startsWith('in.(')) {
        const statuses = statusFilter.slice(4, -1).split(',');
        rows = rows.filter(row => statuses.includes(row.status));
      }
      return response(200, rows.map(row => ({ ...row })));
    }
    if (method === 'POST') {
      const body = JSON.parse(options.body);
      if (state.intents.has(body.id)) return response(409, { message: 'duplicate' });
      state.intents.set(body.id, { ...body, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      return response(201, [{ ...state.intents.get(body.id) }]);
    }
    if (method === 'PATCH') {
      const body = JSON.parse(options.body);
      const rows = filteredRows([...state.intents.values()], url.searchParams);
      const updated = [];
      for (const row of rows) {
        Object.assign(row, body, { updated_at: new Date().toISOString() });
        updated.push({ ...row });
      }
      return response(200, updated);
    }
  }

  if (url.pathname === '/rest/v1/orders') {
    const user = identity(options);
    if (!user) return response(401, { message: 'Authentication required.' });
    let rows = [...state.orders.values()];
    if (user.role === 'customer') rows = rows.filter(row => row.customer_id === user.id);
    rows = filteredRows(rows, url.searchParams);
    const idFilter = url.searchParams.get('id');
    if (idFilter?.startsWith('in.(')) rows = rows.filter(row => idFilter.slice(4, -1).split(',').includes(row.id));
    if (method === 'GET') {
      return response(200, rows.map(row => ({ ...row, order_files: [...state.orderFiles.values()].filter(file => file.order_id === row.id) })));
    }
    if (method === 'PATCH') {
      if (user.role !== 'admin' && user.role !== 'service') return response(403, { message: 'RLS blocked order update.' });
      const body = JSON.parse(options.body);
      for (const row of rows) row.status = body.status;
      return response(200, rows.map(row => ({ ...row })));
    }
    if (method === 'POST') {
      if (user.role !== 'admin') return response(401, { message: 'Customers cannot create orders directly.' });
      return response(201, []);
    }
  }

  if (url.pathname === '/rest/v1/order_files') {
    const user = identity(options);
    if (!user) return response(401, { message: 'Authentication required.' });
    if (method === 'GET') {
      let rows = [...state.orderFiles.values()];
      const orderId = url.searchParams.get('order_id');
      const kind = url.searchParams.get('kind');
      if (orderId?.startsWith('eq.')) rows = rows.filter(row => row.order_id === orderId.slice(3));
      if (kind?.startsWith('eq.')) rows = rows.filter(row => row.kind === kind.slice(3));
      rows = rows.filter(row => user.role === 'admin' || user.role === 'service' || row.owner_id === user.id);
      return response(200, rows);
    }
    if (method === 'POST') {
      if (user.role !== 'admin' && user.role !== 'service') return response(403, { message: 'Customer insert blocked by RLS.' });
      const body = JSON.parse(options.body);
      const id = `FILE-${state.orderFiles.size + 1}`;
      state.orderFiles.set(id, { ...body, id, created_at: new Date().toISOString() });
      return response(201, [{ ...state.orderFiles.get(id) }]);
    }
  }

  if (url.pathname === '/rest/v1/notification_outbox') {
    const auth = String(options.headers?.Authorization || '');
    if (!auth.includes('service_test_key')) return response(403, { message: 'Service role required.' });
    if (method === 'GET') {
      let rows = [...state.outbox.values()];
      const statusFilter = url.searchParams.get('status');
      if (statusFilter?.startsWith('in.(')) rows = rows.filter(row => statusFilter.slice(4, -1).split(',').includes(row.status));
      return response(200, rows);
    }
    if (method === 'PATCH') {
      const id = url.searchParams.get('id')?.slice(3) || '';
      const row = state.outbox.get(id);
      if (!row) return response(200, []);
      Object.assign(row, JSON.parse(options.body));
      return response(200, [{ ...row }]);
    }
  }

  const rpcMatch = url.pathname === '/rest/v1/rpc/efsi_finalize_paid_checkout';
  if (rpcMatch && method === 'POST') {
    const user = identity(options);
    if (!user || user.id !== customerId) return response(401, { message: 'Authentication required.' });
    const body = JSON.parse(options.body);
    const intent = state.intents.get(body.p_intent_id);
    if (!intent || intent.customer_id !== customerId) return response(404, { message: 'Checkout intent not found.' });
    if (intent.status === 'PAID') return response(200, { id:[...state.orders.values()].find(order => order.customer_id === customerId && order.payment_request_sha256 === intent.request_sha256)?.id || intent.id });
    const expected = proofFor({ id: intent.id, provider: body.p_payment_provider, orderId: body.p_provider_order_id, paymentId: body.p_provider_payment_id, amount: body.p_amount_paise, requestSha: intent.request_sha256 });
    if (body.p_payment_proof !== expected) return response(403, { message: 'Payment server proof is invalid.' });
    if (!state.objects.has(intent.storage_path)) return response(404, { message: 'Original file is not staged.' });
    const orderId = uuidFor('order', state.nextOrderSequence++);
    const request = intent.request_json;
    const order = {
      id: orderId, customer_id: customerId, status: 'New', category: request.category,
      vehicle_brand: request.vehicleBrand, vehicle_type: request.vehicleType, vehicle_model: request.vehicleModel,
      vehicle_year: request.vehicleYear ? Number(request.vehicleYear) : null,
      ecu_manufacturer: request.category === 'ECU' ? request.ecuManufacturer || null : null,
      ecu_model: request.category === 'ECU' ? request.ecuModel || null : null,
      reading_tool: request.category === 'ECU' ? request.readingTool || null : null,
      selected_services: request.selectedServices, notes: request.notes || null,
      contact_name: request.contactName, contact_phone: request.contactPhone, contact_email: request.contactEmail || null,
      payment_status: 'PAID', payment_provider: body.p_payment_provider, provider_order_id: body.p_provider_order_id,
      provider_payment_id: body.p_provider_payment_id, verification_amount_paise: body.p_amount_paise,
      payment_request_sha256: intent.request_sha256, paid_at: body.p_paid_at || new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    };
    if (body.p_payment_provider === 'razorpay') { order.razorpay_order_id = body.p_provider_order_id; order.razorpay_payment_id = body.p_provider_payment_id; }
    state.orders.set(orderId, order);
    const fileId = `FILE-${state.orderFiles.size + 1}`;
    state.orderFiles.set(fileId, { id: fileId, order_id: orderId, owner_id: customerId, kind: 'original', bucket_id: 'private-ecu-files', object_path: intent.storage_path, original_name: intent.original_name, mime_type: intent.original_mime, size_bytes: intent.original_size, uploaded_by: customerId, created_at: new Date().toISOString() });
    Object.assign(intent, { status: 'PAID', payment_status: 'PAID', payment_provider: body.p_payment_provider, provider_order_id: body.p_provider_order_id, provider_payment_id: body.p_provider_payment_id, paid_at: body.p_paid_at || new Date().toISOString() });
    const now = new Date().toISOString();
    state.outbox.set(`outbox-${orderId}-new`, { id:`outbox-${orderId}-new`, order_id:orderId, event_type:'new_order', status:'PENDING', attempts:0, next_attempt_at:now, created_at:now });
    state.outbox.set(`outbox-${orderId}-paid`, { id:`outbox-${orderId}-paid`, order_id:orderId, event_type:'paid_order', status:'PENDING', attempts:0, next_attempt_at:now, created_at:now });
    return response(200, { id: orderId });
  }

  const objectPrefix = '/storage/v1/object/private-ecu-files/';
  if (url.pathname.startsWith(objectPrefix)) {
    const objectPath = url.pathname.slice(objectPrefix.length).split('/').map(decodeURIComponent).join('/');
    if (method === 'GET') {
      if (!state.objects.has(objectPath)) return response(404, { message:'Not found' });
      const bytes = state.objects.get(objectPath);
      return response(200, bytes, { 'content-type':'application/octet-stream' });
    }
    if (method === 'DELETE') { state.objects.delete(objectPath); return response(200, {}); }
  }

  return response(404, { message: `Unhandled upstream route: ${method} ${url.pathname}` });
};

setTestUpstreamRequest(upstream);

let server;
let baseUrl;

test.before(async () => {
  resetState();
  server = createHttpServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  setTestUpstreamRequest(null);
  await new Promise(resolve => server.close(resolve));
});

test.beforeEach(() => resetState());

async function call(pathname, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { response, payload };
}

function customerRequest() {
  const fileText = 'TEST ECU FILE CONTENT';
  const request = {
    category: 'ECU', vehicleBrand:'Tata', vehicleType:'Car', vehicleModel:'Nexon', vehicleYear:'2022',
    ecuManufacturer:'Bosch', ecuModel:'MD1', readingTool:'KESS', selectedServices:['DTC OFF'],
    notes:'Test request', contactName:'Test Customer', contactPhone:'+919876543210', contactEmail:'customer@example.invalid',
    originalName:'test-ecu.bin', originalMime:'application/octet-stream', originalSize:Buffer.byteLength(fileText), originalSha256:hash(fileText)
  };
  return { request, fileText };
}

async function createAndStageIntent(overrides = {}) {
  const { request, fileText } = customerRequest();
  Object.assign(request, overrides);
  const create = await call('/api/checkout/intents', { method:'POST', token:tokens.customer, body:{ request } });
  assert.equal(create.response.status, 200);
  const objectPath = create.payload.storagePath;
  state.objects.set(objectPath, fileText);
  const stage = await call(`/api/checkout/intents/${encodeURIComponent(create.payload.intentId)}/stage`, { method:'POST', token:tokens.customer });
  assert.equal(stage.response.status, 200);
  return { intentId:create.payload.intentId, objectPath, request, fileText };
}

async function paidRazorpayIntent() {
  const created = await createAndStageIntent();
  const paymentOrder = await call('/api/payment/create-order', { method:'POST', token:tokens.customer, body:{ intentId:created.intentId } });
  assert.equal(paymentOrder.response.status, 200);
  const verify = await call('/api/payment/verify', { method:'POST', token:tokens.customer, body:{ intentId:created.intentId, razorpay_order_id:'order_TestLocal01', razorpay_payment_id:'pay_TestLocal01', razorpay_signature:crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update('order_TestLocal01|pay_TestLocal01').digest('hex') } });
  return { created, paymentOrder, verify };
}

async function paidPayPalIntent() {
  const created = await createAndStageIntent();
  const paymentOrder = await call('/api/payment/paypal/create-order', { method:'POST', token:tokens.customer, body:{ intentId:created.intentId } });
  assert.equal(paymentOrder.response.status, 200);
  const capture = await call('/api/payment/paypal/capture', { method:'POST', token:tokens.customer, body:{ intentId:created.intentId, paypalOrderId:'PAYPAL-ORDER-LOCAL-1' } });
  return { created, paymentOrder, capture };
}

test('serves customer and admin pages', async () => {
  const customer = await call('/');
  const admin = await call('/admin.html');
  assert.equal(customer.response.status, 200);
  assert.equal(admin.response.status, 200);
  assert.match(customer.response.headers.get('content-type') || '', /text\/html/);
});

test('allows the custom domain CORS origin and rejects an unrelated origin', async () => {
  const good = await fetch(`${baseUrl}/api/health`, { headers:{ Origin:'https://ecufileservice.in' } });
  const bad = await fetch(`${baseUrl}/api/health`, { headers:{ Origin:'https://evil.example' } });
  assert.equal(good.headers.get('access-control-allow-origin'),'https://ecufileservice.in');
  assert.equal(bad.headers.get('access-control-allow-origin'),null);
});

test('answers API preflight for an allowed origin', async () => {
  const res = await fetch(`${baseUrl}/api/health`, { method:'OPTIONS', headers:{ Origin:'https://ecufileservice.in' } });
  assert.equal(res.status, 204);
});

test('does not expose project secrets, fixtures, or migration files', async () => {
  for (const name of ['server.js','.env.example','TEST_ECU_FILE.bin','supabase/migrations/20261004_updates.sql']) {
    const res = await fetch(`${baseUrl}/${name}`);
    assert.equal(res.status, 404, name);
  }
});

test('unknown API routes return JSON 404', async () => {
  const result = await call('/api/not-real');
  assert.equal(result.response.status, 404);
  assert.equal(result.payload.error, 'API endpoint not found.');
});

test('health reports provider and email readiness', async () => {
  const result = await call('/api/health');
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.paymentConfigured, true);
  assert.equal(result.payload.paymentReadiness.razorpay, true);
  assert.equal(result.payload.paymentReadiness.paypal, true);
  assert.equal(result.payload.paymentReadiness.resend, true);
  assert.equal(result.payload.paymentReadiness.serviceRoleAvailable, true);
});

test('creates a durable checkout intent with a content-addressed private storage path', async () => {
  const created = await createAndStageIntent();
  const intent = state.intents.get(created.intentId);
  assert.ok(intent);
  assert.equal(intent.storage_path, `content/${created.request.originalSha256}`);
  assert.equal(intent.status, 'FILE_STAGED');
  assert.equal(intent.payment_status, 'PENDING');
  assert.equal(state.objects.has(intent.storage_path), true);
});

test('deduplicates an active checkout intent for the same customer/request hash', async () => {
  const first = await createAndStageIntent();
  const second = await call('/api/checkout/intents', { method:'POST', token:tokens.customer, body:{ request:first.request } });
  assert.equal(second.response.status,200);
  assert.equal(second.payload.intentId, first.intentId);
  assert.equal(state.intents.size,1);
});

test('rejects an oversized checkout request before payment creation', async () => {
  const { request } = customerRequest();
  request.originalSize = 50 * 1024 * 1024 + 1;
  const result = await call('/api/checkout/intents', { method:'POST', token:tokens.customer, body:{ request } });
  assert.equal(result.response.status,400);
  assert.match(result.payload.error,/50 MB/i);
});

test('enforces Airbag and Dashboard year plus clears ECU-only fields', async () => {
  const airbag = await createAndStageIntent({ category:'AIRBAG', vehicleYear:'2021', ecuManufacturer:'Bosch', ecuModel:'MD1', readingTool:'KESS' });
  const saved = state.intents.get(airbag.intentId).request_json;
  assert.equal(saved.category,'AIRBAG');
  assert.equal(saved.ecuManufacturer,null);
  assert.equal(saved.ecuModel,null);
  assert.equal(saved.readingTool,null);
  const missingYear = await call('/api/checkout/intents', { method:'POST', token:tokens.customer, body:{ request:{ ...customerRequest().request, category:'DASHBOARD', vehicleYear:'', originalSha256:hash('x'), originalSize:1 } } });
  assert.equal(missingYear.response.status,400);
});

test('Razorpay create flow binds provider order to the durable intent', async () => {
  const created = await createAndStageIntent();
  const result = await call('/api/payment/create-order', { method:'POST', token:tokens.customer, body:{ intentId:created.intentId } });
  assert.equal(result.response.status,200);
  assert.equal(result.payload.provider,'razorpay');
  assert.equal(result.payload.providerOrderId,'order_TestLocal01');
  const intent = state.intents.get(created.intentId);
  assert.equal(intent.payment_provider,'razorpay');
  assert.equal(intent.provider_order_id,'order_TestLocal01');
  assert.equal(state.razorOrderCalls,1);
});

test('Razorpay verification creates a paid order through the provider-neutral finalizer', async () => {
  const { verify } = await paidRazorpayIntent();
  assert.equal(verify.response.status,200);
  assert.equal(verify.payload.status,'PAID');
  assert.equal(state.orders.size,1);
  const order = [...state.orders.values()][0];
  assert.equal(order.payment_provider,'razorpay');
  assert.equal(order.payment_status,'PAID');
  assert.equal(state.orderFiles.size,1);
});

test('Razorpay verification is idempotent for duplicate callbacks', async () => {
  const first = await paidRazorpayIntent();
  assert.equal(first.verify.response.status,200);
  const second = await call('/api/payment/verify', { method:'POST', token:tokens.customer, body:{ intentId:first.created.intentId, razorpay_order_id:'order_TestLocal01', razorpay_payment_id:'pay_TestLocal01', razorpay_signature:'bad' } });
  assert.equal(second.response.status,200);
  assert.equal(second.payload.status,'PAID');
  assert.equal(state.orders.size,1);
});

test('Razorpay verification rejects a wrong amount', async () => {
  const created = await createAndStageIntent();
  await call('/api/payment/create-order', { method:'POST', token:tokens.customer, body:{ intentId:created.intentId } });
  state.razorPaymentAmount = 9800;
  const signature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update('order_TestLocal01|pay_TestLocal01').digest('hex');
  const result = await call('/api/payment/verify', { method:'POST', token:tokens.customer, body:{ intentId:created.intentId, razorpay_order_id:'order_TestLocal01', razorpay_payment_id:'pay_TestLocal01', razorpay_signature:signature } });
  assert.equal(result.response.status,402);
  assert.equal(state.orders.size,0);
});

test('Razorpay reconciliation reuses the parsed request body and does not require browser signature', async () => {
  const created = await createAndStageIntent();
  await call('/api/payment/create-order', { method:'POST', token:tokens.customer, body:{ intentId:created.intentId } });
  const result = await call('/api/payment/reconcile', { method:'POST', token:tokens.customer, body:{ intentId:created.intentId, razorpay_payment_id:'pay_TestLocal01' } });
  assert.equal(result.response.status,200);
  assert.equal(result.payload.status,'PAID');
});

test('PayPal create flow returns an approval URL and persists provider order ID', async () => {
  const created = await createAndStageIntent();
  const result = await call('/api/payment/paypal/create-order', { method:'POST', token:tokens.customer, body:{ intentId:created.intentId } });
  assert.equal(result.response.status,200);
  assert.equal(result.payload.provider,'paypal');
  assert.match(result.payload.approvalUrl,/paypal\.com/);
  assert.equal(state.intents.get(created.intentId).payment_provider,'paypal');
  assert.equal(state.paypalOrderCalls,1);
});

test('PayPal capture verifies the order, capture, amount, and finalizes once', async () => {
  const { created, capture } = await paidPayPalIntent();
  assert.equal(capture.response.status,200);
  assert.equal(capture.payload.status,'PAID');
  const order = [...state.orders.values()][0];
  assert.equal(order.payment_provider,'paypal');
  assert.equal(order.provider_order_id,'PAYPAL-ORDER-LOCAL-1');
  assert.equal(order.provider_payment_id,'CAPTURE-LOCAL-1');
  assert.equal(state.paypalCaptureCalls,1);
  assert.equal(state.intents.get(created.intentId).status,'PAID');
});

test('PayPal capture is idempotent when called again', async () => {
  const first = await paidPayPalIntent();
  const second = await call('/api/payment/paypal/capture', { method:'POST', token:tokens.customer, body:{ intentId:first.created.intentId, paypalOrderId:'PAYPAL-ORDER-LOCAL-1' } });
  assert.equal(second.response.status,200);
  assert.equal(second.payload.status,'PAID');
  assert.equal(state.orders.size,1);
  assert.equal(state.paypalCaptureCalls,1);
});

test('prevents switching a checkout that already has a provider order to the other gateway', async () => {
  const created = await createAndStageIntent();
  const razor = await call('/api/payment/create-order', { method:'POST', token:tokens.customer, body:{ intentId:created.intentId } });
  assert.equal(razor.response.status,200);
  const paypal = await call('/api/payment/paypal/create-order', { method:'POST', token:tokens.customer, body:{ intentId:created.intentId } });
  assert.equal(paypal.response.status,409);
});

test('customer cannot use the admin status endpoint', async () => {
  const created = await paidRazorpayIntent();
  const orderId = created.verify.payload.orderId;
  const result = await call('/api/admin/orders/status', { method:'POST', token:tokens.customer, body:{ orderId, status:'Processing' } });
  assert.equal(result.response.status,403);
});

test('admin can explicitly set Possible status', async () => {
  const created = await paidRazorpayIntent();
  const orderId = created.verify.payload.orderId;
  const result = await call('/api/admin/orders/status', { method:'POST', token:tokens.admin, body:{ orderId, status:'Possible' } });
  assert.equal(result.response.status,200);
  assert.equal(result.payload.order.status,'Possible');
});

test('admin cannot mark an order Completed before a processed file exists', async () => {
  const created = await paidRazorpayIntent();
  const orderId = created.verify.payload.orderId;
  const result = await call('/api/admin/orders/status', { method:'POST', token:tokens.admin, body:{ orderId, status:'Completed' } });
  assert.equal(result.response.status,409);
});

test('admin can upload/register a processed file, then complete the order', async () => {
  const created = await paidRazorpayIntent();
  const orderId = created.verify.payload.orderId;
  const objectPath = `${customerId}/${orderId}/processed/result.bin`;
  state.objects.set(objectPath,'processed');
  const inserted = await call('/api/supabase/rest/v1/order_files', { method:'POST', token:tokens.admin, body:{ order_id:orderId, owner_id:customerId, kind:'processed', bucket_id:'private-ecu-files', object_path:objectPath, original_name:'result.bin', mime_type:'application/octet-stream', size_bytes:9, uploaded_by:adminId } });
  assert.equal(inserted.response.status,201);
  const result = await call('/api/admin/orders/status', { method:'POST', token:tokens.admin, body:{ orderId, status:'Completed' } });
  assert.equal(result.response.status,200);
  assert.equal(result.payload.order.status,'Completed');
});

test('customer order status can be read after payment and includes linked file references', async () => {
  const paid = await paidRazorpayIntent();
  const orderId = paid.verify.payload.orderId;
  const result = await call(`/api/supabase/rest/v1/orders?id=eq.${orderId}`, { token:tokens.customer });
  assert.equal(result.response.status,200);
  assert.equal(result.payload[0].payment_status,'PAID');
  assert.equal(result.payload[0].order_files.length,1);
});

test('a different customer cannot read the paid order through the server-side order API mock', async () => {
  const paid = await paidRazorpayIntent();
  const orderId = paid.verify.payload.orderId;
  const result = await call(`/api/supabase/rest/v1/orders?id=eq.${orderId}`, { token:tokens.other });
  assert.equal(result.response.status,200);
  assert.equal(result.payload.length,0);
});

test('Resend outbox sends idempotently without blocking order creation', async () => {
  const paid = await paidRazorpayIntent();
  await new Promise(resolve => setTimeout(resolve, 10));
  await flushNotificationOutbox();
  assert.equal(state.resendCalls,2);
  assert.match(state.lastResendRequest.headers['Idempotency-Key'],/^efsi\/(?:new_order|paid_order)\//);
  assert.equal([...state.outbox.values()].every(row => row.status==='SENT'),true);
});

test('Resend failure moves an email event to RETRY instead of breaking the order', async () => {
  const paid = await paidRazorpayIntent();
  state.resendShouldFail = true;
  await flushNotificationOutbox();
  const rows = [...state.outbox.values()];
  assert.equal(rows.every(row => ['RETRY','FAILED'].includes(row.status)),true);
  assert.ok(paid.verify.payload.orderId);
  assert.equal(state.orders.size,1);
});

test('cleanup expires abandoned intents and preserves a shared file referenced by a paid order', async () => {
  const paid = await paidRazorpayIntent();
  const paidIntent = state.intents.get(paid.created.intentId);
  const abandonedId = uuidFor('intent',state.nextIntentSequence++);
  state.intents.set(abandonedId,{ id:abandonedId, customer_id:customerId, status:'FILE_STAGED', payment_status:'PENDING', storage_path:paidIntent.storage_path, expires_at:new Date(Date.now()-1000).toISOString(), updated_at:new Date().toISOString(), request_sha256:paidIntent.request_sha256, original_name:paidIntent.original_name, original_size:paidIntent.original_size });
  await cleanupExpiredCheckoutIntents();
  assert.equal(state.intents.get(abandonedId).status,'EXPIRED');
  assert.equal(state.objects.has(paidIntent.storage_path),true);
});

test('cleanup removes an expired file with no remaining references', async () => {
  const created = await createAndStageIntent();
  const intent = state.intents.get(created.intentId);
  intent.expires_at = new Date(Date.now()-1000).toISOString();
  await cleanupExpiredCheckoutIntents();
  assert.equal(state.intents.get(created.intentId).status,'EXPIRED');
  assert.equal(state.objects.has(intent.storage_path),false);
});

test('static source contains real Realtime subscriptions and no polling/deprecated file payload path', () => {
  const files = ['auth.js','app.js','admin.js','server.js'].map(name => fs.readFileSync(path.join(__dirname,name),'utf8')).join('\n');
  const term = (code) => String.fromCharCode(...code);
  const forbidden = [term([115,101,116,73,110,116,101,114,118,97,108]), term([102,105,108,101,84,111,66,97,115,101,54,52]), term([102,105,108,101,66,97,115,101,54,52]), term([119,104,97,116,115,97,112,112]), term([119,97,46,109,101])];
  for (const value of forbidden) assert.equal(files.toLowerCase().includes(value.toLowerCase()),false,value);
  assert.match(files,/\.channel\(/);
  assert.match(files,/postgres_changes/);
});

test('static source contains category field isolation, provider routes, Resend, and explicit status selector', () => {
  const app = fs.readFileSync(path.join(__dirname,'app.js'),'utf8');
  const index = fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
  const admin = fs.readFileSync(path.join(__dirname,'admin.js'),'utf8');
  const serverSource = fs.readFileSync(path.join(__dirname,'server.js'),'utf8');
  assert.match(app,/category === 'ECU'/);
  assert.match(app,/control\.disabled = !ecu/);
  assert.match(app,/Year is required for Airbag and Dashboard/);
  assert.match(index,/id="pay-paypal"/);
  assert.match(index,/class="[^"]*\becu-only\b[^"]*"/);
  assert.match(admin,/class="order-status-select"/);
  assert.match(serverSource,/\/api\/payment\/paypal\/create-order/);
  assert.match(serverSource,/api\.resend\.com\/emails/);
  assert.match(serverSource,/notification_outbox/);
});

test('repository contains no removed contact widget references or stale local payment-state instructions', () => {
  const files = [];
  for (const name of fs.readdirSync(__dirname)) {
    const full = path.join(__dirname,name);
    if (fs.statSync(full).isFile() && !['package-lock.json','TEST_ECU_FILE.bin','server.test.js'].includes(name)) files.push(fs.readFileSync(full,'utf8'));
  }
  const migrations = path.join(__dirname,'supabase','migrations');
  for (const name of fs.readdirSync(migrations)) if (name.endsWith('.sql')) files.push(fs.readFileSync(path.join(migrations,name),'utf8'));
  const source = files.join('\n');
  const removedContactWidgetTerms = [String.fromCharCode(119,104,97,116,115,97,112,112),String.fromCharCode(119,97,46,109,101)];
  removedContactWidgetTerms.forEach(value => assert.equal(source.toLowerCase().includes(value),false,value));
  const removedStateTerms = [String.fromCharCode(80,65,89,77,69,78,84,95,83,84,65,84,69,95,68,73,82),String.fromCharCode(112,97,121,109,101,110,116,45,115,116,97,116,101,32,100,105,114,101,99,116,111,114,121),String.fromCharCode(111,115,46,116,109,112,100,105,114)];
  removedStateTerms.forEach(value => assert.equal(source.toLowerCase().includes(value.toLowerCase()),false,value));
});

test('migration defines durable checkout, provider-neutral payments, notification outbox, RLS, and safe realtime additions', () => {
  const migration = fs.readFileSync(path.join(__dirname,'supabase/migrations/20261004_updates.sql'),'utf8');
  assert.match(migration,/create table if not exists public\.checkout_intents/i);
  assert.match(migration,/efsi_finalize_paid_checkout/i);
  assert.match(migration,/payment_provider text/i);
  assert.match(migration,/provider_order_id text/i);
  assert.match(migration,/order_id uuid references public\.orders/i);
  assert.match(migration,/notification_outbox/i);
  assert.match(migration,/supabase_realtime/i);
  const sqlOnly = migration.replace(/--.*$/gm,'');
  assert.doesNotMatch(sqlOnly,/\bdrop\s+publication\b/i);
  assert.doesNotMatch(sqlOnly,/\bdrop\s+table\b/i);
});

test('migration closes direct customer order creation and order-file insertion while keeping admin policy', () => {
  const migration = fs.readFileSync(path.join(__dirname,'supabase/migrations/20261004_updates.sql'),'utf8');
  assert.match(migration,/drop policy if exists "Customers create own new orders"/i);
  assert.match(fs.readFileSync(path.join(__dirname,'supabase/migrations/20260924_ecu_file_service.sql'),'utf8'),/create policy "Admins manage order files"/i);
  assert.match(migration,/create policy "Admins manage private ECU files"/i);
});

test('migration permits shared content-addressed file references across orders', () => {
  const migration = fs.readFileSync(path.join(__dirname,'supabase/migrations/20261004_updates.sql'),'utf8');
  assert.match(migration,/drop constraint if exists order_files_object_path_key/i);
  assert.match(migration,/order_files_object_path_idx/i);
  assert.match(migration,/checkout_intents_storage_path_check/i);
});

test('production environment templates contain both payment gateways and email secrets', () => {
  const env = fs.readFileSync(path.join(__dirname,'.env.production.example'),'utf8');
  const render = fs.readFileSync(path.join(__dirname,'render.yaml'),'utf8');
  for (const key of ['PAYPAL_CLIENT_ID','PAYPAL_CLIENT_SECRET','PAYPAL_BASE_URL','RESEND_API_KEY','EMAIL_FROM','ADMIN_NOTIFICATION_EMAIL','SUPABASE_SERVICE_ROLE_KEY','PAYMENT_GATE_PROOF_SECRET']) {
    assert.match(env,new RegExp(key));
    assert.match(render,new RegExp(key));
  }
});

test('payment proof contract matches V2 in server and migration', () => {
  const serverSource = fs.readFileSync(path.join(__dirname,'server.js'),'utf8');
  const migration = fs.readFileSync(path.join(__dirname,'supabase/migrations/20261004_updates.sql'),'utf8');
  assert.match(serverSource,/EFSI_PAYMENT_CONFIRMATION_V2/);
  assert.match(migration,/EFSI_PAYMENT_CONFIRMATION_V2/);
  assert.match(serverSource,/p_intent_id/);
  assert.match(migration,/p_intent_id uuid/);
});

test('no legacy local payment state remains in the production server', () => {
  const serverSource = fs.readFileSync(path.join(__dirname,'server.js'),'utf8');
  assert.doesNotMatch(serverSource,/os\.tmpdir/i);
  assert.doesNotMatch(serverSource,new RegExp(String.fromCharCode(80,65,89,77,69,78,84,95,83,84,65,84,69,95,68,73,82),'i'));
  assert.doesNotMatch(serverSource,/paymentStateDir/i);
});

test('customer frontend declares payment readiness before initial summary rendering', () => {
  const source = fs.readFileSync(path.join(__dirname,'app.js'),'utf8');
  assert.match(source,/let providerReadiness\s*=\s*\{\s*razorpay:\s*false,\s*paypal:\s*false\s*\}/);
  assert.match(source,/next-button.*validatePage\(currentPage\).*setPage\(currentPage\+1\)/s);
  assert.match(source,/input\[name=consent\]/);
});

test('customer review page keeps authorization consent visible with payment controls', () => {
  const html = fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
  const consent = html.indexOf('name="consent"');
  const gatewayActions = html.indexOf('class="payment-gateway-actions"');
  assert.ok(consent >= 0 && gatewayActions >= 0 && consent < gatewayActions);
});

test('server JavaScript syntax is valid for every runtime file', () => {
  const { execFileSync } = require('node:child_process');
  for (const name of ['server.js','app.js','auth.js','admin.js','supabase.js','dev-checkout.js']) execFileSync(process.execPath,['--check',path.join(__dirname,name)]);
});
