const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = __dirname;
try {
  const envText = fs.readFileSync(path.join(root, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && (!process.env[match[1]] || process.env[match[1]].trim() === '')) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const port = Number(process.env.PORT) || 4173;
const pricingFile = path.join(root, 'pricing.local.json');
const defaultFileVerificationPricePaise = 9900;
const maxFileVerificationPricePaise = 100000000;
const maxOriginalFileBytes = 50 * 1024 * 1024;
const allowedCorsOrigins = new Set(['https://ecufileservice.in', 'https://www.ecufileservice.in']);
const publicFiles = new Set(['index.html', 'admin.html', 'styles.css', 'admin.css', 'app.js', 'auth.js', 'supabase.js']);
const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8'
};

const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseHostname = (() => { try { return new URL(supabaseUrl).hostname; } catch { return ''; } })();
const razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || '';
const paypalClientId = process.env.PAYPAL_CLIENT_ID || '';
const paypalClientSecret = process.env.PAYPAL_CLIENT_SECRET || '';
const paypalBaseUrl = (process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com').replace(/\/$/, '');
const resendApiKey = process.env.RESEND_API_KEY || '';
const emailFrom = process.env.EMAIL_FROM || '';
const adminNotificationEmail = process.env.ADMIN_NOTIFICATION_EMAIL || '';
const paymentGateProofSecret = process.env.PAYMENT_GATE_PROOF_SECRET || '';
const paymentGateSchemaReady = process.env.PAYMENT_GATE_SCHEMA_READY === 'true';
const maxJsonBytes = 64 * 1024;
const paymentAttempts = new Map();
const completingPayments = new Map();
const customerAuthTimeoutMs = 20000;
const outboundHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32, rejectUnauthorized: true });
const maxUpstreamResponseBytes = 75 * 1024 * 1024;
let testUpstreamRequest = null;
let notificationWorkerTimer = null;
let notificationWorkerRunning = false;
let cleanupWorkerTimer = null;

function isPublicClientKey(key) {
  if (!key || /^sb_secret_/i.test(key)) return false;
  const parts = key.split('.');
  if (parts.length === 3) {
    try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role === 'anon'; } catch { return false; }
  }
  return /^sb_publishable_/.test(key);
}
function isLegacyAnonJwt(key) {
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role === 'anon'; } catch { return false; }
}
const hasSafeSupabaseConfig = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl) && isPublicClientKey(supabaseAnonKey);
function paymentStateReady() { return paymentGateProofSecret.length >= 32 && paymentGateSchemaReady; }
function hasRazorpayConfig() {
  return /^rzp_(?:test|live)_[A-Za-z0-9]+$/.test(razorpayKeyId) && razorpayKeySecret.length >= 16;
}
function hasPayPalConfig() {
  const hostOk = paypalBaseUrl === 'https://api-m.sandbox.paypal.com' || paypalBaseUrl === 'https://api-m.paypal.com';
  return hostOk && paypalClientId.length >= 10 && paypalClientSecret.length >= 10;
}
function hasResendConfig() {
  return /^re_[A-Za-z0-9_-]{10,}$/.test(resendApiKey) && emailFrom.includes('@') && adminNotificationEmail.includes('@');
}
function paymentsConfigured() { return hasSafeSupabaseConfig && Boolean(supabaseServiceRoleKey) && paymentStateReady() && (hasRazorpayConfig() || hasPayPalConfig()); }
function paymentReadinessChecks() {
  return {
    supabaseUrl: /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl),
    supabasePublicKey: isPublicClientKey(supabaseAnonKey),
    razorpay: hasRazorpayConfig(),
    paypal: hasPayPalConfig(),
    resend: hasResendConfig(),
    paymentProofSecret: paymentGateProofSecret.length >= 32,
    schemaReady: paymentGateSchemaReady,
    serviceRoleAvailable: Boolean(supabaseServiceRoleKey)
  };
}

function isAllowedCorsOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.origin === origin && (allowedCorsOrigins.has(origin) || (url.protocol === 'https:' && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.onrender\.com$/i.test(url.hostname)));
  } catch { return false; }
}

function requestHttps(urlValue, { method = 'GET', headers = {}, body, timeoutMs = 15000, streamResponse = false } = {}) {
  if (testUpstreamRequest) return testUpstreamRequest(urlValue, { method, headers, body, timeoutMs });
  const url = new URL(urlValue);
  const allowed = url.protocol === 'https:' && (
    (supabaseHostname && url.hostname === supabaseHostname) ||
    url.hostname === 'api.razorpay.com' ||
    url.hostname === 'api-m.sandbox.paypal.com' ||
    url.hostname === 'api-m.paypal.com' ||
    url.hostname === 'api.resend.com'
  );
  if (!allowed) return Promise.reject(new Error('Blocked unsupported upstream HTTPS destination.'));
  const payload = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const requestHeaders = { ...headers };
  if (payload && !Object.keys(requestHeaders).some(name => name.toLowerCase() === 'content-length')) requestHeaders['Content-Length'] = String(payload.length);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const done = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const req = https.request(url, { method, headers: requestHeaders, agent: outboundHttpsAgent, rejectUnauthorized: true }, response => {
      if (streamResponse) {
        response.status = response.statusCode || 0;
        response.ok = response.status >= 200 && response.status < 300;
        settled = true;
        clearTimeout(timer);
        resolve(response);
        return;
      }
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
        const headersView = { get: name => {
          const value = response.headers[String(name).toLowerCase()];
          return Array.isArray(value) ? value.join(', ') : value || null;
        } };
        done(resolve, {
          status: response.statusCode || 0,
          ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
          headers: headersView,
          body: { cancel: async () => {} },
          json: async () => JSON.parse(responseBody.toString('utf8')),
          text: async () => responseBody.toString('utf8'),
          arrayBuffer: async () => responseBody.buffer.slice(responseBody.byteOffset, responseBody.byteOffset + responseBody.byteLength)
        });
      });
    });
    req.once('error', error => done(reject, error));
    timer = setTimeout(() => {
      const error = new Error('Upstream HTTPS request timed out.');
      error.code = 'ETIMEDOUT';
      req.destroy(error);
    }, timeoutMs);
    req.end(payload || undefined);
  });
}

function jsonResponse(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(payload));
}
function bearerToken(request) {
  const match = String(request.headers.authorization || '').match(/^Bearer\s+([A-Za-z0-9._~-]+)$/i);
  return match?.[1] || null;
}
async function readJson(request, limit = maxJsonBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }); }
}

async function requireCustomer(request) {
  const token = bearerToken(request);
  if (!token || !hasSafeSupabaseConfig) return null;
  let response;
  try {
    response = await requestHttps(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` }, timeoutMs: customerAuthTimeoutMs });
  } catch (error) {
    const e = new Error(error.code === 'ETIMEDOUT' ? 'Supabase sign-in verification timed out. Please retry.' : 'Supabase could not verify your sign-in. Please retry.');
    e.statusCode = error.code === 'ETIMEDOUT' ? 504 : 502;
    throw e;
  }
  if (!response.ok) { await response.body?.cancel(); return null; }
  const user = await response.json();
  return user?.id ? { id: user.id, token, user } : null;
}
async function requireAdmin(request) {
  const customer = await requireCustomer(request);
  if (!customer) return null;
  if (customer.user?.app_metadata?.role !== 'admin') return null;
  return customer;
}

async function supabaseRequest(token, route, { method = 'GET', body, prefer, headers = {}, timeoutMs = 30000 } = {}) {
  return requestHttps(`${supabaseUrl}/${route}`, {
    method,
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}),
    timeoutMs
  });
}
function serviceToken() { return supabaseServiceRoleKey || supabaseAnonKey; }

function sanitizeFileName(value) {
  return String(value || 'original.bin').normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(-180) || 'original.bin';
}
function orderHash(order) { return crypto.createHash('sha256').update(JSON.stringify(order)).digest('hex'); }
function paymentProof(customerId, intentId, provider, providerOrderId, providerPaymentId, amount, requestSha256) {
  return crypto.createHmac('sha256', paymentGateProofSecret)
    .update(['EFSI_PAYMENT_CONFIRMATION_V2', customerId, intentId, provider, providerOrderId, providerPaymentId, amount, requestSha256].join('|')).digest('hex');
}
function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function normalizePaymentRequest(value) {
  const allowedCategories = ['ECU', 'AIRBAG', 'DASHBOARD'];
  const allowedServices = ['DTC OFF', 'DPF OFF', 'AdBlue / SCR OFF', 'EGR OFF', 'O2 Remove', 'EVAP OFF', 'Decat', 'IMMO OFF', 'Speed Limit', 'Custom Request'];
  const clean = item => typeof item === 'string' ? item.trim() : '';
  const category = clean(value?.category);
  const services = Array.isArray(value?.selectedServices) ? [...new Set(value.selectedServices.filter(item => allowedServices.includes(item)))] : [];
  const yearText = clean(value?.vehicleYear);
  const year = yearText ? Number(yearText) : null;
  if (!allowedCategories.includes(category) || !clean(value?.vehicleBrand) || !clean(value?.vehicleType) || !clean(value?.vehicleModel) || !clean(value?.contactName) || !clean(value?.contactPhone) || services.length === 0) throw new Error('Please complete the required vehicle, service and contact details.');
  if (year !== null && (!Number.isInteger(year) || year < 1950 || year > 2100)) throw new Error('Enter a valid vehicle year.');
  if ((category === 'AIRBAG' || category === 'DASHBOARD') && year === null) throw new Error('Year is required for Airbag and Dashboard requests.');
  const isEcu = category === 'ECU';
  const result = {
    category,
    vehicleBrand: clean(value.vehicleBrand).slice(0, 100), vehicleType: clean(value.vehicleType).slice(0, 100), vehicleModel: clean(value.vehicleModel).slice(0, 160), vehicleYear: year,
    ecuManufacturer: isEcu ? (clean(value.ecuManufacturer).slice(0, 100) || null) : null,
    ecuModel: isEcu ? (clean(value.ecuModel).slice(0, 120) || null) : null,
    readingTool: isEcu ? (clean(value.readingTool).slice(0, 100) || null) : null,
    selectedServices: services,
    notes: clean(value.notes).replace(/\[EFSI_[A-Z0-9_]+\]/gi, '').slice(0, 3600) || null,
    contactName: clean(value.contactName).slice(0, 120), contactPhone: clean(value.contactPhone).slice(0, 40), contactEmail: clean(value.contactEmail).slice(0, 254) || null,
    originalName: clean(value.originalName).slice(0, 255), originalMime: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(clean(value.originalMime)) ? clean(value.originalMime).slice(0, 120) : 'application/octet-stream',
    originalSize: Number(value.originalSize), originalSha256: clean(value.originalSha256).toLowerCase()
  };
  if (!result.originalName || !Number.isSafeInteger(result.originalSize) || result.originalSize < 1 || result.originalSize > maxOriginalFileBytes || !/^[a-f0-9]{64}$/.test(result.originalSha256)) throw new Error('Select a valid original file up to 50 MB and try again.');
  return result;
}

function intentStoragePath(customerId, sha256) { void customerId; return `content/${sha256}`; }

async function fetchIntent(customer, intentId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(intentId || ''))) return null;
  const select = 'id,customer_id,status,payment_status,payment_provider,provider_order_id,provider_payment_id,request_sha256,original_name,original_mime,original_size,original_sha256,storage_path,amount_paise,currency,expires_at,file_staged_at,paid_at,order_id,updated_at';
  const result = await supabaseRequest(customer.token, `rest/v1/checkout_intents?select=${select}&id=eq.${encodeURIComponent(intentId)}&customer_id=eq.${encodeURIComponent(customer.id)}&limit=1`, { timeoutMs: 15000 });
  if (!result.ok) return null;
  const rows = await result.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function createCheckoutIntent(customer, order) {
  const token = serviceToken();
  const expectedHash = orderHash(order);
  const pricing = readPricing();
  const existingResponse = await supabaseRequest(token, `rest/v1/checkout_intents?select=id,status,amount_paise,currency,request_sha256,original_name,original_size,original_sha256,storage_path,payment_provider,provider_order_id,payment_status,expires_at&customer_id=eq.${encodeURIComponent(customer.id)}&request_sha256=eq.${expectedHash}&status=in.(DRAFT,FILE_STAGED,PAYMENT_PENDING)&order=created_at.desc&limit=1`, { timeoutMs: 15000 });
  if (existingResponse.ok) {
    const rows = await existingResponse.json();
    if (rows?.[0]) return rows[0];
  }
  const id = crypto.randomUUID();
  const payload = {
    id, customer_id: customer.id, status: 'DRAFT', request_json: order, request_sha256: expectedHash,
    original_name: order.originalName, original_mime: order.originalMime, original_size: order.originalSize, original_sha256: order.originalSha256,
    storage_path: intentStoragePath(customer.id, order.originalSha256), amount_paise: pricing.fileVerificationPricePaise, currency: pricing.currency,
    payment_status: 'PENDING', expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
  };
  const response = await supabaseRequest(token, 'rest/v1/checkout_intents', { method: 'POST', prefer: 'return=representation', body: payload, timeoutMs: 15000 });
  if (response.status === 409) {
    const retry = await supabaseRequest(token, `rest/v1/checkout_intents?select=id,status,amount_paise,currency,request_sha256,original_name,original_mime,original_size,original_sha256,storage_path,payment_provider,provider_order_id,provider_payment_id,payment_status,expires_at,order_id,created_at,updated_at&customer_id=eq.${encodeURIComponent(customer.id)}&request_sha256=eq.${expectedHash}&status=in.(DRAFT,FILE_STAGED,PAYMENT_PENDING)&order=created_at.desc&limit=1`, { timeoutMs: 15000 });
    if (retry.ok) { const rows = await retry.json(); if (rows?.[0]) return rows[0]; }
  }
  if (!response.ok) throw new Error('The secure checkout could not be saved. Please retry.');
  const rows = await response.json();
  return rows?.[0] || payload;
}

async function handleCreateCheckoutIntent(request, response) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error: 'Method Not Allowed' }); return true; }
  try {
    const customer = await requireCustomer(request);
    if (!customer) { jsonResponse(response, 401, { error: 'Sign in before saving a checkout.' }); return true; }
    if (!supabaseServiceRoleKey) { jsonResponse(response, 503, { error: 'Durable checkout storage is not configured on this server.' }); return true; }
    const body = await readJson(request);
    const order = normalizePaymentRequest(body?.request);
    const intent = await createCheckoutIntent(customer, order);
    jsonResponse(response, 200, { intentId: intent.id, status: intent.status, amount: intent.amount_paise, currency: intent.currency, storagePath: intent.storage_path, expiresAt: intent.expires_at, requestSha256: intent.request_sha256 });
  } catch (error) { jsonResponse(response, error.statusCode || 400, { error: error.message || 'Checkout could not be saved.' }); }
  return true;
}

async function verifyStoredObject(customer, intent) {
  if (!intent?.storage_path || !/^content\/[a-f0-9]{64}$/.test(intent.storage_path)) return { ok:false, status:400, error:'The private storage reference is invalid.' };
  if (!Number.isSafeInteger(Number(intent.original_size)) || Number(intent.original_size) < 1 || Number(intent.original_size) > maxOriginalFileBytes) return { ok:false, status:400, error:'The staged file metadata is invalid.' };
  const encoded = intent.storage_path.split('/').map(encodeURIComponent).join('/');
  // In tests the upstream mock returns a fetch-like response. In production, the file is
  // streamed through Node in bounded chunks and hashed without buffering the whole file.
  if (testUpstreamRequest) {
    const response = await supabaseRequest(serviceToken(), `storage/v1/object/private-ecu-files/${encoded}`, { method:'GET', timeoutMs:60000 });
    if (!response.ok) return { ok:false, status:409, error:'The original file is not present in private storage. Upload it again.' };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== Number(intent.original_size)) return { ok:false, status:409, error:'The staged file size does not match the saved checkout.' };
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    return safeEqualHex(digest, intent.original_sha256) ? { ok:true } : { ok:false, status:409, error:'The staged file hash does not match the saved checkout. Upload the original file again.' };
  }
  let response;
  try {
    response = await requestHttps(`${supabaseUrl}/storage/v1/object/private-ecu-files/${encoded}`, { method:'GET', headers:{ apikey:supabaseAnonKey, Authorization:`Bearer ${serviceToken()}` }, timeoutMs:60000, streamResponse:true });
  } catch {
    // requestHttps intentionally buffers normal calls; the streamResponse branch is available below.
    return { ok:false, status:502, error:'The private file could not be verified right now. Please retry.' };
  }
  const stream = response;
  if (!stream.ok) { stream.destroy?.(); return { ok:false, status:409, error:'The original file is not present in private storage. Upload it again.' }; }
  let total=0; const digest=crypto.createHash('sha256');
  return await new Promise(resolve=>{
    let done=false;
    const finish=result=>{ if(done)return; done=true; clearTimeout(timer); resolve(result); };
    const timer=setTimeout(()=>{ stream.destroy?.(); finish({ok:false,status:504,error:'The private file verification timed out. Please retry.'}); },60000);
    stream.on('data',chunk=>{ total += chunk.length; if(total > maxOriginalFileBytes){ stream.destroy?.(); finish({ok:false,status:413,error:'The staged file exceeds the 50 MB limit.'}); return; } digest.update(chunk); });
    stream.once('error',()=>finish({ok:false,status:502,error:'The private file could not be read for verification.'}));
    stream.once('end',()=>{
      if(total !== Number(intent.original_size)) return finish({ok:false,status:409,error:'The staged file size does not match the saved checkout.'});
      const got=digest.digest('hex');
      finish(safeEqualHex(got,intent.original_sha256)?{ok:true}:{ok:false,status:409,error:'The staged file hash does not match the saved checkout. Upload the original file again.'});
    });
  });
}

async function handleStageCheckoutIntent(request, response, intentId) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error: 'Method Not Allowed' }); return true; }
  try {
    const customer = await requireCustomer(request);
    if (!customer) { jsonResponse(response, 401, { error: 'Sign in before staging a file.' }); return true; }
    const intent = await fetchIntent(customer, intentId);
    if (!intent) { jsonResponse(response, 404, { error: 'Checkout request not found.' }); return true; }
    if (new Date(intent.expires_at).getTime() <= Date.now()) { jsonResponse(response, 410, { error: 'This checkout expired. Start a new request.' }); return true; }
    if (!['DRAFT','FILE_STAGED','PAYMENT_PENDING'].includes(intent.status) || intent.payment_status !== 'PENDING') { jsonResponse(response, 409, { error: 'This checkout is no longer awaiting file staging.' }); return true; }
    const integrity = await verifyStoredObject(customer, intent);
    if (!integrity.ok) { jsonResponse(response, integrity.status || 409, { error: integrity.error }); return true; }
    const patch = await supabaseRequest(serviceToken(), `rest/v1/checkout_intents?id=eq.${encodeURIComponent(intent.id)}&customer_id=eq.${encodeURIComponent(customer.id)}`, { method: 'PATCH', prefer: 'return=representation', body: { status: 'FILE_STAGED', file_staged_at: new Date().toISOString() }, timeoutMs: 15000 });
    if (!patch.ok) throw new Error('The secure file stage could not be saved.');
    const rows = await patch.json();
    const saved = rows?.[0] || { ...intent, status: 'FILE_STAGED' };
    jsonResponse(response, 200, { intentId: saved.id, status: saved.status, amount: saved.amount_paise, currency: saved.currency, provider: saved.payment_provider || null, providerOrderId: saved.provider_order_id || null });
  } catch (error) { jsonResponse(response, error.statusCode || 400, { error: error.message || 'File staging failed.' }); }
  return true;
}

function readPricing() {
  try {
    const saved = JSON.parse(fs.readFileSync(pricingFile, 'utf8'));
    const price = saved.fileVerificationPricePaise;
    if (!Number.isSafeInteger(price) || price < 0 || price > maxFileVerificationPricePaise) throw new Error('Stored pricing configuration is invalid.');
    return { currency: 'INR', fileVerificationPricePaise: price };
  } catch (error) {
    if (error.code === 'ENOENT') return { currency: 'INR', fileVerificationPricePaise: defaultFileVerificationPricePaise };
    throw error;
  }
}

async function razorpayApi(route, { method = 'GET', body } = {}) {
  if (!hasRazorpayConfig()) throw Object.assign(new Error('Razorpay is not configured on this server.'), { statusCode: 503, code: 'RAZORPAY_CONFIG' });
  const credentials = Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64');
  let response;
  try {
    response = await requestHttps(`https://api.razorpay.com/v1/${route}`, { method, headers: { Authorization: `Basic ${credentials}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), timeoutMs: 15000 });
  } catch (error) { throw Object.assign(new Error('Razorpay is temporarily unavailable. Please retry.'), { code: 'RAZORPAY_UPSTREAM', statusCode: 502, cause: error }); }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(response.status === 401 || response.status === 403 ? 'Razorpay credentials were rejected.' : 'Razorpay rejected the payment request.'), { code: 'RAZORPAY_UPSTREAM', statusCode: response.status >= 500 ? 502 : response.status });
  return payload;
}

async function paypalApiToken() {
  if (!hasPayPalConfig()) throw Object.assign(new Error('PayPal is not configured on this server.'), { statusCode: 503, code: 'PAYPAL_CONFIG' });
  const credentials = Buffer.from(`${paypalClientId}:${paypalClientSecret}`).toString('base64');
  const response = await requestHttps(`${paypalBaseUrl}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: 'grant_type=client_credentials', timeoutMs: 15000 });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) throw Object.assign(new Error('PayPal authentication failed.'), { code: 'PAYPAL_UPSTREAM', statusCode: response.status >= 500 ? 502 : 503 });
  return body.access_token;
}
async function paypalApi(route, { method = 'GET', body, token } = {}) {
  const access = token || await paypalApiToken();
  const response = await requestHttps(`${paypalBaseUrl}/${route}`, { method, headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(method === 'POST' ? { 'PayPal-Request-Id': crypto.randomUUID() } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), timeoutMs: 20000 });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error('PayPal payment request was rejected.'), { code: 'PAYPAL_UPSTREAM', statusCode: response.status >= 500 ? 502 : response.status, payload });
  return payload;
}
async function paypalApiIdempotent(route, { method = 'POST', body, requestId }) {
  const access = await paypalApiToken();
  const response = await requestHttps(`${paypalBaseUrl}/${route}`, { method, headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', Accept: 'application/json', 'PayPal-Request-Id': requestId }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), timeoutMs: 20000 });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error('PayPal payment request was rejected.'), { code: 'PAYPAL_UPSTREAM', statusCode: response.status >= 500 ? 502 : response.status, payload });
  return payload;
}

async function updateIntent(customer, intentId, body) {
  const response = await supabaseRequest(serviceToken(), `rest/v1/checkout_intents?id=eq.${encodeURIComponent(intentId)}&customer_id=eq.${encodeURIComponent(customer.id)}`, { method: 'PATCH', prefer: 'return=representation', body, timeoutMs: 15000 });
  if (!response.ok) throw new Error('The payment state could not be saved.');
  const rows = await response.json();
  return rows?.[0] || null;
}

async function getOrCreateRazorpayOrder(customer, intent) {
  const existingProvider = String(intent.payment_provider || '');
  const existingProviderOrder = String(intent.provider_order_id || '');
  if (existingProvider && existingProvider !== 'razorpay' && existingProviderOrder) throw Object.assign(new Error('This checkout already has a PayPal payment session. Resume it or start a new request.'), { statusCode: 409 });
  const price = Number(intent.amount_paise);
  if (!Number.isSafeInteger(price) || price < 1) throw new Error('The checkout amount is invalid.');
  if (intent.payment_provider === 'razorpay' && /^order_[A-Za-z0-9]+$/.test(String(intent.provider_order_id || ''))) return { id: intent.provider_order_id, amount: price, currency: 'INR' };
  const requestId = crypto.randomUUID();
  const order = await razorpayApi('orders', { method: 'POST', body: { amount: price, currency: 'INR', receipt: `efsi_${requestId.replaceAll('-', '').slice(0, 32)}`, notes: { customer_id: customer.id, request_sha256: intent.request_sha256, checkout_intent_id: intent.id, verification_amount_paise: String(price) } } });
  if (!/^order_[A-Za-z0-9]+$/.test(String(order?.id || '')) || order.amount !== price || order.currency !== 'INR' || order?.notes?.customer_id !== customer.id || order?.notes?.checkout_intent_id !== intent.id || order?.notes?.request_sha256 !== intent.request_sha256) throw Object.assign(new Error('Razorpay returned an invalid checkout order.'), { statusCode: 502 });
  await updateIntent(customer, intent.id, { status: 'PAYMENT_PENDING', payment_provider: 'razorpay', provider_order_id: order.id, payment_status: 'PENDING' });
  return order;
}
async function handleCreateRazorpayOrder(request, response) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error: 'Method Not Allowed' }); return true; }
  try {
    const customer = await requireCustomer(request);
    if (!customer) { jsonResponse(response, 401, { error: 'Sign in before paying.' }); return true; }
    const body = await readJson(request);
    const intent = await fetchIntent(customer, body?.intentId);
    if (!intent) { jsonResponse(response, 404, { error: 'Checkout request not found.' }); return true; }
    if (!['FILE_STAGED', 'PAYMENT_PENDING'].includes(intent.status) || new Date(intent.expires_at).getTime() <= Date.now()) { jsonResponse(response, 409, { error: 'Complete file upload before starting payment, or start a new checkout.' }); return true; }
    const order = await getOrCreateRazorpayOrder(customer, intent);
    jsonResponse(response, 200, { provider: 'razorpay', keyId: razorpayKeyId, providerOrderId: order.id, amount: order.amount, currency: order.currency, businessName: 'ECU FILE SERVICE INDIA', intentId: intent.id });
  } catch (error) { jsonResponse(response, error.statusCode || (error.code === 'RAZORPAY_UPSTREAM' ? 502 : 400), { error: error.message || 'Razorpay checkout could not be created.' }); }
  return true;
}

async function getOrCreatePayPalOrder(customer, intent) {
  const existingProvider = String(intent.payment_provider || '');
  const existingProviderOrder = String(intent.provider_order_id || '');
  if (existingProvider === 'razorpay' && existingProviderOrder) throw Object.assign(new Error('This checkout already has a Razorpay payment session. Resume it or start a new request.'), { statusCode: 409 });
  const price = Number(intent.amount_paise);
  const existing = String(intent.provider_order_id || '');
  if (intent.payment_provider === 'paypal' && /^[A-Z0-9-]+$/.test(existing)) {
    const current = await paypalApi(`v2/checkout/orders/${encodeURIComponent(existing)}`, { method: 'GET' });
    const approval = Array.isArray(current?.links) ? current.links.find(link => link.rel === 'approve') : null;
    if (current?.id === existing && current?.status !== 'COMPLETED' && approval?.href) return { ...current, links: current.links };
    if (current?.status === 'COMPLETED') return { ...current, links: [], alreadyCompleted: true };
  }
  const paypalOrder = await paypalApiIdempotent('v2/checkout/orders', {
    requestId: `efsi/${intent.id}`,
    body: {
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: intent.id, custom_id: intent.id, invoice_id: intent.id, amount: { currency_code: 'INR', value: (price / 100).toFixed(2) } }],
      application_context: { brand_name: 'ECU FILE SERVICE INDIA', user_action: 'PAY_NOW', return_url: `${process.env.PUBLIC_APP_URL || 'https://ecufileservice.in'}/?paypal_return=1&intent=${encodeURIComponent(intent.id)}`, cancel_url: `${process.env.PUBLIC_APP_URL || 'https://ecufileservice.in'}/?paypal_cancel=1&intent=${encodeURIComponent(intent.id)}` }
    }
  });
  if (!/^[A-Z0-9-]+$/.test(String(paypalOrder?.id || '')) || paypalOrder?.intent !== 'CAPTURE') throw Object.assign(new Error('PayPal returned an invalid checkout order.'), { statusCode: 502 });
  const approval = Array.isArray(paypalOrder.links) ? paypalOrder.links.find(link => link.rel === 'approve') : null;
  if (!approval?.href) throw Object.assign(new Error('PayPal approval link was not returned.'), { statusCode: 502 });
  await updateIntent(customer, intent.id, { status: 'PAYMENT_PENDING', payment_provider: 'paypal', provider_order_id: paypalOrder.id, payment_status: 'PENDING' });
  return paypalOrder;
}
async function handleCreatePayPalOrder(request, response) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error: 'Method Not Allowed' }); return true; }
  try {
    const customer = await requireCustomer(request);
    if (!customer) { jsonResponse(response, 401, { error: 'Sign in before paying.' }); return true; }
    const body = await readJson(request);
    const intent = await fetchIntent(customer, body?.intentId);
    if (!intent) { jsonResponse(response, 404, { error: 'Checkout request not found.' }); return true; }
    if (!['FILE_STAGED', 'PAYMENT_PENDING'].includes(intent.status) || new Date(intent.expires_at).getTime() <= Date.now()) { jsonResponse(response, 409, { error: 'Complete file upload before starting payment, or start a new checkout.' }); return true; }
    const paypalOrder = await getOrCreatePayPalOrder(customer, intent);
    if (paypalOrder?.alreadyCompleted) {
      const purchase = paypalOrder?.purchase_units?.[0];
      const capture = purchase?.payments?.captures?.[0];
      const paymentId = String(capture?.id || '');
      const amount = purchase?.amount;
      if (paypalOrder.id === intent.provider_order_id && purchase?.custom_id === intent.id && capture?.status === 'COMPLETED' && amount?.currency_code === intent.currency && Number(amount?.value) === Number((Number(intent.amount_paise) / 100).toFixed(2)) && paymentId) {
        const orderId = await finalizePaidCheckout(customer, intent, { provider:'paypal', providerOrderId:paypalOrder.id, providerPaymentId:paymentId });
        triggerNotificationWorker();
        jsonResponse(response, 200, { provider:'paypal', providerOrderId:paypalOrder.id, approvalUrl:null, intentId:intent.id, status:'PAID', orderId });
        return true;
      }
      throw new Error('PayPal reported a completed checkout, but its verified capture data could not be recovered safely.');
    }
    const approval = Array.isArray(paypalOrder.links) ? paypalOrder.links.find(link => link.rel === 'approve') : null;
    jsonResponse(response, 200, { provider: 'paypal', providerOrderId: paypalOrder.id, approvalUrl: approval?.href || null, intentId: intent.id });
  } catch (error) { jsonResponse(response, error.statusCode || (error.code === 'PAYPAL_UPSTREAM' ? 502 : 400), { error: error.message || 'PayPal checkout could not be created.' }); }
  return true;
}

async function finalizePaidCheckout(customer, intent, payment) {
  const proof = paymentProof(customer.id, intent.id, payment.provider, payment.providerOrderId, payment.providerPaymentId, intent.amount_paise, intent.request_sha256);
  const body = {
    p_intent_id: intent.id,
    p_payment_provider: payment.provider,
    p_provider_order_id: payment.providerOrderId,
    p_provider_payment_id: payment.providerPaymentId,
    p_amount_paise: intent.amount_paise,
    p_currency: intent.currency,
    p_paid_at: new Date().toISOString(),
    p_payment_proof: proof
  };
  const response = await supabaseRequest(customer.token, 'rest/v1/rpc/efsi_finalize_paid_checkout', { method: 'POST', body, timeoutMs: 20000 });
  if (!response.ok) {
    const details = await response.json().catch(() => null);
    const error = new Error(details?.message || 'Payment was verified, but the order could not be finalized. Keep your account open and retry; do not pay again.');
    error.statusCode = response.status >= 500 ? 502 : 400;
    throw error;
  }
  const result = await response.json().catch(() => null);
  return result?.id || result || intent.id;
}

async function handleVerifyRazorpay(request, response, { reconcile = false, bodyData = null } = {}) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error: 'Method Not Allowed' }); return true; }
  try {
    const customer = await requireCustomer(request);
    if (!customer) { jsonResponse(response, 401, { error: 'Your customer session expired. Sign in and retry.' }); return true; }
    const body = bodyData || await readJson(request);
    const intentId = String(body?.intentId || '');
    const intent = await fetchIntent(customer, intentId);
    if (!intent) { jsonResponse(response, 404, { error: 'Checkout request could not be found.' }); return true; }
    if (intent.status === 'PAID' && intent.payment_status === 'PAID') { jsonResponse(response, 200, { status: 'PAID', orderId: intent.order_id || intent.id }); return true; }
    const providerOrderId = String(body?.razorpayOrderId || body?.razorpay_order_id || intent.provider_order_id || '');
    const paymentId = String(body?.razorpayPaymentId || body?.razorpay_payment_id || '');
    const signature = String(body?.razorpaySignature || body?.razorpay_signature || '');
    if (!/^order_[A-Za-z0-9]+$/.test(providerOrderId) || !/^pay_[A-Za-z0-9]+$/.test(paymentId)) { jsonResponse(response, 400, { error: 'Valid Razorpay references are required.' }); return true; }
    if (!reconcile) {
      const expected = crypto.createHmac('sha256', razorpayKeySecret).update(`${providerOrderId}|${paymentId}`).digest('hex');
      if (!safeEqualHex(signature, expected)) { jsonResponse(response, 402, { error: 'Payment signature could not be verified.' }); return true; }
    }
    const razorOrder = await razorpayApi(`orders/${encodeURIComponent(providerOrderId)}`);
    if (razorOrder?.id !== providerOrderId || Number(razorOrder?.amount) !== Number(intent.amount_paise) || razorOrder?.currency !== intent.currency || razorOrder?.notes?.checkout_intent_id !== intent.id || razorOrder?.notes?.customer_id !== customer.id || razorOrder?.notes?.request_sha256 !== intent.request_sha256) { jsonResponse(response, 402, { error: 'The payment order does not match this checkout.' }); return true; }
    const payment = await razorpayApi(`payments/${encodeURIComponent(paymentId)}`);
    if (payment?.order_id !== providerOrderId || payment?.status !== 'captured' || Number(payment?.amount) !== Number(intent.amount_paise) || payment?.currency !== intent.currency) { jsonResponse(response, 402, { error: 'The payment is not confirmed as captured for the required amount.' }); return true; }
    const existing = completingPayments.get(intent.id);
    if (existing) { const orderId = await existing; jsonResponse(response, 200, { status: 'PAID', orderId }); return true; }
    const task = finalizePaidCheckout(customer, intent, { provider: 'razorpay', providerOrderId, providerPaymentId: paymentId });
    completingPayments.set(intent.id, task);
    try {
      const orderId = await task;
      jsonResponse(response, 200, { status: 'PAID', orderId });
      triggerNotificationWorker();
    } finally { completingPayments.delete(intent.id); }
  } catch (error) { jsonResponse(response, error.statusCode || (error.code === 'RAZORPAY_UPSTREAM' ? 502 : 400), { error: error.message || 'Razorpay payment could not be verified.' }); }
  return true;
}

async function handleCapturePayPal(request, response, { reconcile = false, bodyData = null } = {}) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error: 'Method Not Allowed' }); return true; }
  try {
    const customer = await requireCustomer(request);
    if (!customer) { jsonResponse(response, 401, { error: 'Your customer session expired. Sign in and retry.' }); return true; }
    const body = bodyData || await readJson(request);
    const intent = await fetchIntent(customer, body?.intentId);
    if (!intent) { jsonResponse(response, 404, { error: 'Checkout request could not be found.' }); return true; }
    if (intent.status === 'PAID' && intent.payment_status === 'PAID') { jsonResponse(response, 200, { status: 'PAID', orderId: intent.order_id || intent.id }); return true; }
    if (intent.payment_provider && intent.payment_provider !== 'paypal') { jsonResponse(response, 409, { error: 'This checkout is already reserved for another payment provider.' }); return true; }
    const providerOrderId = String(body?.paypalOrderId || body?.paypal_order_id || intent.provider_order_id || '');
    if (!/^[A-Z0-9-]+$/.test(providerOrderId)) { jsonResponse(response, 400, { error: 'Valid PayPal order reference is required.' }); return true; }
    const existing = completingPayments.get(intent.id);
    if (existing) { const orderId = await existing; jsonResponse(response, 200, { status: 'PAID', orderId }); return true; }
    const paypalOrder = await paypalApi(`v2/checkout/orders/${encodeURIComponent(providerOrderId)}`, { method: 'GET' });
    const purchase = paypalOrder?.purchase_units?.[0];
    const amount = purchase?.amount;
    const matches = paypalOrder?.id === providerOrderId && purchase?.custom_id === intent.id && amount?.currency_code === intent.currency && Number(amount?.value) === Number((Number(intent.amount_paise) / 100).toFixed(2));
    if (!matches) { jsonResponse(response, 402, { error: 'The PayPal order does not match this checkout.' }); return true; }
    let captured = paypalOrder;
    if (paypalOrder.status !== 'COMPLETED') {
      captured = await paypalApiIdempotent(`v2/checkout/orders/${encodeURIComponent(providerOrderId)}/capture`, { requestId: `efsi-capture/${intent.id}`, body: {} });
    }
    const capture = captured?.purchase_units?.[0]?.payments?.captures?.[0];
    const captureAmount = capture?.amount;
    if (captured?.status !== 'COMPLETED' || capture?.status !== 'COMPLETED' || captureAmount?.currency_code !== intent.currency || Number(captureAmount?.value) !== Number((Number(intent.amount_paise) / 100).toFixed(2))) { jsonResponse(response, 402, { error: 'PayPal payment was not confirmed as captured.' }); return true; }
    const paymentId = String(capture.id || '');
    if (!paymentId) { jsonResponse(response, 502, { error: 'PayPal did not return a capture reference.' }); return true; }
    const task = finalizePaidCheckout(customer, intent, { provider: 'paypal', providerOrderId, providerPaymentId: paymentId });
    completingPayments.set(intent.id, task);
    try { const orderId = await task; jsonResponse(response, 200, { status: 'PAID', orderId }); triggerNotificationWorker(); }
    finally { completingPayments.delete(intent.id); }
  } catch (error) { jsonResponse(response, error.statusCode || (error.code === 'PAYPAL_UPSTREAM' ? 502 : 400), { error: error.message || 'PayPal payment could not be captured.' }); }
  return true;
}

async function handleReconcilePayment(request, response) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error: 'Method Not Allowed' }); return true; }
  try {
    const customer = await requireCustomer(request);
    if (!customer) { jsonResponse(response, 401, { error: 'Sign in to recover your checkout.' }); return true; }
    const body = await readJson(request);
    const intent = await fetchIntent(customer, body?.intentId);
    if (!intent) { jsonResponse(response, 404, { error: 'Checkout request could not be recovered.' }); return true; }
    if (intent.status === 'PAID' && intent.payment_status === 'PAID') { jsonResponse(response, 200, { status: 'PAID', orderId: intent.order_id || intent.id }); return true; }
    if (intent.payment_provider === 'razorpay') {
      if (!body.razorpayPaymentId && !body.razorpay_payment_id) {
        const providerOrderId = String(intent.provider_order_id || '');
        if (!/^order_[A-Za-z0-9]+$/.test(providerOrderId)) { jsonResponse(response, 409, { error:'No provider payment session is available to recover yet.' }); return true; }
        const payments = await razorpayApi(`orders/${encodeURIComponent(providerOrderId)}/payments`);
        const candidates = Array.isArray(payments?.items) ? payments.items.filter(item => item?.status === 'captured' && Number(item.amount) === Number(intent.amount_paise) && item.currency === intent.currency && item.order_id === providerOrderId) : [];
        const payment = candidates[0];
        if (!payment?.id) { jsonResponse(response, 409, { error:'No captured Razorpay payment was found for this saved checkout yet.' }); return true; }
        body.razorpay_payment_id = payment.id;
        body.razorpay_order_id = providerOrderId;
      }
      return handleVerifyRazorpay(request, response, { reconcile: true, bodyData: body });
    }
    if (intent.payment_provider === 'paypal') return handleCapturePayPal(request, response, { reconcile: true, bodyData: body });
    jsonResponse(response, 409, { error: 'This checkout has not started payment yet.' });
  } catch (error) { jsonResponse(response, error.statusCode || 400, { error: error.message || 'Payment recovery failed.' }); }
  return true;
}

async function handleAdminStatus(request, response) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error: 'Method Not Allowed' }); return true; }
  try {
    const admin = await requireAdmin(request);
    if (!admin) { jsonResponse(response, 403, { error: 'Administrator role is required.' }); return true; }
    const body = await readJson(request);
    if (!/^[0-9a-f-]{36}$/i.test(String(body?.orderId || ''))) { jsonResponse(response, 400, { error: 'Invalid order reference.' }); return true; }
    const statuses = ['New', 'File Review', 'Processing', 'Possible', 'Not Possible', 'Completed', 'Cancelled', 'Payment Pending'];
    if (!statuses.includes(body?.status)) { jsonResponse(response, 400, { error: 'Invalid order status.' }); return true; }
    const orderId = String(body.orderId);
    const responseDb = await supabaseRequest(admin.token, `rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&select=id,status,payment_status`, { timeoutMs: 15000 });
    if (!responseDb.ok) { jsonResponse(response, 404, { error: 'Order could not be loaded.' }); return true; }
    const rows = await responseDb.json();
    const current = rows?.[0];
    if (!current) { jsonResponse(response, 404, { error: 'Order not found.' }); return true; }
    if (body.status === 'Completed') {
      const files = await supabaseRequest(admin.token, `rest/v1/order_files?select=id&order_id=eq.${encodeURIComponent(orderId)}&kind=eq.processed&limit=1`, { timeoutMs: 15000 });
      if (!files.ok || (await files.json()).length === 0) { jsonResponse(response, 409, { error: 'Upload a processed file before marking the order Completed.' }); return true; }
    }
    const updated = await supabaseRequest(admin.token, `rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`, { method: 'PATCH', prefer: 'return=representation', body: { status: body.status }, timeoutMs: 15000 });
    if (!updated.ok) {
      const err = await updated.json().catch(() => null);
      jsonResponse(response, updated.status >= 500 ? 502 : 409, { error: err?.message || 'The order status could not be saved.' }); return true;
    }
    jsonResponse(response, 200, { order: (await updated.json())?.[0] || null });
  } catch (error) { jsonResponse(response, error.statusCode || 400, { error: error.message || 'Admin status update failed.' }); }
  return true;
}

function extractPaymentMeta(order) {
  return {
    provider: order.payment_provider || null,
    providerOrderId: order.provider_order_id || order.razorpay_order_id || null,
    providerPaymentId: order.provider_payment_id || order.razorpay_payment_id || null,
    status: order.payment_status || 'PENDING'
  };
}

async function handleAdminPaymentStatus(request, response) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error: 'Method Not Allowed' }); return true; }
  try {
    const admin = await requireAdmin(request);
    if (!admin) { jsonResponse(response, 403, { error: 'Administrator role is required.' }); return true; }
    const body = await readJson(request, 16384);
    const ids = [...new Set(Array.isArray(body?.orderIds) ? body.orderIds.filter(id => /^[0-9a-f-]{36}$/i.test(id)) : [])].slice(0, 100);
    if (!ids.length) { jsonResponse(response, 200, { verified: {} }); return true; }
    const query = `rest/v1/orders?select=id,payment_provider,provider_order_id,provider_payment_id,payment_status,razorpay_order_id,razorpay_payment_id&id=in.(${ids.join(',')})`;
    const rowsResponse = await supabaseRequest(admin.token, query, { timeoutMs: 15000 });
    if (!rowsResponse.ok) { jsonResponse(response, 502, { error: 'Payment records could not be loaded.' }); return true; }
    const rows = await rowsResponse.json();
    jsonResponse(response, 200, { verified: Object.fromEntries(rows.map(order => [order.id, extractPaymentMeta(order)])) });
  } catch (error) { jsonResponse(response, error.statusCode || 400, { error: error.message || 'Payment records could not be loaded.' }); }
  return true;
}

async function handlePricing(request, response) {
  if (request.method === 'GET') {
    try { jsonResponse(response, 200, readPricing()); } catch { jsonResponse(response, 500, { error: 'Pricing configuration could not be loaded.' }); }
    return true;
  }
  if (request.method !== 'PATCH') { jsonResponse(response, 405, { error: 'Method Not Allowed' }); return true; }
  try {
    const admin = await requireAdmin(request);
    if (!admin) { jsonResponse(response, 403, { error: 'Administrator role is required.' }); return true; }
    const body = await readJson(request, 4096);
    const price = body?.fileVerificationPricePaise;
    if (!Number.isSafeInteger(price) || price < 0 || price > maxFileVerificationPricePaise) { jsonResponse(response, 400, { error: 'Enter a whole paise amount from ₹0 to ₹1,000,000.' }); return true; }
    const temp = `${pricingFile}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify({ fileVerificationPricePaise: price }, null, 2), { flag: 'wx' });
    await fs.promises.rename(temp, pricingFile);
    jsonResponse(response, 200, { currency: 'INR', fileVerificationPricePaise: price });
  } catch (error) { if (error?.statusCode) jsonResponse(response, error.statusCode, { error: error.message }); else jsonResponse(response, 500, { error: 'Pricing could not be saved.' }); }
  return true;
}

function escapeSqlText(value) { return String(value || '').replace(/[^a-zA-Z0-9._:@/-]+/g, '').slice(0, 256); }
async function flushNotificationOutbox() {
  if (notificationWorkerRunning || !supabaseServiceRoleKey || !hasResendConfig()) return;
  notificationWorkerRunning = true;
  try {
    const token = serviceToken();
    const response = await supabaseRequest(token, 'rest/v1/notification_outbox?select=id,order_id,event_type,attempts,next_attempt_at&status=in.(PENDING,RETRY)&next_attempt_at=lte.now()&order=created_at.asc&limit=10', { timeoutMs: 15000 });
    if (!response.ok) return;
    const rows = await response.json();
    for (const row of rows) {
      const claim = await supabaseRequest(token, `rest/v1/notification_outbox?id=eq.${encodeURIComponent(row.id)}&status=in.(PENDING,RETRY)`, { method: 'PATCH', prefer: 'return=representation', body: { status: 'SENDING', attempts: Number(row.attempts || 0) + 1, updated_at: new Date().toISOString() }, timeoutMs: 15000 });
      if (!claim.ok) continue;
      const claimedRows = await claim.json().catch(() => []);
      if (!Array.isArray(claimedRows) || !claimedRows.length) continue;
      const orderResponse = await supabaseRequest(token, `rest/v1/orders?select=id,category,vehicle_brand,vehicle_model,vehicle_year,contact_name,contact_phone,contact_email,payment_status,status,payment_provider,provider_order_id,provider_payment_id,created_at&id=eq.${encodeURIComponent(row.order_id)}&limit=1`, { timeoutMs: 15000 });
      if (!orderResponse.ok) {
        await supabaseRequest(token, `rest/v1/notification_outbox?id=eq.${encodeURIComponent(row.id)}&status=eq.SENDING`, { method:'PATCH', prefer:'return=minimal', body:{ status:'RETRY', next_attempt_at:new Date(Date.now()+15*60*1000).toISOString(), last_error:'Order lookup failed before email delivery.', updated_at:new Date().toISOString() }, timeoutMs:15000 }).catch(()=>{});
        continue;
      }
      const order = (await orderResponse.json())?.[0];
      if (!order) {
        await supabaseRequest(token, `rest/v1/notification_outbox?id=eq.${encodeURIComponent(row.id)}&status=eq.SENDING`, { method:'PATCH', prefer:'return=minimal', body:{ status:'RETRY', next_attempt_at:new Date(Date.now()+15*60*1000).toISOString(), last_error:'Referenced order was not found.', updated_at:new Date().toISOString() }, timeoutMs:15000 }).catch(()=>{});
        continue;
      }
      const subject = row.event_type === 'paid_order' ? `Paid order ${order.id}` : `New order ${order.id}`;
      const html = `<h2>ECU FILE SERVICE INDIA</h2><p><strong>${subject}</strong></p><p>Customer: ${String(order.contact_name || '').replace(/[&<>]/g, '')}</p><p>Vehicle: ${[order.vehicle_year, order.vehicle_brand, order.vehicle_model].filter(Boolean).map(v => String(v).replace(/[&<>]/g, '')).join(' ')}</p><p>Category: ${String(order.category || '').replace(/[&<>]/g, '')}</p><p>Status: ${String(order.status || '').replace(/[&<>]/g, '')}</p><p>Payment: ${String(order.payment_status || '').replace(/[&<>]/g, '')} (${String(order.payment_provider || '').replace(/[&<>]/g, '')})</p><p>Order ID: ${order.id}</p>`;
      try {
        const emailResponse = await requestHttps('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `efsi/${row.event_type}/${row.order_id}` },
          body: JSON.stringify({ from: emailFrom, to: [adminNotificationEmail], subject, html }), timeoutMs: 15000
        });
        if (!emailResponse.ok) throw new Error((await emailResponse.text()).slice(0, 300));
        await supabaseRequest(token, `rest/v1/notification_outbox?id=eq.${encodeURIComponent(row.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: { status: 'SENT', sent_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }, timeoutMs: 15000 });
      } catch (error) {
        const attempts = Number(row.attempts || 0) + 1;
        await supabaseRequest(token, `rest/v1/notification_outbox?id=eq.${encodeURIComponent(row.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: { status: attempts >= 8 ? 'FAILED' : 'RETRY', next_attempt_at: new Date(Date.now() + Math.min(6 * 60 * 60 * 1000, attempts * 10 * 60 * 1000)).toISOString(), last_error: String(error.message || 'Email failed').slice(0, 500), updated_at: new Date().toISOString() }, timeoutMs: 15000 });
      }
    }
  } finally { notificationWorkerRunning = false; }
}
function triggerCleanupWorker(delay = 2000) {
  if (!supabaseServiceRoleKey || cleanupWorkerTimer) return;
  cleanupWorkerTimer = setTimeout(async () => {
    cleanupWorkerTimer = null;
    await cleanupExpiredCheckoutIntents().catch(() => {});
    triggerCleanupWorker(60 * 60 * 1000);
  }, delay);
}

function triggerNotificationWorker(delay = 500) {
  if (!supabaseServiceRoleKey || notificationWorkerTimer) return;
  notificationWorkerTimer = setTimeout(async () => {
    notificationWorkerTimer = null;
    await flushNotificationOutbox().catch(() => {});
    const next = setTimeout(() => { notificationWorkerTimer = null; flushNotificationOutbox().catch(() => {}); }, 30000);
    notificationWorkerTimer = next;
  }, delay);
}

async function cleanupExpiredCheckoutIntents() {
  if (!supabaseServiceRoleKey) return;
  const token = serviceToken();
  const response = await supabaseRequest(token, 'rest/v1/checkout_intents?select=id,status,storage_path&status=in.(DRAFT,FILE_STAGED,PAYMENT_PENDING)&expires_at=lt.now()&limit=50', { timeoutMs: 15000 });
  if (!response.ok) return;
  const rows = await response.json();
  for (const row of rows) {
    await supabaseRequest(token, `rest/v1/checkout_intents?id=eq.${encodeURIComponent(row.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: { status: 'EXPIRED', payment_status: 'EXPIRED', updated_at: new Date().toISOString() }, timeoutMs: 15000 }).catch(() => {});
    if (row.storage_path) {
      const ref = encodeURIComponent(row.storage_path);
      const orderRef = await supabaseRequest(token, `rest/v1/order_files?select=id&object_path=eq.${ref}&limit=1`, { timeoutMs: 15000 }).catch(() => null);
      const intentRef = await supabaseRequest(token, `rest/v1/checkout_intents?select=id&storage_path=eq.${ref}&status=in.(FILE_STAGED,PAYMENT_PENDING,PAID)&limit=1`, { timeoutMs: 15000 }).catch(() => null);
      const hasOrderRef = Boolean(orderRef?.ok && (await orderRef.json()).length);
      const hasIntentRef = Boolean(intentRef?.ok && (await intentRef.json()).length);
      if (!hasOrderRef && !hasIntentRef) {
        await supabaseRequest(token, `storage/v1/object/private-ecu-files/${row.storage_path.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE', timeoutMs: 15000 }).catch(() => {});
      }
    }
  }
}

async function handleApi(request, response, url) {
  if (url.pathname === '/api/health') { jsonResponse(response, 200, { configured: hasSafeSupabaseConfig, paymentConfigured: paymentsConfigured(), paymentReadiness: paymentReadinessChecks() }); return true; }
  if (url.pathname === '/api/pricing') return handlePricing(request, response);
  if (url.pathname === '/api/checkout/intents') return handleCreateCheckoutIntent(request, response);
  const stageMatch = url.pathname.match(/^\/api\/checkout\/intents\/([0-9a-f-]{36})\/stage$/i);
  if (stageMatch) return handleStageCheckoutIntent(request, response, stageMatch[1]);
  if (url.pathname === '/api/payment/create-order' || url.pathname === '/api/payments/orders') return handleCreateRazorpayOrder(request, response);
  if (url.pathname === '/api/payment/verify' || url.pathname === '/api/payments/complete') return handleVerifyRazorpay(request, response);
  if (url.pathname === '/api/payment/reconcile') return handleReconcilePayment(request, response);
  if (url.pathname === '/api/payment/paypal/create-order') return handleCreatePayPalOrder(request, response);
  if (url.pathname === '/api/payment/paypal/capture') return handleCapturePayPal(request, response);
  if (url.pathname === '/api/admin/orders/status') return handleAdminStatus(request, response);
  if (url.pathname === '/api/admin/payment-status') return handleAdminPaymentStatus(request, response);

  const proxyRoute = url.pathname.match(/^\/api\/supabase\/(auth\/v1|rest\/v1|storage\/v1)(\/.*)?$/);
  if (!proxyRoute) return false;
  if (!hasSafeSupabaseConfig) { jsonResponse(response, 503, { error: 'Supabase is not configured on this server.' }); return true; }
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) { jsonResponse(response, 405, { error: 'Method Not Allowed' }); return true; }
  try {
    const body = ['GET', 'DELETE'].includes(request.method) ? undefined : await (async () => {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 8 * 1024 * 1024) throw Object.assign(new Error('Supabase proxy body exceeds the 8 MB metadata limit.'), { statusCode: 413 }); chunks.push(chunk); }
      return Buffer.concat(chunks);
    })();
    const route = `${proxyRoute[1]}${proxyRoute[2] || ''}${url.search}`;
    const incomingAuthorization = request.headers.authorization || '';
    const authorization = /^Bearer\s+[A-Za-z0-9._~-]+$/i.test(incomingAuthorization) ? incomingAuthorization : isLegacyAnonJwt(supabaseAnonKey) ? `Bearer ${supabaseAnonKey}` : null;
    const upstream = await requestHttps(`${supabaseUrl}/${route.replace(/^\//, '')}`, { method: request.method, headers: { apikey: supabaseAnonKey, ...(authorization ? { Authorization: authorization } : {}), ...(request.headers['content-type'] ? { 'Content-Type': request.headers['content-type'] } : {}), ...(request.headers.accept ? { Accept: request.headers.accept } : {}), ...(request.headers.prefer ? { Prefer: request.headers.prefer } : {}), ...(request.headers['x-upsert'] ? { 'x-upsert': request.headers['x-upsert'] } : {}) }, ...(body ? { body } : {}), timeoutMs: 60000 });
    const result = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(result);
  } catch (error) { jsonResponse(response, error.statusCode || 502, { error: error.message || 'Supabase request failed.' }); }
  return true;
}

function createHttpServer() {
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    const origin = request.headers.origin;
    if (origin) {
      response.setHeader('Vary', 'Origin');
      if (isAllowedCorsOrigin(origin)) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, apikey, x-client-info, x-upsert');
      }
    }
    if (request.method === 'OPTIONS' && requestUrl.pathname.startsWith('/api/')) { response.writeHead(origin && !isAllowedCorsOrigin(origin) ? 403 : 204).end(); return; }
    if (requestUrl.pathname.startsWith('/api/')) {
      handleApi(request, response, requestUrl).then(handled => { if (!handled && !response.writableEnded) jsonResponse(response, 404, { error: 'API endpoint not found.' }); }).catch(error => { if (!response.writableEnded) jsonResponse(response, error.statusCode || 500, { error: error.message || 'API request failed.' }); });
      return;
    }
    let pathname;
    try { pathname = decodeURIComponent(requestUrl.pathname); } catch { response.writeHead(400).end('Bad request'); return; }
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (!publicFiles.has(relative)) { response.writeHead(404).end('Not found'); return; }
    const target = path.join(root, relative);
    fs.readFile(target, (error, contents) => { if (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found'); return; } response.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' }); response.end(contents); });
  });
  return server;
}

if (require.main === module) {
  const server = createHttpServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`ECU File Service India is listening on port ${port}`);
    cleanupExpiredCheckoutIntents().catch(() => {});
    triggerCleanupWorker(2000);
    triggerNotificationWorker(1000);
  });
} else if (process.env.NODE_ENV === 'test') {
  module.exports = { createHttpServer, flushNotificationOutbox, cleanupExpiredCheckoutIntents, setTestUpstreamRequest(handler) { if (handler !== null && typeof handler !== 'function') throw new TypeError('Test upstream must be a function or null.'); testUpstreamRequest = handler; } };
}
