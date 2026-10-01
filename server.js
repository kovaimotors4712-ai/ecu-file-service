const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const root = __dirname;
try {
  const envText = fs.readFileSync(path.join(root, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !Object.hasOwn(process.env, match[1])) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}
const port = Number(process.env.PORT) || 4173;
const pricingFile = path.join(root, 'pricing.local.json');
const defaultFileVerificationPricePaise = 9900;
const maxFileVerificationPricePaise = 100000000;
const allowedCorsOrigins = new Set(['https://ecufileservice.in', 'https://www.ecufileservice.in']);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
const publicFiles = new Set(['index.html', 'admin.html', 'styles.css', 'admin.css', 'app.js', 'auth.js']);
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const supabaseHostname = (() => { try { return new URL(supabaseUrl).hostname; } catch { return ''; } })();
// Authenticated user lookups can be slower than local token/session handling.
// Keep a finite bound while allowing enough time for Supabase Auth to respond.
const supabaseCustomerAuthTimeoutMs = 20000;
function isPublicClientKey(key) {
  if (!key || /^sb_secret_/i.test(key)) return false;
  const parts = key.split('.');
  if (parts.length === 3) {
    try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role === 'anon'; }
    catch { return false; }
  }
  return /^sb_publishable_/.test(key);
}
function isLegacyAnonJwt(key) {
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role === 'anon'; }
  catch { return false; }
}
const hasSafeSupabaseConfig = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl) && isPublicClientKey(supabaseAnonKey);
const maxRequestBytes = 52 * 1024 * 1024;
const maxPaymentCompleteBytes = 70 * 1024 * 1024;
const maxOriginalFileBytes = 50 * 1024 * 1024;
const paymentStateDir = path.resolve(process.env.PAYMENT_STATE_DIR || path.join(os.tmpdir(), 'efsi-payment-state'));
const razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || '';
const paymentGateProofSecret = process.env.PAYMENT_GATE_PROOF_SECRET || '';
const paymentGateSchemaReady = process.env.PAYMENT_GATE_SCHEMA_READY === 'true';
const paymentStateDirInsideWebRoot = (() => {
  const relative = path.relative(root, paymentStateDir);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
})();
const paymentOrderAttempts = new Map();
// Explicit HTTPS agents keep server-to-server calls direct. Node 24 can opt
// global fetch/Undici into environment proxy handling, which is unsafe here
// when inherited proxy variables point at a local development proxy.
const outboundHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32, rejectUnauthorized: true });
const maxUpstreamResponseBytes = 75 * 1024 * 1024;
let testUpstreamRequest = null;

function isAllowedCorsOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.origin === origin && (allowedCorsOrigins.has(origin) || (url.protocol === 'https:' && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.onrender\.com$/i.test(url.hostname)));
  } catch {
    return false;
  }
}

function requestHttps(urlValue, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  if (testUpstreamRequest) return testUpstreamRequest(urlValue, { method, headers, body, timeoutMs });
  const url = new URL(urlValue);
  if (url.protocol !== 'https:' || !(url.hostname === 'api.razorpay.com' || (supabaseHostname && url.hostname === supabaseHostname))) {
    return Promise.reject(new Error('Blocked unsupported upstream HTTPS destination.'));
  }
  const payload = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const requestHeaders = { ...headers };
  if (payload && !Object.keys(requestHeaders).some(name => name.toLowerCase() === 'content-length')) {
    requestHeaders['Content-Length'] = String(payload.length);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const request = https.request(url, {
      method, headers: requestHeaders, agent: outboundHttpsAgent, rejectUnauthorized: true
    }, response => {
      const chunks = [];
      let responseBytes = 0;
      response.on('data', chunk => {
        responseBytes += chunk.length;
        if (responseBytes > maxUpstreamResponseBytes) {
          const error = new Error('Upstream response exceeded the allowed size.');
          error.code = 'UPSTREAM_RESPONSE_TOO_LARGE';
          response.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', error => done(reject, error));
      response.once('end', () => {
        const responseBody = Buffer.concat(chunks, responseBytes);
        const status = response.statusCode || 0;
        const headersView = { get: name => {
          const value = response.headers[String(name).toLowerCase()];
          return Array.isArray(value) ? value.join(', ') : value || null;
        } };
        done(resolve, {
          status, ok: status >= 200 && status < 300, headers: headersView,
          body: { cancel: async () => {} },
          json: async () => JSON.parse(responseBody.toString('utf8')),
          text: async () => responseBody.toString('utf8'),
          arrayBuffer: async () => responseBody.buffer.slice(responseBody.byteOffset, responseBody.byteOffset + responseBody.byteLength)
        });
      });
    });
    request.once('error', error => done(reject, error));
    const timer = setTimeout(() => {
      const error = new Error('Upstream HTTPS request timed out.');
      error.code = 'ETIMEDOUT';
      request.destroy(error);
    }, timeoutMs);
    request.end(payload || undefined);
  });
}

function hasRazorpayConfig() {
  // This website is intentionally locked to Razorpay Test Mode. A Live key must
  // never enable Checkout, even if someone accidentally places one in .env.
  const validTestCredentials = /^rzp_test_[A-Za-z0-9]+$/.test(razorpayKeyId) && razorpayKeySecret.length >= 16;
  const paymentProofReady = paymentGateProofSecret.length >= 32;
  const developmentTestBypass = process.env.NODE_ENV === 'development' && process.env.PAYMENT_GATE_TEST_BYPASS === 'true';
  return validTestCredentials && paymentProofReady && !paymentStateDirInsideWebRoot && (paymentGateSchemaReady || developmentTestBypass);
}

function paymentReadinessChecks() {
  return {
    supabaseUrl: /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl),
    supabasePublicKey: isPublicClientKey(supabaseAnonKey),
    razorpayTestKeyId: /^rzp_test_[A-Za-z0-9]+$/.test(razorpayKeyId),
    razorpayKeySecret: razorpayKeySecret.length >= 16,
    paymentProofSecret: paymentGateProofSecret.length >= 32,
    paymentStateDirectoryOutsideWebRoot: !paymentStateDirInsideWebRoot,
    schemaReady: paymentGateSchemaReady
  };
}

function allowPaymentOrder(userId) {
  const now = Date.now();
  const attempts = (paymentOrderAttempts.get(userId) || []).filter(time => now - time < 10 * 60 * 1000);
  if (attempts.length >= 5) { paymentOrderAttempts.set(userId, attempts); return false; }
  attempts.push(now);
  paymentOrderAttempts.set(userId, attempts);
  if (paymentOrderAttempts.size > 10000) {
    for (const [key, values] of paymentOrderAttempts) if (!values.some(time => now - time < 10 * 60 * 1000)) paymentOrderAttempts.delete(key);
  }
  return true;
}

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function sanitizeRpcErrorMessage(value, category, code) {
  const text = String(value || '').toLowerCase();
  if (category === 'RPC_NOT_FOUND') return 'Paid-order RPC is not available.';
  if (category === 'RPC_HASH_MISMATCH') return 'Payment request hash mismatch.';
  if (category === 'RPC_PROOF_INVALID') return 'Payment proof was rejected.';
  if (category === 'RPC_RLS_ERROR') return 'Database row-level security rejected the operation.';
  if (category === 'RPC_AUTH_ERROR') return 'RPC authentication or execution permission was rejected.';
  if (category === 'RPC_SCHEMA_ERROR') return 'The paid-order RPC schema contract is unavailable.';
  if (category === 'RPC_ARGUMENT_ERROR') return 'The paid-order RPC rejected its arguments.';
  if (category === 'RPC_CONFIGURATION_ERROR') return 'Payment verification configuration is unavailable.';
  if (/request hash mismatch/.test(text)) return 'Payment request hash mismatch.';
  if (/payment server proof is invalid/.test(text)) return 'Payment proof was rejected.';
  return code ? `Supabase RPC returned an unclassified error (${code}).` : 'Supabase RPC returned an unclassified error.';
}

function classifyPaidOrderRpcError(code, message, status) {
  const text = String(message || '').toLowerCase();
  if (code === 'PGRST202' || code === '42883' || /function .*efsi_create_paid_order.*(not found|does not exist)/i.test(text)) return 'RPC_NOT_FOUND';
  if (/request hash mismatch/.test(text)) return 'RPC_HASH_MISMATCH';
  if (/payment server proof is invalid/.test(text)) return 'RPC_PROOF_INVALID';
  if (/row-level security|row level security/.test(text)) return 'RPC_RLS_ERROR';
  if (/payment verification is not configured|payment verification.*not configured/.test(text)) return 'RPC_CONFIGURATION_ERROR';
  if (code === 'PGRST301' || code === '28000' || status === 401 || status === 403 || code === '42501') return 'RPC_AUTH_ERROR';
  if (/^PGRST20[45]$/.test(code || '') || /^42/.test(code || '')) return 'RPC_SCHEMA_ERROR';
  if (code === '22023' || /invalid verified payment data|invalid order data|invalid input syntax|argument/i.test(text)) return 'RPC_ARGUMENT_ERROR';
  return 'RPC_UNKNOWN_ERROR';
}

function paidOrderRpcFailure({ status, payload, fallbackMessage = 'Supabase RPC returned an unreadable error.' }) {
  const code = typeof payload?.code === 'string' && /^[A-Z0-9]{4,10}$/.test(payload.code) ? payload.code : null;
  const upstreamMessage = typeof payload?.message === 'string' ? payload.message : fallbackMessage;
  const category = classifyPaidOrderRpcError(code, upstreamMessage, status);
  const safeMessage = sanitizeRpcErrorMessage(upstreamMessage, category, code);
  console.error('[payment] paid-order RPC failed', {
    endpoint: '/api/payment/verify',
    operation: 'create_paid_order',
    rpcFunction: 'public.efsi_create_paid_order',
    httpStatus: Number.isInteger(status) ? status : null,
    supabaseErrorCode: code,
    errorCategory: category,
    errorMessage: safeMessage
  });
  const error = new Error('Payment was verified, but your request could not be completed. Keep this page open and retry confirmation; do not pay again.');
  error.code = 'PAID_ORDER_RPC_FAILURE';
  error.rpcCategory = category;
  error.statusCode = 502;
  return error;
}

function orderHash(order) {
  return crypto.createHash('sha256').update(JSON.stringify(order)).digest('hex');
}

function recoveredSupabaseOrderId(razorpayOrderId) {
  const bytes = crypto.createHash('sha256').update(`EFSI_PAYMENT_ORDER_ID_V1|${razorpayOrderId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizePaymentRequest(value) {
  const allowedCategories = ['ECU', 'AIRBAG', 'DASHBOARD'];
  const allowedServices = ['DTC OFF', 'DPF OFF', 'AdBlue / SCR OFF', 'EGR OFF', 'O2 Remove', 'EVAP OFF', 'Decat', 'IMMO OFF', 'Speed Limit', 'Custom Request'];
  const clean = item => typeof item === 'string' ? item.trim() : '';
  const services = Array.isArray(value?.selectedServices) ? [...new Set(value.selectedServices.filter(item => allowedServices.includes(item)))] : [];
  const yearText = clean(value?.vehicleYear);
  const year = yearText ? Number(yearText) : null;
  if (!allowedCategories.includes(value?.category) || !clean(value?.vehicleBrand) || !clean(value?.vehicleType) || !clean(value?.vehicleModel) || !clean(value?.contactName) || !clean(value?.contactPhone) || services.length === 0) {
    throw new Error('Please complete the required vehicle, service and contact details.');
  }
  if (year !== null && (!Number.isInteger(year) || year < 1950 || year > 2100)) throw new Error('Enter a valid vehicle year.');
  const result = {
    category: value.category,
    vehicleBrand: clean(value.vehicleBrand).slice(0, 100),
    vehicleType: clean(value.vehicleType).slice(0, 100),
    vehicleModel: clean(value.vehicleModel).slice(0, 160),
    vehicleYear: year,
    ecuManufacturer: clean(value.ecuManufacturer).slice(0, 100) || null,
    ecuModel: clean(value.ecuModel).slice(0, 120) || null,
    readingTool: clean(value.readingTool).slice(0, 100) || null,
    selectedServices: services,
    notes: clean(value.notes).replace(/\[EFSI_(?:PRICE_SNAPSHOT|PAYMENT)_V1\]/gi, '').slice(0, 3600) || null,
    contactName: clean(value.contactName).slice(0, 120),
    contactPhone: clean(value.contactPhone).slice(0, 40),
    contactEmail: clean(value.contactEmail).slice(0, 254) || null,
    originalName: clean(value.originalName).slice(0, 255),
    originalMime: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(clean(value.originalMime)) ? clean(value.originalMime).slice(0, 120) : 'application/octet-stream',
    originalSize: Number(value.originalSize),
    originalSha256: clean(value.originalSha256).toLowerCase()
  };
  if (!result.originalName || !Number.isSafeInteger(result.originalSize) || result.originalSize < 1 || result.originalSize > maxOriginalFileBytes || !/^[a-f0-9]{64}$/.test(result.originalSha256)) {
    throw new Error('Select a valid original file up to 50 MB and try again.');
  }
  return result;
}

function bearerToken(request) {
  const match = String(request.headers.authorization || '').match(/^Bearer\s+([A-Za-z0-9._~-]+)$/i);
  return match?.[1] || null;
}

async function requireCustomer(request) {
  const token = bearerToken(request);
  if (!token || !hasSafeSupabaseConfig) return null;
  let response;
  const authStartedAt = Date.now();
  try {
    response = await requestHttps(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` },
      timeoutMs: supabaseCustomerAuthTimeoutMs
    });
  } catch (cause) {
    const reason = String(cause?.cause?.code || cause?.code || cause?.name || 'NETWORK_ERROR').slice(0, 64);
    console.error('Supabase customer verification failed before response.', { reason, elapsedMs: Date.now() - authStartedAt });
    const timedOut = cause?.code === 'ETIMEDOUT' || cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
    const error = new Error(timedOut
      ? 'Supabase sign-in verification timed out. Please retry; your file was not submitted.'
      : 'Supabase could not verify your sign-in. Please retry; your file was not submitted.');
    error.statusCode = timedOut ? 504 : 502;
    throw error;
  }
  if (!response.ok) { await response.body?.cancel(); return null; }
  const user = await response.json();
  return user?.id ? { id: user.id, token } : null;
}

async function readJson(request, limit = 32768) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Request body must be valid JSON.'); }
}

function paymentStatePath(orderId) {
  if (!/^order_[A-Za-z0-9]+$/.test(orderId)) throw new Error('Invalid payment order reference.');
  return path.join(paymentStateDir, `${orderId}.json`);
}

async function readPaymentState(orderId) {
  try { return JSON.parse(await fs.promises.readFile(paymentStatePath(orderId), 'utf8')); }
  catch { return null; }
}

async function writePaymentState(orderId, state) {
  await fs.promises.mkdir(paymentStateDir, { recursive: true });
  const target = paymentStatePath(orderId);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temporary, target);
  } catch (error) {
    try { await fs.promises.unlink(temporary); } catch {}
    throw error;
  }
}

async function razorpayApi(route, { method = 'GET', body } = {}) {
  const credentials = Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64');
  let response;
  try {
    response = await requestHttps(`https://api.razorpay.com/v1/${route}`, {
      method,
      headers: { Authorization: `Basic ${credentials}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      timeoutMs: 15000
    });
  } catch (cause) {
    // Keep diagnostics useful without logging request headers, credentials, or body data.
    const networkCode = String(cause?.cause?.code || cause?.code || 'NETWORK_ERROR').slice(0, 64);
    console.error(`Razorpay API connection failed (${networkCode}).`);
    const error = new Error('Razorpay is temporarily unavailable. Please retry; your file was not submitted.');
    error.code = 'RAZORPAY_UPSTREAM';
    error.statusCode = 502;
    throw error;
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const upstreamCode = String(payload?.error?.code || 'UNKNOWN').slice(0, 64);
    console.error(`Razorpay API rejected the request (HTTP ${response.status}, ${upstreamCode}).`);
    let customerMessage = 'Razorpay could not create the secure checkout. Please retry; your file was not submitted.';
    if (response.status === 401 || response.status === 403) {
      customerMessage = 'Razorpay Test Mode credentials were rejected. Please contact support; your file was not submitted.';
    } else if (response.status === 400) {
      customerMessage = 'Razorpay rejected the checkout details. Please contact support; your file was not submitted.';
    } else if (response.status === 429) {
      customerMessage = 'Razorpay checkout is temporarily busy. Please wait a moment and retry; your file was not submitted.';
    }
    const error = new Error(customerMessage);
    error.code = 'RAZORPAY_UPSTREAM';
    error.statusCode = response.status >= 500 ? 502 : response.status;
    throw error;
  }
  return payload;
}

async function handleCreatePaymentOrder(request, response) {
  if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return true; }
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { jsonResponse(response, 415, { error: 'Send the payment request as JSON.' }); return true; }
  if (!hasSafeSupabaseConfig || !hasRazorpayConfig()) { jsonResponse(response, 503, { error: 'Payment is not configured on this server.' }); return true; }
  try {
    const customer = await requireCustomer(request);
    if (!customer) { jsonResponse(response, 401, { error: 'Sign in with your customer account to submit a paid file request.' }); return true; }
    if (!allowPaymentOrder(customer.id)) { jsonResponse(response, 429, { error: 'Too many checkout attempts. Please wait a few minutes and try again.' }); return true; }
    const body = await readJson(request);
    const order = normalizePaymentRequest(body?.request);
    const expectedHash = orderHash(order);
    const price = readPricing().fileVerificationPricePaise;
    if (!Number.isSafeInteger(price) || price < 1) { jsonResponse(response, 503, { error: 'The verification fee is unavailable.' }); return true; }
    console.info('[payment] creating Razorpay Test Mode order', { amountPaise: price, currency: 'INR' });
    const supabaseOrderId = crypto.randomUUID();
    const razorOrder = await razorpayApi('orders', { method: 'POST', body: {
      amount: price, currency: 'INR', receipt: `efsi_${crypto.randomUUID().replaceAll('-', '').slice(0, 32)}`,
      notes: { customer_id: customer.id, request_sha256: expectedHash, supabase_order_id: supabaseOrderId, verification_amount_paise: String(price), service: 'File Verification & Support Fee' }
    } });
    const notesMatch = razorOrder?.notes?.customer_id === customer.id && razorOrder.notes.request_sha256 === expectedHash && razorOrder.notes.supabase_order_id === supabaseOrderId && razorOrder.notes.verification_amount_paise === String(price);
    if (!/^order_[A-Za-z0-9]+$/.test(String(razorOrder?.id || '')) || razorOrder.amount !== price || razorOrder.currency !== 'INR' || !notesMatch) {
      console.error('[payment] Razorpay order response failed safe validation.', { orderIdReceived: Boolean(razorOrder?.id), amountMatches: razorOrder?.amount === price, currencyMatches: razorOrder?.currency === 'INR', notesMatch });
      jsonResponse(response, 502, { error: 'Razorpay returned an invalid checkout order. Your file was not submitted; please retry.' }); return true;
    }
    console.info('[payment] Razorpay order response validated.', { orderIdReceived: true, amountPaise: razorOrder.amount, currency: razorOrder.currency });
    const state = {
      userId: customer.id, requestSha256: expectedHash, amountPaise: price,
      currency: 'INR', status: 'CREATED', createdAt: new Date().toISOString(),
      supabaseOrderId, originalPath: null
    };
    try { await writePaymentState(razorOrder.id, state); }
    catch { jsonResponse(response, 503, { error: 'The secure payment request could not be saved. No file request was submitted.' }); return true; }
    jsonResponse(response, 200, { keyId: razorpayKeyId, razorpayOrderId: razorOrder.id, amount: razorOrder.amount, currency: razorOrder.currency, businessName: 'ECU FILE SERVICE INDIA' });
  } catch (error) { jsonResponse(response, error.statusCode || (error.code === 'RAZORPAY_UPSTREAM' ? 502 : 400), { error: error.message || 'A payment order could not be created.' }); }
  return true;
}

async function supabaseCustomerRequest(customer, route, options = {}) {
  const response = await requestHttps(`${supabaseUrl}/${route}`, {
    method: options.method || 'GET',
    headers: {
      apikey: supabaseAnonKey, Authorization: `Bearer ${customer.token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.prefer ? { Prefer: options.prefer } : {}),
      ...(options.contentType ? { 'Content-Type': options.contentType } : {}),
      ...(options.upsert ? { 'x-upsert': 'true' } : {})
    },
    ...(options.body !== undefined ? { body: options.body instanceof Buffer ? options.body : JSON.stringify(options.body) } : {}),
    timeoutMs: 60000
  });
  return response;
}

async function createPaidSupabaseOrder(customer, state, order, payment) {
  const proofPayload = ['EFSI_PAYMENT_CONFIRMATION_V1', customer.id, state.supabaseOrderId, payment.orderId, payment.paymentId, state.amountPaise, state.requestSha256].join('|');
  const paymentProof = crypto.createHmac('sha256', paymentGateProofSecret).update(proofPayload).digest('hex');
  let rpcResponse;
  try {
    rpcResponse = await supabaseCustomerRequest(customer, 'rest/v1/rpc/efsi_create_paid_order', { method: 'POST', body: {
      p_order_id: state.supabaseOrderId,
      p_payment_order_id: payment.orderId,
      p_payment_id: payment.paymentId,
      p_amount_paise: state.amountPaise,
      p_request_sha256: state.requestSha256,
      p_payment_proof: paymentProof,
      p_order_json: JSON.stringify({
        category: order.category, vehicleBrand: order.vehicleBrand, vehicleType: order.vehicleType,
        vehicleModel: order.vehicleModel, vehicleYear: order.vehicleYear, ecuManufacturer: order.ecuManufacturer,
        ecuModel: order.ecuModel, readingTool: order.readingTool, selectedServices: order.selectedServices,
        notes: order.notes, contactName: order.contactName, contactPhone: order.contactPhone, contactEmail: order.contactEmail,
        originalName: order.originalName, originalMime: order.originalMime, originalSize: order.originalSize, originalSha256: order.originalSha256
      })
    } });
  } catch (error) {
    throw paidOrderRpcFailure({ status: null, payload: { message: error?.message }, fallbackMessage: 'Supabase RPC request failed before a response.' });
  }
  if (!rpcResponse.ok) {
    let payload;
    try { payload = await rpcResponse.json(); } catch {}
    throw paidOrderRpcFailure({ status: rpcResponse.status, payload });
  }
  let rpcResult;
  try { rpcResult = await rpcResponse.json(); }
  catch { throw paidOrderRpcFailure({ status: rpcResponse.status, fallbackMessage: 'RPC returned an unreadable response.' }); }
  if (rpcResult !== state.supabaseOrderId && rpcResult?.id !== state.supabaseOrderId) {
    throw paidOrderRpcFailure({ status: rpcResponse.status, fallbackMessage: 'RPC returned an unexpected order reference.' });
  }

  const safeName = order.originalName.normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(-180) || 'original.bin';
  const objectPath = state.originalPath || `${customer.id}/${state.supabaseOrderId}/original/${order.originalSha256}_${safeName}`;
  state.originalPath = objectPath;
  await writePaymentState(payment.orderId, state);
  const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
  const fileRecordResponse = await supabaseCustomerRequest(customer, `rest/v1/order_files?select=id&object_path=eq.${encodeURIComponent(objectPath)}`);
  if (!fileRecordResponse.ok) throw new Error('The verified order could not finish linking its original file.');
  const fileRecords = await fileRecordResponse.json();
  if (!Array.isArray(fileRecords) || fileRecords.length === 0) {
    const registered = await supabaseCustomerRequest(customer, 'rest/v1/order_files', { method: 'POST', body: {
      order_id: state.supabaseOrderId, owner_id: customer.id, kind: 'original', bucket_id: 'private-ecu-files',
      object_path: objectPath, original_name: order.originalName, mime_type: order.originalMime,
      size_bytes: order.originalSize, uploaded_by: customer.id
    } });
    if (!registered.ok) throw new Error('The verified order could not finish registering its original file.');
  }
  const fileRoute = `storage/v1/object/private-ecu-files/${encodedPath}`;
  const check = await supabaseCustomerRequest(customer, fileRoute);
  if (check.ok) await check.body?.cancel();
  else {
    await check.body?.cancel();
    const file = Buffer.from(payment.fileBase64, 'base64');
    const uploaded = await supabaseCustomerRequest(customer, fileRoute, { method: 'POST', contentType: order.originalMime, body: file });
    if (!uploaded.ok) throw new Error('Payment was verified, but private file storage could not finish. Sign in and retry the verified request or contact support.');
  }
  return { id: state.supabaseOrderId, path: objectPath };
}

const completingPayments = new Map();

async function recoverPaymentState(razorOrderId, customer, previousState) {
  const razorOrder = await razorpayApi(`orders/${encodeURIComponent(razorOrderId)}`);
  const notes = razorOrder?.notes || {};
  const notedOrderId = String(notes.supabase_order_id || '');
  const supabaseOrderId = notedOrderId
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(notedOrderId) ? notedOrderId : null
    : recoveredSupabaseOrderId(razorOrderId);
  const notedAmount = notes.verification_amount_paise === undefined ? razorOrder?.amount : Number(notes.verification_amount_paise);
  if (razorOrder?.id !== razorOrderId || notes.customer_id !== customer.id || !supabaseOrderId ||
      !/^[a-f0-9]{64}$/i.test(String(notes.request_sha256 || '')) ||
      !Number.isSafeInteger(notedAmount) || notedAmount < 1 || notedAmount > maxFileVerificationPricePaise ||
      razorOrder.amount !== notedAmount || razorOrder.currency !== 'INR') return null;
  if (previousState && (previousState.userId !== customer.id || previousState.requestSha256 !== notes.request_sha256.toLowerCase() ||
      previousState.amountPaise !== razorOrder.amount || previousState.currency !== razorOrder.currency || previousState.supabaseOrderId !== supabaseOrderId)) return null;
  return {
    ...(previousState || {}), userId: customer.id,
    requestSha256: notes.request_sha256.toLowerCase(), amountPaise: razorOrder.amount,
    currency: razorOrder.currency, status: previousState?.status || 'CREATED',
    createdAt: previousState?.createdAt || new Date().toISOString(),
    supabaseOrderId, originalPath: previousState?.originalPath || null
  };
}

function verifyStoredPaymentProof(order) {
  const value = String(order.notes || '');
  const amount = value.match(/\[EFSI_PRICE_SNAPSHOT_V1\]\r?\nfile_verification_paise=(\d+)/);
  const payment = value.match(/\[EFSI_PAYMENT_V1\]\r?\npayment_status=PAID\r?\npayment_provider=razorpay\r?\nrazorpay_order_id=(order_[A-Za-z0-9]+)\r?\nrazorpay_payment_id=(pay_[A-Za-z0-9]+)\r?\nrequest_sha256=([a-f0-9]{64})\r?\npayment_proof=([a-f0-9]{64})/i);
  if (!amount || !payment || !Number.isSafeInteger(Number(amount[1])) || order.payment_status !== 'PAID' || order.razorpay_order_id !== payment[1] || order.razorpay_payment_id !== payment[2] || Number(order.verification_amount_paise) !== Number(amount[1])) return false;
  const requestHash = payment[3].toLowerCase();
  const payload = ['EFSI_PAYMENT_CONFIRMATION_V1', order.customer_id, order.id, payment[1], payment[2], Number(amount[1]), requestHash].join('|');
  const expected = crypto.createHmac('sha256', paymentGateProofSecret).update(payload).digest('hex');
  return safeEqualHex(payment[4], expected);
}

async function handleAdminPaymentStatus(request, response) {
  if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return true; }
  if (!hasSafeSupabaseConfig || !hasRazorpayConfig()) { jsonResponse(response, 503, { error: 'Payment verification is not configured on this server.' }); return true; }
  const authorization = request.headers.authorization || '';
  const token = bearerToken(request);
  if (!token) { jsonResponse(response, 401, { error: 'An administrator session is required.' }); return true; }
  try {
    const authResponse = await requestHttps(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: supabaseAnonKey, Authorization: authorization }, timeoutMs: 10000 });
    if (!authResponse.ok) { await authResponse.body?.cancel(); jsonResponse(response, 401, { error: 'Administrator session is invalid.' }); return true; }
    const user = await authResponse.json();
    if (user?.app_metadata?.role !== 'admin') { jsonResponse(response, 403, { error: 'Administrator role is required.' }); return true; }
    const body = await readJson(request, 16384);
    const ids = [...new Set(Array.isArray(body?.orderIds) ? body.orderIds.filter(id => /^[0-9a-f-]{36}$/i.test(id)) : [])].slice(0, 100);
    if (!ids.length) { jsonResponse(response, 200, { verified: {} }); return true; }
    const query = `rest/v1/orders?select=id,customer_id,notes,payment_status,razorpay_order_id,razorpay_payment_id,verification_amount_paise&id=in.(${ids.join(',')})`;
    const result = await requestHttps(`${supabaseUrl}/${query}`, { headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` }, timeoutMs: 15000 });
    if (!result.ok) { await result.body?.cancel(); jsonResponse(response, 502, { error: 'Payment records could not be verified for the admin view.' }); return true; }
    const rows = await result.json();
    const verified = Object.fromEntries(rows.map(order => [order.id, verifyStoredPaymentProof(order)]));
    jsonResponse(response, 200, { verified });
  } catch { jsonResponse(response, 400, { error: 'Payment records could not be verified for the admin view.' }); }
  return true;
}

async function handleCompletePayment(request, response, { reconcile = false } = {}) {
  if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return true; }
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { jsonResponse(response, 415, { error: 'Send the payment verification request as JSON.' }); return true; }
  if (!hasSafeSupabaseConfig || !hasRazorpayConfig()) { jsonResponse(response, 503, { error: 'Payment is not configured on this server.' }); return true; }
  try {
    const customer = await requireCustomer(request);
    if (!customer) { jsonResponse(response, 401, { error: 'Your customer session expired. Sign in and retry.' }); return true; }
    const body = await readJson(request, maxPaymentCompleteBytes);
    const razorOrderId = String(body?.razorpay_order_id || '');
    const paymentId = String(body?.razorpay_payment_id || '');
    const signature = String(body?.razorpay_signature || '');
    if (!/^order_[A-Za-z0-9]+$/.test(razorOrderId) || !/^pay_[A-Za-z0-9]+$/.test(paymentId)) {
      jsonResponse(response, 400, { error: 'Valid Razorpay order and payment references are required.' }); return true;
    }
    let state = await readPaymentState(razorOrderId);
    if (state && state.userId !== customer.id) { jsonResponse(response, 404, { error: 'This payment request could not be found for your account.' }); return true; }
    if (!reconcile && state?.status === 'PAID' && state.uploaded && state.orderId) {
      jsonResponse(response, 200, { status: 'PAID', orderId: state.orderId }); return true;
    }
    if (!reconcile) {
      const expectedSignature = crypto.createHmac('sha256', razorpayKeySecret).update(`${razorOrderId}|${paymentId}`).digest('hex');
      if (!safeEqualHex(signature, expectedSignature)) { jsonResponse(response, 402, { error: 'Payment signature could not be verified. Your file was not submitted.' }); return true; }
    }
    if (reconcile || !state) {
      state = await recoverPaymentState(razorOrderId, customer, state);
      if (!state) { jsonResponse(response, 404, { error: 'This payment request could not be recovered for your account. Contact support and do not pay again.' }); return true; }
    }
    const payment = await razorpayApi(`payments/${encodeURIComponent(paymentId)}`);
    if (payment.order_id !== razorOrderId || payment.status !== 'captured' || payment.amount !== state.amountPaise || payment.currency !== state.currency) {
      jsonResponse(response, 402, { error: 'The payment is not confirmed as captured for the required amount. Your file was not submitted.' }); return true;
    }
    const order = normalizePaymentRequest(body?.request);
    if (orderHash(order) !== state.requestSha256) { jsonResponse(response, 400, { error: 'Request details changed after checkout. Your file was not submitted; contact support with your payment reference.' }); return true; }
    const fileBytes = Buffer.from(String(body?.fileBase64 || ''), 'base64');
    if (fileBytes.length !== order.originalSize || fileBytes.toString('base64') !== body.fileBase64 || crypto.createHash('sha256').update(fileBytes).digest('hex') !== order.originalSha256) {
      jsonResponse(response, 400, { error: 'The original file did not match the file selected before checkout. Your file was not submitted.' }); return true;
    }
    if (state.status === 'PAID' && state.uploaded && state.orderId) {
      jsonResponse(response, 200, { status: 'PAID', orderId: state.orderId }); return true;
    }
    const existingTask = completingPayments.get(razorOrderId);
    if (existingTask) {
      const result = await existingTask;
      jsonResponse(response, 200, { status: 'PAID', orderId: result.id }); return true;
    }
    state.status = 'VERIFIED';
    state.paymentId = paymentId;
    state.paidAt = new Date().toISOString();
    await writePaymentState(razorOrderId, state);
    const task = createPaidSupabaseOrder(customer, state, order, { orderId: razorOrderId, paymentId, fileBase64: body.fileBase64 });
    completingPayments.set(razorOrderId, task);
    try {
      const result = await task;
      state.status = 'PAID'; state.orderId = result.id; state.uploaded = true;
      await writePaymentState(razorOrderId, state);
      jsonResponse(response, 200, { status: 'PAID', orderId: result.id });
    } finally { completingPayments.delete(razorOrderId); }
  } catch (error) {
    if (error.code === 'PAID_ORDER_RPC_FAILURE') {
      jsonResponse(response, error.statusCode || 502, { error: error.message }); return true;
    }
    jsonResponse(response, error.code === 'RAZORPAY_UPSTREAM' ? 502 : 400, { error: error.message || 'Payment could not be verified. The file was not submitted.' });
  }
  return true;
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxRequestBytes) throw new Error('Request body exceeds the 52 MB proxy limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function readPricing() {
  try {
    const saved = JSON.parse(fs.readFileSync(pricingFile, 'utf8'));
    const price = saved.fileVerificationPricePaise;
    if (!Number.isSafeInteger(price) || price < 0 || price > maxFileVerificationPricePaise) {
      throw new Error('Stored pricing configuration is invalid.');
    }
    return { currency: 'INR', fileVerificationPricePaise: price };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { currency: 'INR', fileVerificationPricePaise: defaultFileVerificationPricePaise };
    }
    throw error;
  }
}

function jsonResponse(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(payload));
}

async function handlePricing(request, response) {
  if (request.method === 'GET') {
    try { jsonResponse(response, 200, readPricing()); }
    catch { jsonResponse(response, 500, { error: 'Pricing configuration could not be loaded.' }); }
    return true;
  }
  if (request.method !== 'PATCH') {
    response.writeHead(405, { Allow: 'GET, PATCH' }).end();
    return true;
  }

  const authorization = request.headers.authorization || '';
  if (!/^Bearer\s+[A-Za-z0-9._~-]+$/i.test(authorization)) {
    jsonResponse(response, 401, { error: 'An authenticated administrator session is required.' });
    return true;
  }
  if (!hasSafeSupabaseConfig) {
    jsonResponse(response, 503, { error: 'Supabase is not configured on this server.' });
    return true;
  }

  try {
    const authResponse = await requestHttps(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: supabaseAnonKey, Authorization: authorization },
      timeoutMs: 10000
    });
    if (authResponse.status === 401 || authResponse.status === 403) {
      await authResponse.body?.cancel();
      jsonResponse(response, 401, { error: 'Administrator session is not valid.' });
      return true;
    }
    if (!authResponse.ok) {
      await authResponse.body?.cancel();
      jsonResponse(response, 502, { error: 'Administrator role could not be verified.' });
      return true;
    }
    const user = await authResponse.json();
    if (user?.app_metadata?.role !== 'admin') {
      jsonResponse(response, 403, { error: 'Administrator role is required.' });
      return true;
    }

    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 4096) {
        jsonResponse(response, 413, { error: 'Pricing request is too large.' });
        return true;
      }
      chunks.push(chunk);
    }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { jsonResponse(response, 400, { error: 'Pricing request must be valid JSON.' }); return true; }

    const price = payload?.fileVerificationPricePaise;
    if (!Number.isSafeInteger(price) || price < 0 || price > maxFileVerificationPricePaise) {
      jsonResponse(response, 400, { error: 'Enter a whole paise amount from ₹0 to ₹1,000,000.' });
      return true;
    }

    const temporaryFile = `${pricingFile}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporaryFile, JSON.stringify({ fileVerificationPricePaise: price }, null, 2), { flag: 'wx' });
      await fs.promises.rename(temporaryFile, pricingFile);
    } catch (error) {
      try { await fs.promises.unlink(temporaryFile); } catch {}
      throw error;
    }
    jsonResponse(response, 200, { currency: 'INR', fileVerificationPricePaise: price });
  } catch {
    if (!response.writableEnded) jsonResponse(response, 502, { error: 'Pricing could not be saved. Check server storage and connectivity.' });
  }
  return true;
}

async function handleApi(request, response, url) {
  if (url.pathname === '/api/pricing') return handlePricing(request, response);
  if (url.pathname === '/api/payment/create-order' || url.pathname === '/api/payments/orders') return handleCreatePaymentOrder(request, response);
  if (url.pathname === '/api/payment/verify' || url.pathname === '/api/payments/complete') return handleCompletePayment(request, response);
  if (url.pathname === '/api/payment/reconcile') return handleCompletePayment(request, response, { reconcile: true });
  if (url.pathname === '/api/admin/payment-status') return handleAdminPaymentStatus(request, response);
  if (url.pathname === '/api/health') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ configured: hasSafeSupabaseConfig, paymentConfigured: hasRazorpayConfig(), paymentReadiness: paymentReadinessChecks() }));
    return true;
  }

  const proxyRoute = url.pathname.match(/^\/api\/supabase\/(auth\/v1|rest\/v1|storage\/v1)(\/.*)?$/);
  if (!proxyRoute) return false;
  if (!hasSafeSupabaseConfig) {
    response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: 'Supabase is not configured on this server.' }));
    return true;
  }
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, POST, PUT, PATCH, DELETE' }).end();
    return true;
  }

  try {
    const body = ['GET', 'DELETE'].includes(request.method) ? undefined : await readBody(request);
    const route = `${proxyRoute[1]}${proxyRoute[2] || ''}${url.search}`;
    const incomingAuthorization = request.headers.authorization || '';
    const authorization = /^Bearer\s+[A-Za-z0-9._~-]+$/i.test(incomingAuthorization)
      ? incomingAuthorization
      : isLegacyAnonJwt(supabaseAnonKey) ? `Bearer ${supabaseAnonKey}` : null;
    const upstream = await requestHttps(`${supabaseUrl}/${route.replace(/^\//, '')}`, {
      method: request.method,
      headers: {
        apikey: supabaseAnonKey,
        ...(authorization ? { Authorization: authorization } : {}),
        ...(request.headers['content-type'] ? { 'Content-Type': request.headers['content-type'] } : {}),
        ...(request.headers.accept ? { Accept: request.headers.accept } : {}),
        ...(request.headers.prefer ? { Prefer: request.headers.prefer } : {}),
        ...(request.headers['x-upsert'] ? { 'x-upsert': request.headers['x-upsert'] } : {})
      },
      ...(body ? { body } : {}),
      timeoutMs: 60000
    });
    const result = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(result);
  } catch (error) {
    const tooLarge = error.message.includes('52 MB');
    response.writeHead(tooLarge ? 413 : 502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: tooLarge ? error.message : 'Supabase request failed. Check server configuration and connectivity.' }));
  }
  return true;
}

function createHttpServer() {
  return http.createServer((request, response) => {
  const requestUrl = new URL(request.url, 'http://localhost');
  const origin = request.headers.origin;
  if (origin) {
    response.setHeader('Vary', 'Origin');
    if (isAllowedCorsOrigin(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, apikey, x-client-info');
    }
  }
  if (request.method === 'OPTIONS' && requestUrl.pathname.startsWith('/api/')) {
    response.writeHead(origin && !isAllowedCorsOrigin(origin) ? 403 : 204).end();
    return;
  }
  if (requestUrl.pathname.startsWith('/api/')) {
    handleApi(request, response, requestUrl).then(handled => {
      if (!handled && !response.writableEnded) response.writeHead(404).end('Not found');
    }).catch(() => {
      if (!response.writableEnded) response.writeHead(500).end('API request failed');
    });
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(requestUrl.pathname); }
  catch { response.writeHead(400).end('Bad request'); return; }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!publicFiles.has(relative)) {
    response.writeHead(404).end('Not found');
    return;
  }
  const target = path.join(root, relative);
  fs.readFile(target, (error, contents) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    response.end(contents);
  });
  });
}

if (require.main === module) {
  createHttpServer().listen(port, '0.0.0.0', () => {
    console.log(`ECU File Service India is listening on port ${port}`);
  });
} else if (process.env.NODE_ENV === 'test') {
  module.exports = {
    createHttpServer,
    setTestUpstreamRequest(handler) {
      if (handler !== null && typeof handler !== 'function') throw new TypeError('Test upstream must be a function or null.');
      testUpstreamRequest = handler;
    }
  };
}
