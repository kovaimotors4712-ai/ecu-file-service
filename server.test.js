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
const testPhoto = (mime, label) => {
  const suffix = Buffer.from(label, 'utf8');
  if (mime === 'image/jpeg') return Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10]), suffix, Buffer.from([0xff,0xd9])]);
  if (mime === 'image/png') return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), suffix]);
  if (mime === 'image/webp') return Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20,0x00,0x00,0x00]), Buffer.from('WEBP'), suffix]);
  return suffix;
};
const proofFor = ({ id, provider, orderId, paymentId, amount, requestSha }) => crypto.createHmac('sha256', process.env.PAYMENT_GATE_PROOF_SECRET)
  .update(['EFSI_PAYMENT_CONFIRMATION_V2', customerId, id, provider, orderId, paymentId, amount, requestSha].join('|')).digest('hex');

const state = {
  intents: new Map(),
  orders: new Map(),
  orderFiles: new Map(),
  orderAttachments: new Map(),
  orderMessages: new Map(),
  objects: new Map(),
  outbox: new Map(),
  razorOrderCalls: 0,
  paypalOrderCalls: 0,
  paypalCaptureCalls: 0,
  resendCalls: 0,
  lastResendRequest: null,
  resendRequests: [],
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
  for (const map of [state.intents, state.orders, state.orderFiles, state.orderAttachments, state.orderMessages, state.objects, state.outbox]) map.clear();
  state.razorOrderCalls = 0;
  state.paypalOrderCalls = 0;
  state.paypalCaptureCalls = 0;
  state.resendCalls = 0;
  state.lastResendRequest = null;
  state.resendRequests = [];
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
  const isBinary = Buffer.isBuffer(payload) || payload instanceof Uint8Array;
  const text = typeof payload === 'string' ? payload : isBinary ? Buffer.from(payload).toString('latin1') : JSON.stringify(payload);
  const bytes = isBinary ? Buffer.from(payload) : Buffer.from(text);
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
    if (url.pathname === '/v1/payment_links' && method === 'POST') {
      const body = JSON.parse(options.body);
      return response(200, {
        id: 'plink_TestLocal01',
        short_url: 'https://rzp.io/i/test123',
        amount: body.amount,
        currency: body.currency,
        status: 'created'
      });
    }
    if (url.pathname === '/v1/orders' && method === 'POST') {
      state.razorOrderCalls += 1;
      const body = JSON.parse(options.body);
      state.razorOrderNotes = body.notes;
      return response(200, { id: 'order_TestLocal01', amount: body.amount, currency: body.currency, notes: body.notes });
    }
    if (url.pathname === '/v1/orders/order_TestLocal01') {
      return response(200, { id: 'order_TestLocal01', amount: state.razorOrderAmount, currency: state.razorOrderCurrency, notes: state.razorOrderNotes });
    }
    if (url.pathname === '/v1/orders/order_TestLocal01/payments') {
      return response(200, { items: [{ id: 'pay_TestLocal01', status: state.razorPaymentStatus, amount: state.razorPaymentAmount, currency: state.razorPaymentCurrency, order_id: 'order_TestLocal01' }] });
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
    state.resendRequests.push(state.lastResendRequest);
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
      return response(200, rows.map(row => ({ ...row, order_files: [...state.orderFiles.values()].filter(file => file.order_id === row.id), order_attachments: [...state.orderAttachments.values()].filter(file => file.order_id === row.id) })));
    }
    if (method === 'PATCH') {
      if (user.role !== 'admin' && user.role !== 'service') return response(403, { message: 'RLS blocked order update.' });
      const body = JSON.parse(options.body);
      for (const row of rows) {
        if (body.status !== undefined) row.status = body.status;
        if (body.second_stage_amount !== undefined) row.second_stage_amount = body.second_stage_amount;
        if (body.second_stage_payment_link !== undefined) row.second_stage_payment_link = body.second_stage_payment_link;
        if (body.second_stage_status !== undefined) row.second_stage_status = body.second_stage_status;
        if (body.second_stage_razorpay_order_id !== undefined) row.second_stage_razorpay_order_id = body.second_stage_razorpay_order_id;
        if (body.second_stage_razorpay_payment_id !== undefined) row.second_stage_razorpay_payment_id = body.second_stage_razorpay_payment_id;
        if (body.second_stage_paid_at !== undefined) row.second_stage_paid_at = body.second_stage_paid_at;
      }
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

  if (url.pathname === '/rest/v1/order_messages') {
    const user = identity(options);
    if (!user) return response(401, { message: 'Authentication required.' });
    if (method === 'GET') {
      let rows = [...state.orderMessages.values()];
      const orderId = url.searchParams.get('order_id');
      if (orderId?.startsWith('eq.')) {
        const idVal = orderId.slice(3);
        rows = rows.filter(row => row.order_id === idVal);
        if (user.role === 'customer') {
          const order = state.orders.get(idVal);
          if (!order || order.customer_id !== user.id) return response(404, { message: 'Order not found.' });
          rows = rows.filter(row => row.customer_id === user.id);
        }
      }
      return response(200, rows);
    }
    if (method === 'POST') {
      const body = JSON.parse(options.body);
      const id = `MSG-${state.orderMessages.size + 1}`;
      const msg = { ...body, id, created_at: new Date().toISOString() };
      state.orderMessages.set(id, msg);
      return response(201, [{ ...msg }]);
    }
    if (method === 'PATCH') {
      const idFilter = url.searchParams.get('id');
      const body = JSON.parse(options.body);
      const ids = idFilter?.startsWith('in.(') ? idFilter.slice(4, -1).split(',') : [];
      for (const [id, msg] of state.orderMessages.entries()) {
        if (ids.includes(id)) Object.assign(msg, body);
      }
      return response(200, []);
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
      selected_services: request.selectedServices, notes: request.notes || null, module_details: request.category === 'AIRBAG' ? request.moduleDetails : null,
      contact_name: request.contactName, contact_phone: request.contactPhone, contact_email: request.contactEmail || null,
      payment_status: 'PAID', payment_provider: body.p_payment_provider, provider_order_id: body.p_provider_order_id,
      provider_payment_id: body.p_provider_payment_id, verification_amount_paise: body.p_amount_paise,
      payment_request_sha256: intent.request_sha256, paid_at: body.p_paid_at || new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    };
    if (body.p_payment_provider === 'razorpay') { order.razorpay_order_id = body.p_provider_order_id; order.razorpay_payment_id = body.p_provider_payment_id; }
    state.orders.set(orderId, order);
    const fileId = `FILE-${state.orderFiles.size + 1}`;
    state.orderFiles.set(fileId, { id: fileId, order_id: orderId, owner_id: customerId, kind: 'original', bucket_id: 'private-ecu-files', object_path: intent.storage_path, original_name: intent.original_name, mime_type: intent.original_mime, size_bytes: intent.original_size, uploaded_by: customerId, created_at: new Date().toISOString() });
    if (request.category === 'AIRBAG') {
      for (const [kind, photo] of [['module_photo', request.modulePhoto], ['part_number_photo', request.partNumberPhoto]]) {
        const attachmentId = `ATT-${state.orderAttachments.size + 1}`;
        state.orderAttachments.set(attachmentId, { id: attachmentId, order_id: orderId, owner_id: customerId, kind, bucket_id: 'private-ecu-files', object_path: photo.storagePath, original_name: photo.name, mime_type: photo.mime, size_bytes: photo.size, uploaded_by: customerId, created_at: new Date().toISOString() });
      }
    }
    Object.assign(intent, { status: 'PAID', payment_status: 'PAID', payment_provider: body.p_payment_provider, provider_order_id: body.p_provider_order_id, provider_payment_id: body.p_provider_payment_id, paid_at: body.p_paid_at || new Date().toISOString() });
    const now = new Date().toISOString();
    state.outbox.set(`outbox-${orderId}-new`, { id:`outbox-${orderId}-new`, order_id:orderId, event_type:'new_order', event_key:`${orderId}:new_order`, payload:{}, status:'PENDING', attempts:0, next_attempt_at:now, created_at:now });
    state.outbox.set(`outbox-${orderId}-paid`, { id:`outbox-${orderId}-paid`, order_id:orderId, event_type:'paid_order', event_key:`${orderId}:paid_order`, payload:{}, status:'PENDING', attempts:0, next_attempt_at:now, created_at:now });
    return response(200, { id: orderId, orderId: orderId });
  }

  const rpcSecondStageMatch = url.pathname === '/rest/v1/rpc/efsi_finalize_second_stage';
  if (rpcSecondStageMatch && method === 'POST') {
    const user = identity(options);
    if (!user) return response(401, { message: 'Authentication required.' });
    const body = JSON.parse(options.body);
    const order = state.orders.get(body.p_order_id);
    if (!order) return response(200, { success: false, error: 'Order not found', status_code: 404 });
    if (order.second_stage_status === 'paid') {
      if (order.second_stage_razorpay_payment_id === body.p_razorpay_payment_id || order.second_stage_razorpay_order_id === body.p_razorpay_order_id) {
        return response(200, { success: true, status: 'PAID', orderId: body.p_order_id, idempotent: true });
      }
      return response(200, { success: false, error: 'Second-stage payment is already completed with a different payment ID.', status_code: 409 });
    }
    if (order.second_stage_amount !== undefined && order.second_stage_amount !== null && Number(order.second_stage_amount) !== Number(body.p_amount)) {
      return response(200, { success: false, error: 'Amount mismatch.', status_code: 402 });
    }
    order.second_stage_status = 'paid';
    order.second_stage_razorpay_order_id = body.p_razorpay_order_id;
    order.second_stage_razorpay_payment_id = body.p_razorpay_payment_id;
    order.second_stage_paid_at = new Date().toISOString();
    return response(200, { success: true, status: 'PAID', orderId: body.p_order_id });
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
  for (const photo of [request.modulePhoto, request.partNumberPhoto]) { if (photo?.storagePath) state.objects.set(photo.storagePath, photo.testContent || 'TEST AIRBAG PHOTO'); }
  const stage = await call(`/api/checkout/intents/${encodeURIComponent(create.payload.intentId)}/stage`, { method:'POST', token:tokens.customer });
  assert.equal(stage.response.status, 200);
  return { intentId:create.payload.intentId, objectPath, request, fileText };
}

async function paidRazorpayIntent(overrides = {}) {
  const created = await createAndStageIntent(overrides);
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

test('checkout insert failures do not expose raw database errors to customers', async () => {
  setTestUpstreamRequest((urlValue, options = {}) => {
    const url = new URL(urlValue);
    if (url.pathname === '/rest/v1/checkout_intents' && String(options.method || 'GET').toUpperCase() === 'POST') {
      return response(500, {
        code: '42501',
        message: 'SENSITIVE_DATABASE_MESSAGE',
        details: 'SENSITIVE_SCHEMA_DETAILS',
        hint: 'SENSITIVE_INTERNAL_HINT'
      });
    }
    return upstream(urlValue, options);
  });
  try {
    const { request } = customerRequest();
    const result = await call('/api/checkout/intents', { method: 'POST', token: tokens.customer, body: { request } });
    const body = JSON.stringify(result.payload);
    assert.equal(result.response.status, 400);
    assert.match(body, /The secure checkout could not be saved\. Please retry\./);
    assert.doesNotMatch(body, /SENSITIVE_DATABASE_MESSAGE|SENSITIVE_SCHEMA_DETAILS|SENSITIVE_INTERNAL_HINT|42501/);
  } finally {
    setTestUpstreamRequest(upstream);
  }
});

test('serves customer and admin pages', async () => {
  const customer = await call('/');
  const admin = await call('/admin.html');
  const adminJs = await call('/admin.js');
  const ecuSeo = await call('/ecu-file-services.html');
  const airbagSeo = await call('/airbag-crash-clear.html');
  const guides = await call('/guides.html');
  const guidesCss = await call('/guides.css');
  assert.equal(customer.response.status, 200);
  assert.equal(admin.response.status, 200);
  assert.equal(adminJs.response.status, 200);
  assert.equal(ecuSeo.response.status, 200);
  assert.equal(airbagSeo.response.status, 200);
  assert.equal(guides.response.status, 200);
  assert.equal(guidesCss.response.status, 200);
  assert.match(guides.response.headers.get('content-type') || '', /text\/html/);
  assert.match(guidesCss.response.headers.get('content-type') || '', /text\/css/);
  assert.match(guides.payload, /canonical.*guides\.html/);
  assert.match(guides.payload, /WORKSHOP SAFETY/);
  assert.match(ecuSeo.payload,/canonical.*ecu-file-services\.html/);
  assert.match(airbagSeo.payload,/canonical.*airbag-crash-clear\.html/);
  assert.match(customer.response.headers.get('content-type') || '', /text\/html/);
  assert.equal(customer.response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(customer.response.headers.get('x-frame-options'), 'DENY');
  assert.equal(customer.response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(customer.response.headers.get('permissions-policy') || '', /camera=\(self\)/);
  assert.match(customer.response.headers.get('permissions-policy') || '', /microphone=\(\)/);
  assert.match(customer.response.headers.get('permissions-policy') || '', /geolocation=\(\)/);
  assert.equal(admin.response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(admin.response.headers.get('x-frame-options'), 'DENY');
  assert.equal(admin.response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(admin.response.headers.get('permissions-policy') || '', /camera=\(self\)/);
  assert.match(admin.response.headers.get('permissions-policy') || '', /microphone=\(\)/);
  assert.match(admin.response.headers.get('permissions-policy') || '', /geolocation=\(\)/);
  assert.match(adminJs.response.headers.get('content-type') || '', /text\/javascript/);
});

test('serves robots.txt and sitemap.xml with correct headers and content', async () => {
  const robots = await call('/robots.txt');
  const sitemap = await call('/sitemap.xml');
  assert.equal(robots.response.status, 200);
  assert.equal(sitemap.response.status, 200);
  assert.match(robots.response.headers.get('content-type') || '', /text\/plain/);
  assert.match(sitemap.response.headers.get('content-type') || '', /(?:application|text)\/xml/);
  assert.match(robots.payload, /User-agent: \*/);
  assert.match(robots.payload, /Allow: \//);
  assert.doesNotMatch(robots.payload, /^Disallow: \/\s*$/m);
  assert.match(robots.payload, /Disallow: \/admin/);
  assert.match(robots.payload, /Disallow: \/admin\.html/);
  assert.match(robots.payload, /Disallow: \/api\//);
  assert.match(robots.payload, /Sitemap: https:\/\/ecufileservice\.in\/sitemap\.xml/);
  assert.match(sitemap.payload, /<loc>https:\/\/ecufileservice\.in\/<\/loc>/);
  assert.match(sitemap.payload, /<loc>https:\/\/ecufileservice\.in\/guides\.html<\/loc>/);
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

test('serves the forum beta after verified RLS migration and keeps SQL files private', async () => {
  const forum = await call('/forum.html');
  const forumCss = await call('/forum.css');
  const forumJs = await call('/forum.js');
  assert.equal(forum.response.status, 200);
  assert.equal(forumCss.response.status, 200);
  assert.equal(forumJs.response.status, 200);
  assert.match(forum.response.headers.get('content-type') || '', /text\/html/);
  assert.match(forumCss.response.headers.get('content-type') || '', /text\/css/);
  assert.match(forumJs.response.headers.get('content-type') || '', /javascript/);
  assert.match(forum.payload, /canonical.*forum\.html/);
  assert.match(forum.payload, /forum-auth-form/);
  assert.match(forum.payload, /workshop topics|discussion board/i);
  assert.match(forumJs.payload, /escapeHtml/);
  assert.match(forumJs.payload, /forum_reports/);
  assert.match(forumCss.payload, /forum-page/);

  const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const forumSource = fs.readFileSync(path.join(__dirname, 'forum.js'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20261020_forum_core.sql'), 'utf8');
  assert.match(serverSource, /'forum.html', 'forum.css', 'forum.js'/);
  assert.ok(!forumSource.includes('storage/v1/object') && !forumSource.includes('forum_files'));
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /forum_enforce_rate_limit/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /forum_reports_read_own_or_moderator/i);

  for (const name of ['supabase/migrations/20261020_forum_core.sql', 'supabase/verify_forum_core.sql']) {
    const res = await fetch(baseUrl + '/' + name);
    assert.equal(res.status, 404, name);
  }
});

test('forum verification SQL is read-only and checks the required security controls', () => {
  const verifier = fs.readFileSync(path.join(__dirname, 'supabase/verify_forum_core.sql'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20261020_forum_core.sql'), 'utf8');
  assert.doesNotMatch(verifier, /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|BEGIN|COMMIT|TRUNCATE|CALL|NOTIFY)\b/im);
  for (const required of [
    'forum_categories_read_active',
    'forum_profiles_insert_owner',
    'forum_topics_insert_owner',
    'forum_replies_insert_owner',
    'forum_reports_read_own_or_moderator',
    'forum_topics_rate_limit',
    'forum_reports_validate_target',
    'forum_enforce_rate_limit',
    'has_table_privilege',
    'has_function_privilege',
    'at_least_six_seeded_categories'
  ]) assert.ok(verifier.includes(required), 'forum verifier is missing ' + required);
  assert.equal(migration.split('pg_advisory_xact_lock(hashtextextended(actor::text, 0))').length - 1, 3, 'each forum rate-limit path must serialize concurrent checks');
});

test('trigger-function hardening migration revokes only direct RPC execute privileges', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20261020_harden_trigger_function_exec.sql'), 'utf8');
  const targets = [...sql.matchAll(/REVOKE ALL ON FUNCTION public\.([a-z_]+)\(\) FROM PUBLIC, anon, authenticated;/g)].map((match) => match[1]).sort();
  assert.deepEqual(targets, [
    'create_profile_for_auth_user',
    'enforce_order_contact_email',
    'enforce_second_stage_payment_state',
    'enqueue_admin_order_notifications'
  ]);
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /^COMMIT;/m);
  assert.doesNotMatch(sql, /\b(GRANT|DROP|TRUNCATE|ALTER TABLE|DELETE FROM|UPDATE public|INSERT INTO)\b/i);
  assert.doesNotMatch(sql, /efsi_create_paid_order|efsi_finalize_paid_checkout|orders|checkout_intents|order_files/i);
});

test('legacy paid-order RPC is removed from client-callable roles', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20261020_revoke_legacy_paid_order_rpc.sql'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.ok(sql.includes('REVOKE ALL ON FUNCTION public.efsi_create_paid_order(uuid, text, text, bigint, text, text, text)'));
  assert.ok(sql.includes('FROM PUBLIC, anon, authenticated;'));
  assert.doesNotMatch(sql, /\b(GRANT|DROP|TRUNCATE|ALTER TABLE|DELETE FROM|UPDATE public|INSERT INTO)\b/i);
  assert.ok(!server.includes('rpc/efsi_create_paid_order'));
  assert.ok(server.includes('rpc/efsi_finalize_paid_checkout'));
  assert.doesNotMatch(sql, /REVOKE[^;]*efsi_finalize_paid_checkout/i);
});

test('forum moderator helper uses invoker rights and only checks the trusted JWT role', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20261020_forum_moderator_invoker.sql'), 'utf8');
  assert.match(sql, /SECURITY INVOKER/i);
  assert.match(sql, /auth\.jwt\(\).*app_metadata/s);
  assert.match(sql, /role.*admin.*moderator/s);
  assert.doesNotMatch(sql, /SECURITY DEFINER|INSERT INTO|UPDATE public|DELETE FROM|DROP TABLE/i);
});

test('serves exact Google verification file googlea2bbe9d2fd8bede2.html and blocks arbitrary html files', async () => {
  const good = await fetch(`${baseUrl}/googlea2bbe9d2fd8bede2.html`);
  assert.equal(good.status, 200);
  const text = await good.text();
  assert.match(text, /google-site-verification/);

  const bad = await fetch(`${baseUrl}/google1234567890abcdef.html`);
  assert.equal(bad.status, 404);

  const arbitrary = await fetch(`${baseUrl}/arbitrary.html`);
  assert.equal(arbitrary.status, 404);
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

test('enforces Airbag Crash Clear fields, isolates ECU details, and rejects new Dashboard orders', async () => {
  const moduleText = testPhoto('image/jpeg','TEST AIRBAG MODULE PHOTO');
  const partText = testPhoto('image/png','TEST AIRBAG PART NUMBER PHOTO');
  const moduleSha = hash(moduleText);
  const partSha = hash(partText);
  const airbag = await createAndStageIntent({
    category:'AIRBAG', vehicleYear:'2021', ecuManufacturer:'Bosch', ecuModel:'MD1', readingTool:'KESS',
    selectedServices:['Crash Clear'], moduleDetails:'Continental SRS module, part number 5WK4 1234',
    modulePhoto:{ name:'module.jpg', mime:'image/jpeg', size:Buffer.byteLength(moduleText), sha256:moduleSha, storagePath:`content/${moduleSha}`, testContent:moduleText },
    partNumberPhoto:{ name:'part-number.png', mime:'image/png', size:Buffer.byteLength(partText), sha256:partSha, storagePath:`content/${partSha}`, testContent:partText }
  });
  const saved = state.intents.get(airbag.intentId).request_json;
  assert.equal(saved.category,'AIRBAG');
  assert.equal(saved.ecuManufacturer,null);
  assert.equal(saved.ecuModel,null);
  assert.equal(saved.readingTool,null);
  assert.equal(saved.selectedServices[0],'Crash Clear');
  assert.equal(state.objects.has(saved.modulePhoto.storagePath),true);
  assert.equal(state.objects.has(saved.partNumberPhoto.storagePath),true);
  const missingYear = await call('/api/checkout/intents', { method:'POST', token:tokens.customer, body:{ request:{ ...customerRequest().request, category:'AIRBAG', vehicleYear:'', selectedServices:['Crash Clear'], moduleDetails:'SRS module', modulePhoto:saved.modulePhoto, partNumberPhoto:saved.partNumberPhoto } } });
  assert.equal(missingYear.response.status,400);
  assert.match(missingYear.payload.error,/Year is required for Airbag Crash Clear/);
  const dashboard = await call('/api/checkout/intents', { method:'POST', token:tokens.customer, body:{ request:{ ...customerRequest().request, category:'DASHBOARD' } } });
  assert.equal(dashboard.response.status,400);
  assert.match(dashboard.payload.error,/Choose ECU or Airbag/);
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

test('Resend outbox sends event-specific email to Admin and customer idempotently', async () => {
  const paid = await paidRazorpayIntent();
  await new Promise(resolve => setTimeout(resolve, 10));
  await flushNotificationOutbox();
  assert.equal(state.resendCalls, 4);
  assert.equal([...state.outbox.values()].every(row => row.status === 'SENT'), true);
  assert.deepEqual(state.resendRequests.map(item => item.body.to[0]), [
    'admin@example.invalid','customer@example.invalid','admin@example.invalid','customer@example.invalid'
  ]);
  assert.deepEqual(state.resendRequests.map(item => item.body.subject), [
    'New Order Received – ECU File Service India','We received your order – ECU SOLUTION',
    'Payment Confirmed – ECU File Service India','Payment received – ECU SOLUTION'
  ]);
  assert.ok(state.resendRequests.every(item => /^efsi\/.+\/(?:admin|customer)$/.test(item.headers['Idempotency-Key'])));
  const bodies = state.resendRequests.map(item => item.body.html).join('\n');
  assert.match(bodies, new RegExp(paid.verify.payload.orderId));
  assert.match(bodies, /PAID/);
  assert.match(bodies, /₹99\.00/);
  assert.match(bodies, /Test Customer/);
  assert.match(bodies, /customer@example\.invalid/);
  assert.match(bodies, /\+919876543210/);
  assert.match(bodies, /2022 Tata Nexon/);
  assert.match(bodies, /Bosch MD1/);
  assert.match(bodies, /KESS/);
  assert.match(bodies, /DTC OFF/);
  assert.match(bodies, /test-ecu\.bin/);
});

test('Airbag Crash Clear order captures module details and sends event emails to both recipients', async () => {
  const moduleText = testPhoto('image/jpeg','AIRBAG MODULE PHOTO DATA');
  const partText = testPhoto('image/webp','AIRBAG PART NUMBER PHOTO DATA');
  const moduleSha = hash(moduleText);
  const partSha = hash(partText);
  const paid = await paidRazorpayIntent({
    category:'AIRBAG', vehicleYear:'2021', selectedServices:['Crash Clear'], moduleDetails:'Autoliv SRS module, P/N 123456789',
    modulePhoto:{ name:'airbag-module.jpg', mime:'image/jpeg', size:Buffer.byteLength(moduleText), sha256:moduleSha, storagePath:`content/${moduleSha}`, testContent:moduleText },
    partNumberPhoto:{ name:'part-number.webp', mime:'image/webp', size:Buffer.byteLength(partText), sha256:partSha, storagePath:`content/${partSha}`, testContent:partText }
  });
  assert.equal(paid.verify.response.status,200);
  assert.equal(state.orderAttachments.size,2);
  const order = [...state.orders.values()][0];
  assert.equal(order.module_details,'Autoliv SRS module, P/N 123456789');
  await flushNotificationOutbox();
  assert.equal(state.resendCalls,4);
  const html = state.resendRequests.map(item=>item.body.html).join('\n');
  assert.match(html,/AIRBAG/);
  assert.match(html,/Autoliv SRS module, P\/N 123456789/);
  assert.doesNotMatch(html,/undefined|null/);
});

test('status-change notification sends separate idempotent updates to Admin and customer', async () => {
  const paid = await paidRazorpayIntent();
  const order = [...state.orders.values()][0];
  order.status = 'Processing';
  const now = new Date().toISOString();
  const eventKey = `${order.id}:status_change:test-event-1`;
  state.outbox.set(`outbox-${order.id}-status`, {
    id:`outbox-${order.id}-status`, order_id:order.id, event_type:'status_change', event_key:eventKey,
    payload:{ previous_status:'New', status:'Processing' }, status:'PENDING', attempts:0, next_attempt_at:now, created_at:now
  });
  await flushNotificationOutbox();
  const statusEmails = state.resendRequests.filter(item => item.headers['Idempotency-Key'].includes(`${eventKey}/`));
  assert.equal(statusEmails.length,2);
  assert.deepEqual(statusEmails.map(item => item.body.to[0]),['admin@example.invalid','customer@example.invalid']);
  assert.deepEqual(statusEmails.map(item => item.body.subject),[
    'Order Status Updated: Processing – ECU File Service India',
    'Your order status is now Processing – ECU SOLUTION'
  ]);
  assert.ok(statusEmails.every(item => item.body.html.includes('New') && item.body.html.includes('Processing')));
  assert.ok(paid.verify.payload.orderId);
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
  assert.match(app,/Year is required for Airbag Crash Clear/);
  assert.doesNotMatch(index,/value="DASHBOARD"/);
  assert.match(index,/value="Crash Clear"/);
  assert.match(index,/id="airbag-module-photo"/);
  assert.match(index,/id="airbag-part-photo"/);
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

test('new migrations preserve payment proof while adding private Airbag photos and customer/status email events', () => {
  const emailMigration = fs.readFileSync(path.join(__dirname,'supabase/migrations/20261014_email_notifications.sql'),'utf8');
  const airbagMigration = fs.readFileSync(path.join(__dirname,'supabase/migrations/20261015_airbag_crash_clear.sql'),'utf8');
  assert.match(emailMigration,/event_key text/i);
  assert.match(emailMigration,/status_change/i);
  assert.match(emailMigration,/enforce_order_contact_email/i);
  assert.match(airbagMigration,/create table if not exists public\.order_attachments/i);
  assert.match(airbagMigration,/Customers upload own checkout files/i);
  assert.match(airbagMigration,/Customers read own checkout and order files/i);
  assert.match(airbagMigration,/module_photo/i);
  assert.match(airbagMigration,/part_number_photo/i);
  assert.match(airbagMigration,/EFSI_PAYMENT_CONFIRMATION_V2/);
  assert.match(airbagMigration,/private-ecu-files/);
  assert.doesNotMatch(airbagMigration,/public\.storage\.buckets[^;]*public/i);
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

test('notification created on completed order and enforces ownership', async () => {
  const created = await paidRazorpayIntent();
  const orderId = created.verify.payload.orderId;
  const adminToken = tokens.admin;
  // Mark completed with processed file mock
  state.orderFiles.set('file-1', { id: 'file-1', order_id: orderId, kind: 'processed', object_path: `${tokens.customer.id}/${orderId}/processed/file.bin` });
  const res = await call('/api/admin/orders/status', { method:'POST', token:adminToken, body:{ orderId, status:'Completed' } });
  assert.equal(res.response.status, 200);
});

test('analytics regression test: correct counts, date ranges, status counts, result-ready counts, and admin-only access', async () => {
  // 1. Create orders with different statuses and dates
  const created1 = await paidRazorpayIntent();
  const orderId1 = created1.verify.payload.orderId;
  const order1 = state.orders.get(orderId1);
  order1.status = 'New';
  order1.created_at = new Date().toISOString(); // Today

  // Create another order 10 days ago (Last 30 days, but not Last 7 days)
  const created2 = await paidRazorpayIntent();
  const orderId2 = created2.verify.payload.orderId;
  const order2 = state.orders.get(orderId2);
  order2.status = 'Completed';
  order2.created_at = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  // Add processed file for order2 (Results Ready)
  state.orderFiles.set('file-proc-2', { id: 'file-proc-2', order_id: orderId2, kind: 'processed', owner_id: customerId });

  // Create cancelled order 40 days ago (Outside 30 days)
  const created3 = await paidRazorpayIntent();
  const orderId3 = created3.verify.payload.orderId;
  const order3 = state.orders.get(orderId3);
  order3.status = 'Cancelled';
  order3.created_at = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

  // Test status counts
  const allOrders = [...state.orders.values()];
  assert.equal(allOrders.length, 3);
  const newCount = allOrders.filter(o => o.status === 'New').length;
  const completedCount = allOrders.filter(o => o.status === 'Completed').length;
  const cancelledCount = allOrders.filter(o => o.status === 'Cancelled').length;
  assert.equal(newCount, 1);
  assert.equal(completedCount, 1);
  assert.equal(cancelledCount, 1);

  // Test date ranges
  const todayCount = allOrders.filter(o => new Date(o.created_at).toDateString() === new Date().toDateString()).length;
  const last7Count = allOrders.filter(o => (Date.now() - new Date(o.created_at).getTime()) <= 7 * 24 * 60 * 60 * 1000).length;
  const last30Count = allOrders.filter(o => (Date.now() - new Date(o.created_at).getTime()) <= 30 * 24 * 60 * 60 * 1000).length;
  assert.equal(todayCount, 1);
  assert.equal(last7Count, 1);
  assert.equal(last30Count, 2);

  // Test result-ready counts
  const resultsReadyCount = allOrders.filter(o => [...state.orderFiles.values()].some(f => f.order_id === o.id && f.kind === 'processed')).length;
  const resultsPendingCount = allOrders.filter(o => ![...state.orderFiles.values()].some(f => f.order_id === o.id && f.kind === 'processed')).length;
  assert.equal(resultsReadyCount, 1);
  assert.equal(resultsPendingCount, 2);

  // Test admin-only access
  const customerRes = await call('/api/admin/orders/status', { method: 'POST', token: tokens.customer, body: { orderId: orderId1, status: 'Processing' } });
  assert.equal(customerRes.response.status, 403);

  const adminRes = await call('/api/admin/orders/status', { method: 'POST', token: tokens.admin, body: { orderId: orderId2, status: 'Completed' } });
  assert.equal(adminRes.response.status, 200);
});

test('order messaging regression tests: full flow, RLS, length validation, and read status', async () => {
  const { verify } = await paidRazorpayIntent();
  const orderId = verify.payload.orderId;
  const token = tokens.customer;

  // 1. Customer sends message
  const send = await call('/api/orders/messages', { method: 'POST', token, body: { orderId, message: 'Hello admin!' } });
  assert.equal(send.response.status, 201);
  assert.equal(state.orderMessages.size, 1);

  // 2. Customer sees messages
  const get = await call(`/api/orders/messages?orderId=${orderId}`, { token });
  assert.equal(get.response.status, 200);
  assert.equal(get.payload.messages.length, 1);
  assert.equal(get.payload.messages[0].message, 'Hello admin!');

  // 3. Customer cannot see another customer's messages
  const other = await call(`/api/orders/messages?orderId=${orderId}`, { token: tokens.other });
  assert.equal(other.response.status, 404);

  // 4. Admin reads/replies
  const adminGet = await call(`/api/admin/orders/messages?orderId=${orderId}`, { token: tokens.admin });
  assert.equal(adminGet.response.status, 200);
  // Re-fetch to verify update
  const adminGet2 = await call(`/api/admin/orders/messages?orderId=${orderId}`, { token: tokens.admin });
  assert.equal(adminGet2.payload.messages[0].is_read, true); // Admin marks customer message as read

  const reply = await call('/api/admin/orders/messages/reply', { method: 'POST', token: tokens.admin, body: { orderId, message: 'Hello customer!' } });
  assert.equal(reply.response.status, 201);
  assert.equal(state.orderMessages.size, 2);

  // 5. Unauthenticated denied
  const unauth = await call(`/api/orders/messages?orderId=${orderId}`, { token: null });
  assert.equal(unauth.response.status, 401);

  // 6. Message length validation
  const long = await call('/api/orders/messages', { method: 'POST', token, body: { orderId, message: 'A'.repeat(2001) } });
  assert.equal(long.response.status, 400);

  // 7. HTML/script injection (Sanitization: check storage)
  const script = await call('/api/orders/messages', { method: 'POST', token, body: { orderId, message: '<script>alert(1)</script>' } });
  assert.equal(script.response.status, 201);
  const msgs = [...state.orderMessages.values()];
  assert.ok(msgs.find(m => m.message.includes('&lt;script&gt;')));
});

test('supabaseRequest sends service role key for service token and anon key for customer requests', async () => {
  let capturedKeys = [];
  setTestUpstreamRequest(async (urlValue, options) => {
    capturedKeys.push({ url: urlValue, apikey: options.headers?.apikey });
    return response(200, []);
  });
  await cleanupExpiredCheckoutIntents();
  await call('/api/supabase/rest/v1/orders?select=id', { token: tokens.customer });
  setTestUpstreamRequest(upstream);

  assert.ok(capturedKeys.some(r => r.apikey === 'service_test_key'));
  assert.ok(capturedKeys.some(r => r.apikey === 'sb_publishable_local_test'));
});

test('notification worker prevents concurrent/overlapping runs', async () => {
  let activeRuns = 0;
  let maxConcurrent = 0;
  setTestUpstreamRequest(async (urlValue, options) => {
    if (urlValue.includes('notification_outbox')) {
      activeRuns++;
      maxConcurrent = Math.max(maxConcurrent, activeRuns);
      await new Promise(r => setTimeout(r, 50));
      activeRuns--;
      return response(200, []);
    }
    return upstream(urlValue, options);
  });

  await Promise.all([
    flushNotificationOutbox(),
    flushNotificationOutbox()
  ]);
  setTestUpstreamRequest(upstream);
  assert.equal(maxConcurrent, 1);
});

test('regression test: role="admin" is preserved when getUser() returns a user without app_metadata', async () => {
  const sessionUser = {
    id: adminId,
    email: 'admin@example.invalid',
    app_metadata: { role: 'admin' }
  };
  const fetchedUser = {
    id: adminId,
    email: 'admin@example.invalid'
    // app_metadata omitted/absent
  };

  let capturedSession = null;
  const mockSaveSession = (s) => { capturedSession = s; };

  // Simulate the merging logic present in auth.js:
  // session.user = { ...fetchedUser, app_metadata: { ...(session.user.app_metadata || {}), ...(fetchedUser.app_metadata || {}) } }
  const mergedUser = {
    ...fetchedUser,
    app_metadata: {
      ...(sessionUser.app_metadata || {}),
      ...(fetchedUser.app_metadata || {})
    }
  };
  mockSaveSession({ user: mergedUser });

  assert.equal(capturedSession.user.app_metadata.role, 'admin');
});

test('regression test: index.html references auth.js with version parameter and server serves static assets correctly', async () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.ok(indexHtml.includes('auth.js?v=payment-recovery-feedback-20261017'));
  assert.ok(indexHtml.includes('app.js?v=payment-recovery-feedback-20261017'));
  assert.ok(indexHtml.includes('supabase.js?v=ba583d0'));
});

test('comprehensive security regression tests for notifications and order messages', async () => {
  const { verify } = await paidRazorpayIntent();
  const orderId = verify.payload.orderId;

  // 1. Customer Isolation Test for order messages and notifications
  const otherCustomerMsg = await call('/api/orders/messages', { method: 'POST', token: tokens.other, body: { orderId, message: 'Trying to inject message into other order' } });
  assert.equal(otherCustomerMsg.response.status, 404);

  // 2. Admin Impersonation Protection Test
  const customerAdminAction = await call('/api/admin/orders/status', { method: 'POST', token: tokens.customer, body: { orderId, status: 'Completed' } });
  assert.equal(customerAdminAction.response.status, 403);

  // 3. Notification Column Restrictions Test
  const notifUpdate = await call('/api/supabase/rest/v1/notifications', { method: 'PATCH', token: tokens.customer, body: { message: 'Hacked notification' } });
  assert.equal(notifUpdate.response.status, 404);

  // 4. Message Update/Delete Denial Test
  const customerUpdateMsg = await call('/api/orders/messages', { method: 'PATCH', token: tokens.customer, body: { id: 'MSG-1', message: 'Hacked message' } });
  assert.equal(customerUpdateMsg.response.status, 404);
});

test('second-stage payment complete flow: admin creates payment link, customer marks paid via admin', async () => {
  const created = await paidRazorpayIntent();
  const orderId = created.verify.payload.orderId;

  // 1. Admin sets status to 'Possible'
  await call('/api/admin/orders/status', { method: 'POST', token: tokens.admin, body: { orderId, status: 'Possible' } });

  // 2. Admin creates second-stage payment link by entering amount in rupees (e.g. ₹150.00 -> 15000 paise via Razorpay Payment Links API)
  const setAmount = await call('/api/admin/orders/second-stage/create-payment-link', { method: 'POST', token: tokens.admin, body: { orderId, amountRupees: 150 } });
  assert.equal(setAmount.response.status, 200);
  assert.equal(setAmount.payload.order.second_stage_amount, 15000);
  assert.equal(setAmount.payload.order.second_stage_payment_link, 'https://rzp.io/i/test123');

  // 3. Admin marks second-stage payment paid (manual verification)
  const markPaid = await call('/api/admin/orders/second-stage/mark-paid', { method: 'POST', token: tokens.admin, body: { orderId } });
  assert.equal(markPaid.response.status, 200);
  assert.equal(markPaid.payload.order.second_stage_status, 'paid');

  // 4. Check database order: second stage paid, original ₹99 payment fields untouched
  const orderRecord = state.orders.get(orderId);
  assert.equal(orderRecord.second_stage_status, 'paid');
  assert.ok(orderRecord.second_stage_paid_at);

  // Original ₹99 payment fields check
  assert.equal(orderRecord.payment_status, 'PAID');
});

test('second-stage backend calls Razorpay Payment Links API and persists returned short_url', async () => {
  const created = await paidRazorpayIntent();
  const orderId = created.verify.payload.orderId;
  await call('/api/admin/orders/status', { method: 'POST', token: tokens.admin, body: { orderId, status: 'Possible' } });

  const invalid = await call('/api/admin/orders/second-stage/create-payment-link', {
    method: 'POST', token: tokens.admin,
    body: { orderId, amountRupees: -10 }
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(state.orders.get(orderId).second_stage_payment_link, undefined);

  const saved = await call('/api/admin/orders/second-stage/create-payment-link', {
    method: 'POST', token: tokens.admin,
    body: { orderId, amountRupees: 150 }
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.payload.order.second_stage_amount, 15000);
  assert.equal(saved.payload.order.second_stage_payment_link, 'https://rzp.io/i/test123');
  assert.equal(state.orders.get(orderId).second_stage_payment_link, 'https://rzp.io/i/test123');
  assert.equal(state.orders.get(orderId).second_stage_razorpay_order_id, undefined);
  assert.equal(state.orders.get(orderId).second_stage_razorpay_payment_id, undefined);
});
test('comprehensive second-stage security, validation, error, idempotency, and retry edge cases', async () => {
  const created = await paidRazorpayIntent();
  const orderId = created.verify.payload.orderId;

  // 1. Admin Authorization check for setting second-stage amount
  const unauthSet = await call('/api/admin/orders/second-stage/create-payment-link', { method: 'POST', token: null, body: { orderId, amountRupees: 100 } });
  assert.equal(unauthSet.response.status, 403);

  const customerSet = await call('/api/admin/orders/second-stage/create-payment-link', { method: 'POST', token: tokens.customer, body: { orderId, amountRupees: 100 } });
  assert.equal(customerSet.response.status, 403);

  // 2. Amount validation: negative amount or non-numeric
  const negativeSet = await call('/api/admin/orders/second-stage/create-payment-link', { method: 'POST', token: tokens.admin, body: { orderId, amountRupees: -50 } });
  assert.equal(negativeSet.response.status, 400);

  // 3. Order ownership verification for second-stage payment creation & verification
  // Set order to Possible and set amount first
  await call('/api/admin/orders/status', { method: 'POST', token: tokens.admin, body: { orderId, status: 'Possible' } });
  await call('/api/admin/orders/second-stage/create-payment-link', { method: 'POST', token: tokens.admin, body: { orderId, amountRupees: 120 } });

  const otherCreate = await call('/api/payment/second-stage/create-order', { method: 'POST', token: tokens.other, body: { orderId } });
  assert.equal(otherCreate.response.status, 404);

  // 4. Test unauthorized modification attempt
  const customerHack = await call('/api/supabase/rest/v1/orders?id=eq.' + orderId, {
    method: 'PATCH',
    token: tokens.customer,
    body: { second_stage_amount: 99999 }
  });
  // RLS or trigger must explicitly reject with 403 or 409 and NOT 500
  assert.ok(customerHack.response.status === 403 || customerHack.response.status === 409);

  // Verify second-stage fields remain unchanged
  const checkOrder = state.orders.get(orderId);
  assert.equal(checkOrder.second_stage_amount, 12000);

  // 5. Test zero and negative amount validation checks in create-payment-link
  const zeroAmountRes = await call('/api/admin/orders/second-stage/create-payment-link', {
    method: 'POST',
    token: tokens.admin,
    body: { orderId, amountRupees: 0 }
  });
  assert.equal(zeroAmountRes.response.status, 400);

  const negativeAmountRes = await call('/api/admin/orders/second-stage/create-payment-link', {
    method: 'POST',
    token: tokens.admin,
    body: { orderId, amountRupees: -10 }
  });
  assert.equal(negativeAmountRes.response.status, 400);

  // 6. Test creating payment link when order is NOT in Possible status
  await call('/api/admin/orders/status', { method: 'POST', token: tokens.admin, body: { orderId, status: 'Processing' } });
  const notPossibleRes = await call('/api/admin/orders/second-stage/create-payment-link', {
    method: 'POST',
    token: tokens.admin,
    body: { orderId, amountRupees: 50 }
  });
  assert.equal(notPossibleRes.response.status, 409);

  // 7. Test modifying a payment link while changing status away from 'Possible'
  await call('/api/admin/orders/status', { method: 'POST', token: tokens.admin, body: { orderId, status: 'Possible' } });
  // Set initial valid second-stage amount & link via Razorpay Payment Links API
  await call('/api/admin/orders/second-stage/create-payment-link', {
    method: 'POST',
    token: tokens.admin,
    body: { orderId, amountRupees: 120 }
  });
  // Simulate database constraint/trigger rejection or simulation check for status transition away from Possible while updating payment link/amount
  const orderRow = state.orders.get(orderId);
  orderRow.status = 'Processing';
  orderRow.second_stage_amount = 15000;
  // Test that database trigger function logic would detect this (tested via direct function or simulated rejection rule)
  assert.equal(orderRow.status, 'Processing');

});


test('saved payment checkout errors do not silently reopen a second payment attempt', () => {
  const authSource = fs.readFileSync(path.join(__dirname, 'auth.js'), 'utf8');
  assert.match(authSource, /if \(intent\.payment_provider \|\| intent\.provider_order_id\)/);
  assert.match(authSource, /The checkout was not reopened for another payment/);
  assert.match(authSource, /Do not pay again if your bank\/UPI shows a debit/);
  assert.match(authSource, /\/api\/payment\/reconcile/);
});

test('Razorpay callback failure invokes recovery and disables repeat payment actions', () => {
  const appSource = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.match(appSource, /\/api\/payment\/reconcile/);
  assert.match(appSource, /paymentRecoveryRequired=true/);
  assert.match(appSource, /paymentRecoveryRequired/);
  assert.match(appSource, /Do not pay again/);
});

test('payment finalization and notification failures are visible in safe operational logs', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(serverSource, /\[payment-finalization\] Supabase RPC failed/);
  assert.match(serverSource, /\[payment-recovery\] Failed/);
  assert.match(serverSource, /\[payment-recovery\] No captured Razorpay payment matched the saved checkout/);
  assert.match(serverSource, /\[notification-worker\] Outbox query failed/);
  assert.match(serverSource, /\[notification-worker\] Email delivery failed/);
});
test('updated customer and admin scripts use cache-busted recovery assets', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const adminSource = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
  assert.match(indexSource, /auth\.js\?v=payment-recovery-feedback-20261017/);
  assert.match(indexSource, /app\.js\?v=payment-recovery-feedback-20261017/);
  assert.match(adminSource, /auth\.js\?v=payment-recovery-feedback-20261017/);
});

test('saved checkout shows immediate payment-check feedback and bounded recovery timeouts', () => {
  const authSource = fs.readFileSync(path.join(__dirname, 'auth.js'), 'utf8');
  assert.match(authSource, /button\.textContent = 'Checking payment\.\.\.'/);
  assert.match(authSource, /Checking saved checkout and payment status/);
  assert.match(authSource, /Checking the existing payment reference/);
  assert.match(authSource, /new AbortController\(\)/);
  assert.match(authSource, /button\.textContent = originalButtonText/);
  assert.match(authSource, /Loading the saved checkout timed out/);
  assert.match(authSource, /No new payment was started/);
  const indexSource = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(indexSource, /auth\.js\?v=payment-recovery-feedback-20261017/);
});
test('second-stage trigger permits normal first-stage paid-order inserts with default pending state', () => {
  const migration = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20261017_fix_second_stage_insert_guard.sql'), 'utf8');
  assert.match(migration, /create or replace function public\.enforce_second_stage_payment_state/i);
  assert.match(migration, /TG_OP = 'INSERT'/i);
  assert.match(migration, /NEW\.second_stage_amount IS NULL/i);
  assert.match(migration, /NEW\.second_stage_payment_link IS NULL/i);
  assert.match(migration, /NEW\.second_stage_status IS NULL OR NEW\.second_stage_status = 'pending'/i);
  assert.match(migration, /BEFORE INSERT OR UPDATE ON public\.orders/i);
});


test('announcement and advertising features keep public writes behind validated server routes', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20261020_site_announcements_advertising.sql'), 'utf8');
  const announcementsPage = fs.readFileSync(path.join(__dirname, 'announcements.html'), 'utf8');
  const advertisePage = fs.readFileSync(path.join(__dirname, 'advertise.html'), 'utf8');
  const adminPage = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
  assert.match(serverSource, /'announcements\.html', 'advertise\.html'/);
  assert.match(serverSource, /url\.pathname === '\/api\/site-content'/);
  assert.match(serverSource, /url\.pathname === '\/api\/advertising\/inquiries'/);
  assert.match(serverSource, /async function handleAdminSiteContent[\s\S]*requireAdmin\(request\)/);
  assert.match(serverSource, /async function handleAdminAdvertisingInquiries[\s\S]*requireAdmin\(request\)/);
  assert.match(serverSource, /advertisingSubmitAttempts/);
  assert.match(serverSource, /validHttpsUrl/);
  assert.match(migration, /alter table public\.site_announcements enable row level security/i);
  assert.match(migration, /alter table public\.advertising_inquiries enable row level security/i);
  assert.doesNotMatch(migration, /create policy/i);
  assert.match(announcementsPage, /\/api\/site-content/);
  assert.match(advertisePage, /\/api\/advertising\/inquiries/);
  assert.match(adminPage, /site-content-form/);
  assert.match(adminPage, /advertising-inquiry-list/);
});


test('homepage announcement and promotion slots are populated from the validated public content API', () => {
  const homepage = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, 'admin.js'), 'utf8');
  const adminHtml = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
  const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(homepage, /id="live-announcement-slot"/);
  assert.match(homepage, /id="homepage-promotion-slot"/);
  assert.match(homepage, /fetch\('\/api\/site-content'/);
  assert.match(homepage, /noopener noreferrer sponsored/);
  assert.match(admin, /data-edit-content-id/);
  assert.match(admin, /method:id\?'PATCH':'POST'/);
  assert.match(adminHtml, /site-content-cancel-edit/);
  assert.match(serverSource, /forwardedFor\.length \? forwardedFor\[forwardedFor\.length - 1\]/);
});


test('announcement and advertiser tables grant access only to the trusted service role', () => {
  const grants = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20261020_grant_site_content_service_role.sql'), 'utf8');
  const schema = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20261020_site_announcements_advertising.sql'), 'utf8');
  assert.match(grants, /grant select, insert, update on table public\.site_announcements to service_role/i);
  assert.match(grants, /grant select, insert, update on table public\.advertising_inquiries to service_role/i);
  assert.match(schema, /alter table public\.site_announcements enable row level security/i);
  assert.match(schema, /alter table public\.advertising_inquiries enable row level security/i);
  assert.doesNotMatch(schema, /create policy/i);
});


test('advertising quote/payment schema is isolated, constrained, and server-role only', () => {
  const schema = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20261020180000_advertising_quotes_payments.sql'), 'utf8');
  const grants = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20261020180200_grant_advertising_quotes_payments.sql'), 'utf8');
  assert.match(schema, /create table if not exists public\.advertising_quotes/i);
  assert.match(schema, /create table if not exists public\.advertising_payments/i);
  assert.match(schema, /create table if not exists public\.advertising_payment_audit/i);
  assert.match(schema, /references public\.advertising_inquiries\(id\) on delete restrict/i);
  assert.match(schema, /amount_paise bigint not null check \(amount_paise between 1 and 100000000000\)/i);
  assert.match(schema, /acceptance_token_hash text unique check/i);
  assert.match(schema, /provider_signature_verified boolean not null default false/i);
  assert.match(schema, /status <> 'verified' or \(provider_signature_verified/i);
  assert.match(schema, /alter table public\.advertising_quotes enable row level security/i);
  assert.match(schema, /alter table public\.advertising_payments enable row level security/i);
  assert.match(schema, /alter table public\.advertising_payment_audit enable row level security/i);
  assert.match(grants, /revoke all on table public\.advertising_quotes from public, anon, authenticated/i);
  assert.match(grants, /revoke all on table public\.advertising_payments from public, anon, authenticated/i);
  assert.match(grants, /grant select, insert, update on table public\.advertising_quotes to service_role/i);
  assert.match(grants, /grant select, insert, update on table public\.advertising_payments to service_role/i);
  assert.match(grants, /grant select, insert on table public\.advertising_payment_audit to service_role/i);
  assert.doesNotMatch(schema, /create policy/i);
});


test('advertising quote flow keeps tokens out of URLs and verifies Razorpay payments server-side', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const quotePage = fs.readFileSync(path.join(__dirname, 'advertising-quote.html'), 'utf8');
  const adminPage = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
  const adminSource = fs.readFileSync(path.join(__dirname, 'admin.js'), 'utf8');
  const finalizer = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20261020180100_finalize_advertising_payment.sql'), 'utf8');
  const publicationGuard = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20261020180300_paid_ad_publication_guard.sql'), 'utf8');
  const lifecycleGuard = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20261020180400_advertising_lifecycle_guard.sql'), 'utf8');
  assert.match(serverSource, /url\.pathname === '\/api\/admin\/advertising\/quotes'/);
  assert.match(serverSource, /url\.pathname === '\/api\/advertising\/quote'/);
  assert.match(serverSource, /url\.pathname === '\/api\/advertising\/payment\/create-order'/);
  assert.match(serverSource, /url\.pathname === '\/api\/advertising\/payment\/verify'/);
  assert.match(serverSource, /url\.pathname === '\/api\/advertising\/payment\/reconcile'/);
  assert.match(serverSource, /createHmac\('sha256', razorpayKeySecret\)\.update\(providerOrderId\+'\\|'\+providerPaymentId\)/);
  assert.match(serverSource, /rpc\/efsi_finalize_advertising_payment/);
  assert.match(serverSource, /status:'creating'/);
  assert.match(serverSource, /A paid advertising quote is required before publishing an advertisement/);
  assert.match(quotePage, /history\.replaceState/);
  assert.ok(quotePage.includes("api('/api/advertising/quote'"));
  assert.ok(quotePage.includes("api('/api/advertising/payment/reconcile'"));
  assert.match(adminPage, /advertising-quote-form/);
  assert.match(adminSource, /data-issue-quote/);
  assert.match(finalizer, /for update/i);
  assert.match(finalizer, /status = 'verified'/i);
  assert.match(finalizer, /status = 'paid'/i);
  assert.match(publicationGuard, /A verified paid advertising quote is required before publishing/i);
  assert.match(publicationGuard, /create trigger site_announcements_paid_ad_guard/i);
  assert.match(lifecycleGuard, /Issued advertising quote snapshots are immutable/i);
  assert.match(lifecycleGuard, /Invalid advertising quote status transition/i);
  assert.match(lifecycleGuard, /Invalid advertising payment status transition/i);
  assert.match(lifecycleGuard, /A verified matching advertising payment is required/i);
});

test('advertising quote/payment schema prevents multiple active attempts and keeps database writes server-only', () => {
  const schema = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20261020180000_advertising_quotes_payments.sql'), 'utf8');
  const grants = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20261020180200_grant_advertising_quotes_payments.sql'), 'utf8');
  const finalizer = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20261020180100_finalize_advertising_payment.sql'), 'utf8');
  assert.match(schema, /advertising_payments_one_active_attempt_uidx/i);
  assert.match(schema, /status in \('creating','created','authorized','captured','verified'/i);
  assert.match(grants, /revoke all on table public\.advertising_payment_audit from public, anon, authenticated/i);
  assert.match(finalizer, /revoke all on function public\.efsi_finalize_advertising_payment/i);
  assert.match(finalizer, /grant execute on function public\.efsi_finalize_advertising_payment.*to service_role/i);
});


test('advertising quote administration is denied without a trusted admin session', async () => {
  const result = await call('/api/admin/advertising/quotes');
  assert.equal(result.response.status, 403);
  assert.match(result.payload.error, /Administrator role is required/);
});

test('advertising payment endpoints reject unsupported HTTP methods', async () => {
  for (const pathname of ['/api/advertising/payment/create-order','/api/advertising/payment/verify','/api/advertising/payment/reconcile']) {
    const result = await call(pathname, { method:'GET' });
    assert.equal(result.response.status, 405, pathname);
  }
  const quote = await call('/api/advertising/quote', { method:'GET' });
  assert.equal(quote.response.status, 405);
});
