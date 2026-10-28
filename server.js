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
const maxAirbagPhotoBytes = 10 * 1024 * 1024;
const allowedAirbagPhotoMimes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const allowedCorsOrigins = new Set(['https://ecufileservice.in', 'https://www.ecufileservice.in']);
const premiumTwoWheelerBrands = new Set(['Aprilia','BMW Motorrad','Benelli','Ducati','Harley-Davidson','Kawasaki','KTM','Moto Guzzi','MV Agusta','Triumph']);
const electricOnlyModels = {
  'Tata Motors':['Nexon EV','Tiago EV','Tigor EV','Punch EV','Curvv EV','Harrier EV','Sierra EV'],
  'Tata Motors Commercial Vehicles':['Ace EV'],
  'Mahindra':['XUV400','BE 6','XEV 9e','eVerito','e2o'],
  'Hyundai':['Kona','Ioniq','Ioniq 5','Ioniq 6'],
  'MG Motor':['Comet','ZS','Windsor','Cyberster'],
  'BMW':['i3','i4','i5','i7','iX','iX1','iX2','iX3'],
  'Mercedes-Benz':['EQA','EQB','EQC','EQE','EQS'],
  'Audi':['e-tron','Q4 e-tron','Q8 e-tron'],
  'Porsche':['Taycan'],
  'Volvo':['EX30','EX40','EC40','EX90'],
  'Nissan':['Leaf','Ariya'],
  'Renault':['Zoe','Megane E-Tech'],
  'Citroën':['e-C3','ë-C3','eC3'],
  'Maruti Suzuki':['e Vitara'],
  'Kia':['EV6','EV9','Carens Clavis EV'],
  'Jaguar':['I-Pace'],
  'Mini':['Cooper SE','Electric'],
  'Lexus':['RZ'],
  'Volkswagen':['ID.3','ID.4','ID.5','ID.7','ID Buzz'],
  'Ford':['Mustang Mach-E','F-150 Lightning'],
  'Toyota':['bZ4X']
};
const twoWheelerOnlyBrands = new Set(['Aprilia','Bajaj','Benelli','BMW Motorrad','Ducati','Harley-Davidson','Kawasaki','KTM','Moto Guzzi','MV Agusta','Polaris','Triumph','TVS','Yamaha']);
function isUnsupportedElectricModel(brand, model) {
  const raw = String(model || '').trim();
  if (/\b(?:EV|BEV|electric)\b/i.test(raw)) return true;
  const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const candidate = normalize(raw);
  return (electricOnlyModels[String(brand || '').trim()] || []).some(name => {
    const blocked = normalize(name);
    return candidate === blocked || candidate.startsWith(blocked + ' ');
  });
}

const publicFiles = new Set(['index.html', 'admin.html', 'advertising-quote.html', 'styles.css', 'admin.css', 'app.js', 'auth.js', 'supabase.js', 'admin.js', 'robots.txt', 'sitemap.xml', 'ecu-file-services.html', 'airbag-crash-clear.html', 'guides.html', 'ecu-fault-code-diagnosis.html', 'ecu-file-identification-original-backup.html', 'guides.css', 'forum.html', 'forum.css', 'forum.js', 'store.html', 'membership.html', 'announcements.html', 'advertise.html', 'terms.html', 'privacy.html', 'contact.html', 'about.html', 'googlea2bbe9d2fd8bede2.html']);
const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
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
function paymentsConfigured() { return hasSafeSupabaseConfig && Boolean(supabaseServiceRoleKey) && paymentStateReady() && hasRazorpayConfig(); }
function paymentReadinessChecks() {
  return {
    supabaseUrl: /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl),
    supabasePublicKey: isPublicClientKey(supabaseAnonKey),
    razorpay: hasRazorpayConfig(),
    paypal: false,
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
  const apikey = (token && supabaseServiceRoleKey && token === supabaseServiceRoleKey) ? supabaseServiceRoleKey : supabaseAnonKey;
  return requestHttps(`${supabaseUrl}/${route}`, {
    method,
    headers: {
      apikey,
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
  const allowedCategories = ['ECU', 'AIRBAG']; // Dashboard remains readable for historical orders, but is not offered for new orders.
  const allowedEcuServices = ['DTC OFF', 'DPF OFF', 'AdBlue / SCR OFF', 'EGR OFF', 'O2 Remove', 'EVAP OFF', 'Decat', 'IMMO OFF', 'Speed Limit', 'Custom Request'];
  const clean = item => typeof item === 'string' ? item.trim() : '';
  const category = clean(value?.category);
  const services = Array.isArray(value?.selectedServices) ? [...new Set(value.selectedServices.filter(item => typeof item === 'string'))] : [];
  const yearText = clean(value?.vehicleYear);
  const year = yearText ? Number(yearText) : null;
  const email = clean(value?.contactEmail).slice(0, 254);
  if (!allowedCategories.includes(category)) throw new Error('Choose ECU or Airbag for a new order.');
  if (!clean(value?.vehicleBrand) || !clean(value?.vehicleType) || !clean(value?.vehicleModel) || !clean(value?.contactName) || !clean(value?.contactPhone) || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Complete the required vehicle, contact and valid email details.');
  }
  if (isUnsupportedElectricModel(clean(value?.vehicleBrand), clean(value?.vehicleModel))) throw new Error('Electric vehicles are not currently supported. Select a non-EV vehicle variant.');
  if (clean(value?.vehicleType) === 'Two-wheeler' && !premiumTwoWheelerBrands.has(clean(value?.vehicleBrand))) throw new Error('Two-wheeler requests are limited to selected imported/premium motorcycle brands.');
  if (clean(value?.vehicleType) !== 'Two-wheeler' && twoWheelerOnlyBrands.has(clean(value?.vehicleBrand))) throw new Error('Select the imported/premium two-wheeler vehicle type for this motorcycle brand.');
  if (year !== null && (!Number.isInteger(year) || year < 1950 || year > 2100)) throw new Error('Enter a valid vehicle year.');
  if (category === 'AIRBAG' && year === null) throw new Error('Year is required for Airbag Crash Clear requests.');
  if (category === 'AIRBAG' && (services.length !== 1 || services[0] !== 'Crash Clear')) throw new Error('Airbag requests support Crash Clear only.');
  if (category === 'ECU' && (services.length === 0 || services.some(service => !allowedEcuServices.includes(service)))) throw new Error('Select a valid ECU file service.');
  const isEcu = category === 'ECU';
  const result = {
    category,
    vehicleBrand: clean(value.vehicleBrand).slice(0, 100), vehicleType: clean(value.vehicleType).slice(0, 100), vehicleModel: clean(value.vehicleModel).slice(0, 160), vehicleYear: year,
    ecuManufacturer: isEcu ? (clean(value.ecuManufacturer).slice(0, 100) || null) : null,
    ecuModel: isEcu ? (clean(value.ecuModel).slice(0, 120) || null) : null,
    readingTool: isEcu ? (clean(value.readingTool).slice(0, 100) || null) : null,
    moduleDetails: category === 'AIRBAG' ? clean(value.moduleDetails).slice(0, 1200) : null,
    modulePhoto: null,
    partNumberPhoto: null,
    selectedServices: services,
    notes: clean(value.notes).replace(/\[EFSI_[A-Z0-9_]+\]/gi, '').slice(0, 3600) || null,
    contactName: clean(value.contactName).slice(0, 120), contactPhone: clean(value.contactPhone).slice(0, 40), contactEmail: email,
    originalName: clean(value.originalName).slice(0, 255), originalMime: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(clean(value.originalMime)) ? clean(value.originalMime).slice(0, 120) : 'application/octet-stream',
    originalSize: Number(value.originalSize), originalSha256: clean(value.originalSha256).toLowerCase()
  };
  if (!result.originalName || !Number.isSafeInteger(result.originalSize) || result.originalSize < 1 || result.originalSize > maxOriginalFileBytes || !/^[a-f0-9]{64}$/.test(result.originalSha256)) throw new Error('Select a valid original file up to 50 MB and try again.');
  if (category === 'AIRBAG') {
    if (!result.moduleDetails) throw new Error('Airbag module details are required.');
    const normalizePhoto = (photo, label) => {
      const name = clean(photo?.name).slice(0, 255);
      const mime = clean(photo?.mime).toLowerCase();
      const size = Number(photo?.size);
      const sha256 = clean(photo?.sha256).toLowerCase();
      const storagePath = clean(photo?.storagePath);
      if (!name || !allowedAirbagPhotoMimes.has(mime) || !Number.isSafeInteger(size) || size < 1 || size > maxAirbagPhotoBytes || !/^[a-f0-9]{64}$/.test(sha256) || storagePath !== `content/${sha256}`) {
        throw new Error(`Select a valid airbag ${label} (JPG, PNG or WEBP up to 10 MB).`);
      }
      return { name, mime, size, sha256, storagePath };
    };
    result.modulePhoto = normalizePhoto(value.modulePhoto, 'module photo');
    result.partNumberPhoto = normalizePhoto(value.partNumberPhoto, 'part-number photo');
  }
  return result;
}

function intentStoragePath(customerId, sha256) { void customerId; return `content/${sha256}`; }

async function fetchIntent(customer, intentId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(intentId || ''))) return null;
  const select = 'id,customer_id,status,payment_status,payment_provider,provider_order_id,provider_payment_id,request_sha256,request_json,original_name,original_mime,original_size,original_sha256,storage_path,amount_paise,currency,expires_at,file_staged_at,paid_at,order_id,updated_at';
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
  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    const errorCode = typeof errorData?.code === 'string' ? errorData.code.slice(0, 32) : 'UNKNOWN';
    console.error('[checkout] Supabase insert rejected', { status: response.status, code: errorCode });
    // Never return PostgREST details, schema names, constraint text or other internals to the customer.
    throw new Error('The secure checkout could not be saved. Please retry.');
  }
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
    console.info('[checkout] Request accepted for validation:', JSON.stringify({ category: order.category, originalSize: order.originalSize, serviceCount: order.selectedServices.length, hasEmail: Boolean(order.contactEmail), hasAirbagPhotos: Boolean(order.modulePhoto && order.partNumberPhoto) }));
    const intent = await createCheckoutIntent(customer, order);
    console.info('[checkout] Intent saved:', intent.id);
    jsonResponse(response, 200, { intentId: intent.id, status: intent.status, amount: intent.amount_paise, currency: intent.currency, storagePath: intent.storage_path, expiresAt: intent.expires_at, requestSha256: intent.request_sha256 });
  } catch (error) {
    console.error('[checkout] Intent creation failed:', String(error.message || 'unknown error').slice(0, 240));
    if (error.statusCode) {
      jsonResponse(response, error.statusCode, { error: error.message });
    } else {
      jsonResponse(response, 400, { error: `Checkout save failed: ${error.message}` });
    }
  }
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

function matchesAirbagPhotoSignature(bytes, mime) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes || []);
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if (mime === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

async function verifyStagedAirbagPhoto(intent, photo, label) {
  if (!photo || !allowedAirbagPhotoMimes.has(String(photo.mime || '').toLowerCase()) ||
      !Number.isSafeInteger(Number(photo.size)) || Number(photo.size) < 1 || Number(photo.size) > maxAirbagPhotoBytes ||
      !/^[a-f0-9]{64}$/.test(String(photo.sha256 || '')) || photo.storagePath !== `content/${photo.sha256}`) {
    return { ok:false, status:400, error:`The ${label} metadata is invalid. Upload the photo again.` };
  }
  const encoded = photo.storagePath.split('/').map(encodeURIComponent).join('/');
  const stored = await supabaseRequest(serviceToken(), `storage/v1/object/private-ecu-files/${encoded}`, { method:'GET', timeoutMs:30000 });
  if (!stored.ok) return { ok:false, status:409, error:`The ${label} is not present in private storage. Upload it again.` };
  const bytes = Buffer.from(await stored.arrayBuffer());
  if (bytes.length !== Number(photo.size) || bytes.length > maxAirbagPhotoBytes) return { ok:false, status:409, error:`The ${label} size does not match the saved checkout.` };
  if (!matchesAirbagPhotoSignature(bytes, String(photo.mime || '').toLowerCase())) return { ok:false, status:415, error:`The ${label} content is not a valid ${photo.mime} image. Upload a JPG, PNG or WEBP photo.` };
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  return safeEqualHex(digest, String(photo.sha256)) ? { ok:true } : { ok:false, status:409, error:`The ${label} hash does not match the saved checkout. Upload it again.` };
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
    if (intent.request_json?.category === 'AIRBAG') {
      for (const [photo, label] of [[intent.request_json.modulePhoto, 'Airbag module photo'], [intent.request_json.partNumberPhoto, 'Airbag part-number photo']]) {
        const photoCheck = await verifyStagedAirbagPhoto(intent, photo, label);
        if (!photoCheck.ok) { jsonResponse(response, photoCheck.status || 409, { error: photoCheck.error }); return true; }
      }
    }
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
    console.error('[payment-finalization] Supabase RPC failed', { intentId: intent.id, status: response.status, message: String(details?.message || 'No error message returned').slice(0, 300), code: details?.code || null });
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
  let recoveryIntentId = null;
  try {
    const customer = await requireCustomer(request);
    if (!customer) { jsonResponse(response, 401, { error: 'Sign in to recover your checkout.' }); return true; }
    const body = await readJson(request);
    recoveryIntentId = String(body?.intentId || '');
    const intent = await fetchIntent(customer, recoveryIntentId);
    if (!intent) { jsonResponse(response, 404, { error: 'Checkout request could not be recovered.' }); return true; }
    if (intent.status === 'PAID' && intent.payment_status === 'PAID') { jsonResponse(response, 200, { status: 'PAID', orderId: intent.order_id || intent.id }); return true; }
    if (intent.payment_provider === 'razorpay') {
      if (!body.razorpayPaymentId && !body.razorpay_payment_id) {
        const providerOrderId = String(intent.provider_order_id || '');
        if (!/^order_[A-Za-z0-9]+$/.test(providerOrderId)) { jsonResponse(response, 409, { error:'No provider payment session is available to recover yet.' }); return true; }
        const payments = await razorpayApi(`orders/${encodeURIComponent(providerOrderId)}/payments`);
        const candidates = Array.isArray(payments?.items) ? payments.items.filter(item => item?.status === 'captured' && Number(item.amount) === Number(intent.amount_paise) && item.currency === intent.currency && item.order_id === providerOrderId) : [];
        const payment = candidates[0];
        if (!payment?.id) {
          console.warn('[payment-recovery] No captured Razorpay payment matched the saved checkout', {
            intentId: intent.id,
            providerOrderId,
            paymentCount: Array.isArray(payments?.items) ? payments.items.length : 0,
            paymentStatuses: Array.isArray(payments?.items) ? payments.items.map(item => String(item?.status || 'unknown')).slice(0, 8) : []
          });
          jsonResponse(response, 409, { error:'No captured Razorpay payment was found for this saved checkout yet.' });
          return true;
        }
        body.razorpay_payment_id = payment.id;
        body.razorpay_order_id = providerOrderId;
      }
      return handleVerifyRazorpay(request, response, { reconcile: true, bodyData: body });
    }
    if (intent.payment_provider === 'paypal') { jsonResponse(response, 410, { error: 'PayPal payment recovery is disabled. Contact support before retrying this saved checkout.' }); return true; }
    jsonResponse(response, 409, { error: 'This checkout has not started payment yet.' });
  } catch (error) {
    console.error('[payment-recovery] Failed', { intentId: recoveryIntentId, statusCode: error.statusCode || null, code: error.code || null, message: String(error.message || 'Payment recovery failed.').slice(0, 300) });
    jsonResponse(response, error.statusCode || 400, { error: error.message || 'Payment recovery failed.' });
  }
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
      const customer = await supabaseRequest(admin.token, `rest/v1/orders?select=customer_id&id=eq.${encodeURIComponent(orderId)}&limit=1`, { timeoutMs: 15000 });
      if (customer.ok) {
        const orderData = await customer.json();
        if (orderData?.[0]?.customer_id) {
          await supabaseRequest(admin.token, 'rest/v1/notifications', { method: 'POST', body: { customer_id: orderData[0].customer_id, order_id: orderId, message: 'Your ECU file is ready for download.' }, timeoutMs: 15000 });
        }
      }
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

async function handleAdminCreateSecondStagePaymentLink(request, response) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error: 'Method Not Allowed' }); return true; }
  try {
    const admin = await requireAdmin(request);
    if (!admin) { jsonResponse(response, 403, { error: 'Administrator role is required.' }); return true; }
    const body = await readJson(request);
    const orderId = String(body?.orderId || '');
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) { jsonResponse(response, 400, { error: 'Invalid order reference.' }); return true; }

    let amountPaise;
    if (body?.amountRupees !== undefined) {
      const rupees = Number(body.amountRupees);
      if (!Number.isFinite(rupees) || rupees <= 0) {
        jsonResponse(response, 400, { error: 'Enter a valid positive amount in rupees.' });
        return true;
      }
      amountPaise = Math.round(rupees * 100);
    } else if (body?.amountPaise !== undefined || body?.amount !== undefined) {
      const val = Number(body.amountPaise ?? body.amount);
      if (!Number.isSafeInteger(val) || val <= 0) {
        jsonResponse(response, 400, { error: 'Enter a valid positive amount.' });
        return true;
      }
      amountPaise = body.amountPaise !== undefined ? Number(body.amountPaise) : (val <= 100000 && !body.amountPaise ? Math.round(val * 100) : val);
    } else {
      jsonResponse(response, 400, { error: 'Enter a valid amount in rupees.' });
      return true;
    }

    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
      jsonResponse(response, 400, { error: 'Enter a valid positive amount.' });
      return true;
    }

    const orderRes = await supabaseRequest(admin.token, `rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&select=id,status,payment_status,contact_name,contact_email,contact_phone,second_stage_status,second_stage_amount,second_stage_payment_link`, { timeoutMs: 15000 });
    if (!orderRes.ok) { jsonResponse(response, 404, { error: 'Order could not be loaded.' }); return true; }
    const rows = await orderRes.json();
    const order = rows?.[0];
    if (!order) { jsonResponse(response, 404, { error: 'Order not found.' }); return true; }
    if (order.status !== 'Possible') {
      jsonResponse(response, 409, { error: 'Second-stage payment can only be created when the order is in Possible status.' });
      return true;
    }
    if (String(order.payment_status || '').toUpperCase() !== 'PAID') {
      jsonResponse(response, 400, { error: 'Original payment must be completed before creating second-stage payment.' });
      return true;
    }

    // Call Razorpay Payment Links API using server-side credentials
    const plinkRes = await razorpayApi('payment_links', {
      method: 'POST',
      body: {
        amount: amountPaise,
        currency: 'INR',
        accept_partial: false,
        description: `Second-stage payment for order ${order.id}`,
        customer: {
          name: order.contact_name || 'Customer',
          email: order.contact_email || undefined,
          contact: order.contact_phone || undefined
        },
        notify: { sms: true, email: true },
        reminder_enable: true,
        notes: { order_id: order.id, type: 'second_stage' }
      }
    });

    const paymentLinkUrl = String(plinkRes?.short_url || plinkRes?.url || '').trim();
    try {
      const parsedUrl = new URL(paymentLinkUrl);
      if (!paymentLinkUrl || parsedUrl.protocol !== 'https:' || !/(?:^|\.)(?:rzp\.io|razorpay\.com)$/i.test(parsedUrl.hostname) || parsedUrl.username || parsedUrl.password) {
        throw new Error('Invalid payment link URL domain');
      }
    } catch {
      throw Object.assign(new Error('Razorpay returned an invalid payment link URL.'), { statusCode: 502 });
    }

    const patchBody = {
      second_stage_amount: amountPaise,
      second_stage_payment_link: paymentLinkUrl,
      second_stage_status: 'pending',
      second_stage_paid_at: null
    };

    const updated = await supabaseRequest(admin.token, `rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&select=*`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: patchBody,
      timeoutMs: 15000
    });
    if (!updated.ok) {
      const err = await updated.json().catch(() => null);
      jsonResponse(response, updated.status >= 500 ? 502 : 409, { error: err?.message || 'Second-stage payment link could not be saved.' });
      return true;
    }
    const updatedRows = await updated.json();
    jsonResponse(response, 200, { order: updatedRows?.[0] || null });
  } catch (error) {
    jsonResponse(response, error.statusCode || (error.code === 'RAZORPAY_UPSTREAM' ? 502 : 400), { error: error.message || 'Failed to create second-stage Razorpay payment link.' });
  }
  return true;
}

async function handleAdminMarkSecondStageUnpaid(request, response) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error: 'Method Not Allowed' }); return true; }
  try {
    const admin = await requireAdmin(request);
    if (!admin) { jsonResponse(response, 403, { error: 'Administrator role is required.' }); return true; }
    const body = await readJson(request);
    const orderId = String(body?.orderId || '');
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) { jsonResponse(response, 400, { error: 'Invalid order reference.' }); return true; }

    const orderRes = await supabaseRequest(admin.token, `rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&select=id,second_stage_status`, { timeoutMs: 15000 });
    if (!orderRes.ok) { jsonResponse(response, 404, { error: 'Order could not be loaded.' }); return true; }
    const rows = await orderRes.json();
    const order = rows?.[0];
    if (!order) { jsonResponse(response, 404, { error: 'Order not found.' }); return true; }

    const patchBody = {
      second_stage_status: 'pending',
      second_stage_paid_at: null
    };

    const updated = await supabaseRequest(admin.token, `rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: patchBody,
      timeoutMs: 15000
    });
    if (!updated.ok) {
      const err = await updated.json().catch(() => null);
      jsonResponse(response, updated.status >= 500 ? 502 : 409, { error: err?.message || 'Second-stage payment could not be marked unpaid.' });
      return true;
    }
    const updatedRows = await updated.json();
    jsonResponse(response, 200, { order: updatedRows?.[0] || null });
  } catch (error) {
    jsonResponse(response, error.statusCode || 400, { error: error.message || 'Failed to mark second-stage payment unpaid.' });
  }
  return true;
}

async function handleAdminMarkSecondStagePaid(request, response) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error: 'Method Not Allowed' }); return true; }
  try {
    const admin = await requireAdmin(request);
    if (!admin) { jsonResponse(response, 403, { error: 'Administrator role is required.' }); return true; }
    const body = await readJson(request);
    const orderId = String(body?.orderId || '');
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) { jsonResponse(response, 400, { error: 'Invalid order reference.' }); return true; }

    const orderRes = await supabaseRequest(admin.token, `rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&select=id,status,payment_status,second_stage_status,second_stage_payment_link,second_stage_amount`, { timeoutMs: 15000 });
    if (!orderRes.ok) { jsonResponse(response, 404, { error: 'Order could not be loaded.' }); return true; }
    const rows = await orderRes.json();
    const order = rows?.[0];
    if (!order) { jsonResponse(response, 404, { error: 'Order not found.' }); return true; }
    if (!order.second_stage_payment_link) {
      jsonResponse(response, 400, { error: 'Cannot mark second-stage paid without a payment link.' });
      return true;
    }

    const patchBody = {
      second_stage_status: 'paid',
      second_stage_paid_at: new Date().toISOString()
    };

    const updated = await supabaseRequest(admin.token, `rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: patchBody,
      timeoutMs: 15000
    });
    if (!updated.ok) {
      const err = await updated.json().catch(() => null);
      jsonResponse(response, updated.status >= 500 ? 502 : 409, { error: err?.message || 'Second-stage payment could not be marked paid.' });
      return true;
    }
    const updatedRows = await updated.json();
    jsonResponse(response, 200, { order: updatedRows?.[0] || null });
  } catch (error) {
    jsonResponse(response, error.statusCode || 400, { error: error.message || 'Failed to mark second-stage payment paid.' });
  }
  return true;
}

function sanitizeMessageText(text) {
  return String(text || '').trim().replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

async function handleGetMessages(request, response, url) {
  try {
    const customer = await requireCustomer(request);
    if (!customer) { jsonResponse(response, 401, { error: 'Sign in to view messages.' }); return true; }
    const orderId = String(url.searchParams.get('orderId') || '');
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) { jsonResponse(response, 400, { error: 'Invalid order reference.' }); return true; }

    // Verify order belongs to customer
    const orderRes = await supabaseRequest(customer.token, `rest/v1/orders?select=id,customer_id&id=eq.${encodeURIComponent(orderId)}&customer_id=eq.${encodeURIComponent(customer.id)}&limit=1`, { timeoutMs: 15000 });
    if (!orderRes.ok || (await orderRes.json()).length === 0) { jsonResponse(response, 404, { error: 'Order not found.' }); return true; }

    // Fetch messages
    const messagesRes = await supabaseRequest(customer.token, `rest/v1/order_messages?select=id,order_id,customer_id,sender_type,message,is_read,created_at&order_id=eq.${encodeURIComponent(orderId)}&customer_id=eq.${encodeURIComponent(customer.id)}&order=created_at.asc`, { timeoutMs: 15000 });
    if (!messagesRes.ok) { jsonResponse(response, 502, { error: 'Messages could not be loaded.' }); return true; }
    const messages = await messagesRes.json();

    // Mark unread admin messages as read
    const unreadAdminIds = messages.filter(m => m.sender_type === 'admin' && !m.is_read).map(m => m.id);
    if (unreadAdminIds.length > 0) {
      await supabaseRequest(customer.token, `rest/v1/order_messages?id=in.(${unreadAdminIds.join(',')})`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: { is_read: true },
        timeoutMs: 15000
      }).catch(() => {});
    }

    jsonResponse(response, 200, { messages });
  } catch (error) { jsonResponse(response, error.statusCode || 400, { error: error.message || 'Failed to load messages.' }); }
  return true;
}

async function handleSendMessage(request, response) {
  try {
    const customer = await requireCustomer(request);
    if (!customer) { jsonResponse(response, 401, { error: 'Sign in to send messages.' }); return true; }
    const body = await readJson(request, 8192);
    const orderId = String(body?.orderId || '');
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) { jsonResponse(response, 400, { error: 'Invalid order reference.' }); return true; }

    const rawMessage = String(body?.message || '');
    const cleanMessage = sanitizeMessageText(rawMessage);
    if (cleanMessage.length < 1 || cleanMessage.length > 2000) {
      jsonResponse(response, 400, { error: 'Message must be between 1 and 2000 characters.' });
      return true;
    }

    // Verify order belongs to customer
    const orderRes = await supabaseRequest(customer.token, `rest/v1/orders?select=id,customer_id&id=eq.${encodeURIComponent(orderId)}&customer_id=eq.${encodeURIComponent(customer.id)}&limit=1`, { timeoutMs: 15000 });
    if (!orderRes.ok || (await orderRes.json()).length === 0) { jsonResponse(response, 404, { error: 'Order not found.' }); return true; }

    const insertRes = await supabaseRequest(customer.token, 'rest/v1/order_messages', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        order_id: orderId,
        customer_id: customer.id,
        sender_type: 'customer',
        message: cleanMessage,
        is_read: false
      },
      timeoutMs: 15000
    });
    if (!insertRes.ok) {
      const err = await insertRes.json().catch(() => null);
      jsonResponse(response, insertRes.status >= 500 ? 502 : 409, { error: err?.message || 'Message could not be sent.' });
      return true;
    }
    const inserted = await insertRes.json();
    jsonResponse(response, 201, { message: inserted?.[0] || null });
  } catch (error) { jsonResponse(response, error.statusCode || 400, { error: error.message || 'Failed to send message.' }); }
  return true;
}

async function handleAdminGetMessages(request, response, url) {
  try {
    const admin = await requireAdmin(request);
    if (!admin) { jsonResponse(response, 403, { error: 'Administrator role is required.' }); return true; }
    const orderId = String(url.searchParams.get('orderId') || '');
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) { jsonResponse(response, 400, { error: 'Invalid order reference.' }); return true; }

    const orderRes = await supabaseRequest(admin.token, `rest/v1/orders?select=id,customer_id&id=eq.${encodeURIComponent(orderId)}&limit=1`, { timeoutMs: 15000 });
    const orderRows = orderRes.ok ? await orderRes.json().catch(() => []) : [];
    if (!Array.isArray(orderRows) || orderRows.length === 0) { jsonResponse(response, 404, { error: 'Order not found.' }); return true; }
    const orderData = orderRows[0];

    const messagesRes = await supabaseRequest(admin.token, `rest/v1/order_messages?select=id,order_id,customer_id,sender_type,message,is_read,created_at&order_id=eq.${encodeURIComponent(orderId)}&order=created_at.asc`, { timeoutMs: 15000 });
    if (!messagesRes.ok) { jsonResponse(response, 502, { error: 'Messages could not be loaded.' }); return true; }
    const messages = await messagesRes.json();

    // Mark unread customer messages as read
    const unreadCustomerIds = messages.filter(m => m.sender_type === 'customer' && !m.is_read).map(m => m.id);
    if (unreadCustomerIds.length > 0) {
      await supabaseRequest(admin.token, `rest/v1/order_messages?id=in.(${unreadCustomerIds.join(',')})`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: { is_read: true },
        timeoutMs: 15000
      }).catch(() => {});
    }

    jsonResponse(response, 200, { messages });
  } catch (error) { jsonResponse(response, error.statusCode || 400, { error: error.message || 'Failed to load messages.' }); }
  return true;
}

async function handleAdminReply(request, response) {
  try {
    const admin = await requireAdmin(request);
    if (!admin) { jsonResponse(response, 403, { error: 'Administrator role is required.' }); return true; }
    const body = await readJson(request, 8192);
    const orderId = String(body?.orderId || '');
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) { jsonResponse(response, 400, { error: 'Invalid order reference.' }); return true; }

    const rawMessage = String(body?.message || '');
    const cleanMessage = sanitizeMessageText(rawMessage);
    if (cleanMessage.length < 1 || cleanMessage.length > 2000) {
      jsonResponse(response, 400, { error: 'Message must be between 1 and 2000 characters.' });
      return true;
    }

    const orderRes = await supabaseRequest(admin.token, `rest/v1/orders?select=id,customer_id&id=eq.${encodeURIComponent(orderId)}&limit=1`, { timeoutMs: 15000 });
    const orderRows = orderRes.ok ? await orderRes.json().catch(() => []) : [];
    if (!Array.isArray(orderRows) || orderRows.length === 0) { jsonResponse(response, 404, { error: 'Order not found.' }); return true; }
    const orderData = orderRows[0];

    const insertRes = await supabaseRequest(admin.token, 'rest/v1/order_messages', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        order_id: orderId,
        customer_id: orderData.customer_id,
        sender_type: 'admin',
        message: cleanMessage,
        is_read: false
      },
      timeoutMs: 15000
    });
    if (!insertRes.ok) {
      const err = await insertRes.json().catch(() => null);
      jsonResponse(response, insertRes.status >= 500 ? 502 : 409, { error: err?.message || 'Reply could not be saved.' });
      return true;
    }
    const inserted = await insertRes.json();
    jsonResponse(response, 201, { message: inserted?.[0] || null });
  } catch (error) { jsonResponse(response, error.statusCode || 400, { error: error.message || 'Failed to send reply.' }); }
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
    const dueBefore = encodeURIComponent(new Date().toISOString());
    const response = await supabaseRequest(token, `rest/v1/notification_outbox?select=id,order_id,event_type,event_key,payload,attempts,next_attempt_at&status=in.(PENDING,RETRY)&next_attempt_at=lte.${dueBefore}&order=created_at.asc&limit=10`, { timeoutMs: 15000 });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error('[notification-worker] Outbox query failed', { status: response.status, detail: String(detail || '').slice(0, 300) });
      return;
    }
    const rows = await response.json();
    if (Array.isArray(rows) && rows.length) console.log('[notification-worker] Queue batch found', { count: rows.length });
    for (const row of rows) {
      const claim = await supabaseRequest(token, `rest/v1/notification_outbox?id=eq.${encodeURIComponent(row.id)}&status=in.(PENDING,RETRY)`, { method: 'PATCH', prefer: 'return=representation', body: { status: 'SENDING', attempts: Number(row.attempts || 0) + 1, updated_at: new Date().toISOString() }, timeoutMs: 15000 });
      if (!claim.ok) { const detail = await claim.text().catch(() => ''); console.error('[notification-worker] Could not claim outbox row', { id: row.id, eventType: row.event_type, status: claim.status, detail: String(detail || '').slice(0, 300) }); continue; }
      const claimedRows = await claim.json().catch(() => []);
      if (!Array.isArray(claimedRows) || !claimedRows.length) continue;
      const orderResponse = await supabaseRequest(token, `rest/v1/orders?select=id,category,vehicle_brand,vehicle_model,vehicle_year,contact_name,contact_phone,contact_email,payment_status,status,payment_provider,provider_order_id,provider_payment_id,created_at,ecu_manufacturer,ecu_model,reading_tool,selected_services,notes,module_details,verification_amount_paise&id=eq.${encodeURIComponent(row.order_id)}&limit=1`, { timeoutMs: 15000 });
      if (!orderResponse.ok) {
        await supabaseRequest(token, `rest/v1/notification_outbox?id=eq.${encodeURIComponent(row.id)}&status=eq.SENDING`, { method:'PATCH', prefer:'return=minimal', body:{ status:'RETRY', next_attempt_at:new Date(Date.now()+15*60*1000).toISOString(), last_error:'Order lookup failed before email delivery.', updated_at:new Date().toISOString() }, timeoutMs:15000 }).catch(()=>{});
        continue;
      }
      const order = (await orderResponse.json())?.[0];
      if (!order) {
        await supabaseRequest(token, `rest/v1/notification_outbox?id=eq.${encodeURIComponent(row.id)}&status=eq.SENDING`, { method:'PATCH', prefer:'return=minimal', body:{ status:'RETRY', next_attempt_at:new Date(Date.now()+15*60*1000).toISOString(), last_error:'Referenced order was not found.', updated_at:new Date().toISOString() }, timeoutMs:15000 }).catch(()=>{});
        continue;
      }
      const fileResponse = await supabaseRequest(token, `rest/v1/order_files?select=original_name&order_id=eq.${encodeURIComponent(order.id)}&kind=eq.original&limit=1`, { timeoutMs: 15000 });
      const fileInfo = fileResponse.ok ? (await fileResponse.json())?.[0] : null;
      const originalFileName = fileInfo?.original_name || 'N/A';
      const esc = (val) => String(val || '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
      const formatAmount = (paise) => paise ? `₹${(Number(paise)/100).toFixed(2)}` : 'N/A';
      const services = Array.isArray(order.selected_services) ? order.selected_services.join(', ') : 'None';
      const vehicle = [order.vehicle_year, order.vehicle_brand, order.vehicle_model].filter(Boolean).join(' ');
      const ecuDetails = order.category === 'ECU' ? `<p><strong>ECU:</strong> ${esc(order.ecu_manufacturer || 'N/A')} ${esc(order.ecu_model || 'N/A')}</p><p><strong>Reading tool:</strong> ${esc(order.reading_tool || 'N/A')}</p>` : '';
      const rowPayload = row.payload && typeof row.payload === 'object' ? row.payload : {};
      const eventType = ['new_order','paid_order','status_change'].includes(row.event_type) ? row.event_type : 'new_order';
      const previousStatus = rowPayload.previous_status || '—';
      const currentStatus = rowPayload.status || order.status || 'New';
      const eventTitle = eventType === 'paid_order' ? 'Payment Confirmed' : eventType === 'status_change' ? `Order Status Updated: ${currentStatus}` : 'New Order Received';
      const adminSubject = eventType === 'paid_order' ? 'Payment Confirmed – ECU File Service India' : eventType === 'status_change' ? `Order Status Updated: ${currentStatus} – ECU File Service India` : 'New Order Received – ECU File Service India';
      const customerSubject = eventType === 'paid_order' ? 'Payment received – ECU File Service India' : eventType === 'status_change' ? `Your order status is now ${currentStatus} – ECU File Service India` : 'We received your order – ECU File Service India';
      const eventIntro = eventType === 'paid_order'
        ? 'Payment has been verified by the server and the order is confirmed.'
        : eventType === 'status_change'
          ? `The order status changed from ${esc(previousStatus)} to ${esc(currentStatus)}.`
          : 'A new customer order was successfully created after verified checkout.';
      const detailHtml = `
        <p><strong>Order ID:</strong> ${esc(order.id)}</p>
        <p><strong>Current status:</strong> ${esc(eventType === 'status_change' ? currentStatus : (order.status || currentStatus))}</p>
        <p><strong>Payment:</strong> ${esc(order.payment_status)} (${esc(order.payment_provider || 'N/A')})</p>
        <p><strong>Verification fee:</strong> ${formatAmount(order.verification_amount_paise)}</p>
        <hr/>
        <p><strong>Customer:</strong> ${esc(order.contact_name)}</p>
        <p><strong>Email:</strong> ${esc(order.contact_email || 'N/A')}</p>
        <p><strong>Phone:</strong> ${esc(order.contact_phone)}</p>
        <hr/>
        <p><strong>Vehicle:</strong> ${esc(vehicle)}</p>
        <p><strong>Category:</strong> ${esc(order.category)}</p>
        ${ecuDetails}
        ${order.category === 'AIRBAG' ? `<p><strong>Airbag module details:</strong> ${esc(order.module_details || 'N/A')}</p>` : ''}
        <p><strong>Service:</strong> ${esc(services)}</p>
        <p><strong>Original file:</strong> ${esc(originalFileName)}</p>
        <p><strong>Created:</strong> ${esc(new Date(order.created_at).toLocaleString())}</p>
        <p><strong>Notes:</strong> ${esc(order.notes || 'None')}</p>
      `.trim();
      const appUrl = (process.env.PUBLIC_APP_URL || 'https://ecufileservice.in').replace(/\/$/, '');
      const adminHtml = `<div style="font-family:sans-serif;line-height:1.5"><h2>${esc(eventTitle)} – ECU File Service India</h2><p>${eventIntro}</p>${detailHtml}<p><a href="${esc(appUrl)}/admin.html">Open Admin Orders</a></p></div>`;
      const customerHtml = `<div style="font-family:sans-serif;line-height:1.5"><h2>${esc(eventTitle)} – ECU File Service India</h2><p>Hi ${esc(order.contact_name || 'Customer')},</p><p>${eventType === 'status_change' ? `Your order status has changed from ${esc(previousStatus)} to <strong>${esc(currentStatus)}</strong>.` : eventType === 'paid_order' ? 'We have verified your payment successfully. Your order is confirmed.' : 'We have received your order successfully. Our team will review it and update you as it progresses.'}</p>${detailHtml}<p>Sign in to your account at <a href="${esc(appUrl)}/">${esc(appUrl)}</a> to review your order.</p><p>Regards,<br>ECU File Service India · ECU File Service India</p></div>`;
      const eventKey = String(row.event_key || `${row.order_id}:${eventType}`).replace(/[^a-zA-Z0-9._:/-]/g, '_').slice(0, 180);
      try {
        const sendEmail = async (recipient, subject, html, recipientLabel) => {
          const emailResponse = await requestHttps('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `efsi/${eventKey}/${recipientLabel}` },
            body: JSON.stringify({ from: emailFrom, to: [recipient], subject, html }), timeoutMs: 15000
          });
          if (!emailResponse.ok) throw new Error((await emailResponse.text()).slice(0, 300));
        };
        // Recipient-scoped idempotency keys allow a retry to safely resume if one send succeeded.
        await sendEmail(adminNotificationEmail, adminSubject, adminHtml, 'admin');
        if (order.contact_email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(order.contact_email))) {
          await sendEmail(order.contact_email, customerSubject, customerHtml, 'customer');
        }
        await supabaseRequest(token, `rest/v1/notification_outbox?id=eq.${encodeURIComponent(row.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: { status: 'SENT', sent_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }, timeoutMs: 15000 });
      } catch (error) {
        console.error('[notification-worker] Email delivery failed', { id: row.id, eventType, message: String(error.message || 'Email failed').slice(0, 300) });
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
  cleanupWorkerTimer.unref();
}

function triggerNotificationWorker(delay = 500) {
  if (notificationWorkerTimer) return;
  if (!supabaseServiceRoleKey || !hasResendConfig()) {
    console.error('[notification-worker] Not scheduled: configuration incomplete', { serviceRoleAvailable: Boolean(supabaseServiceRoleKey), resendKeyFormatValid: /^re_[A-Za-z0-9_-]{10,}$/.test(resendApiKey), senderConfigured: emailFrom.includes('@'), adminRecipientConfigured: adminNotificationEmail.includes('@') });
    return;
  }
  const run = async () => {
    await flushNotificationOutbox().catch((error) => console.error('[notification-worker] Run failed', { message: String(error.message || error).slice(0, 300) }));
    notificationWorkerTimer = setTimeout(run, 30000);
    notificationWorkerTimer.unref();
  };
  notificationWorkerTimer = setTimeout(async () => {
    await run();
  }, delay);
  notificationWorkerTimer.unref();
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


const advertisingSubmitAttempts = new Map();
function cleanSiteText(value, max = 4000) { return String(value ?? '').trim().slice(0, max); }
function validHttpsUrl(value) {
  if (!value) return true;
  try { const parsed = new URL(value); return parsed.protocol === 'https:' && !parsed.username && !parsed.password; } catch { return false; }
}
function announcementPayload(body, adminId, partial = false) {
  const kinds = ['announcement','offer','ad'];
  const placements = ['banner','homepage','sidebar'];
  const out = {};
  if (!partial || body.kind !== undefined) { if (!kinds.includes(body.kind)) throw Object.assign(new Error('Choose announcement, offer or ad.'), { statusCode: 400 }); out.kind = body.kind; }
  if (!partial || body.title !== undefined) { out.title = cleanSiteText(body.title, 180); if (!out.title) throw Object.assign(new Error('A title is required.'), { statusCode: 400 }); }
  if (!partial || body.body !== undefined) { out.body = cleanSiteText(body.body, 4000); }
  if (!partial || body.advertising_quote_id !== undefined) {
    const quoteId = cleanSiteText(body.advertising_quote_id, 36);
    if (quoteId && !/^[0-9a-f-]{36}$/i.test(quoteId)) throw Object.assign(new Error('Select a valid paid advertising quote.'), { statusCode:400 });
    out.advertising_quote_id = quoteId || null;
  }
  for (const field of ['image_url','cta_url']) {
    if (!partial || body[field] !== undefined) {
      const value = cleanSiteText(body[field], 1000);
      if (!validHttpsUrl(value)) throw Object.assign(new Error(field === 'image_url' ? 'Image URL must use HTTPS.' : 'Link URL must use HTTPS.'), { statusCode: 400 });
      out[field] = value || null;
    }
  }
  if (!partial || body.cta_label !== undefined) out.cta_label = cleanSiteText(body.cta_label, 80) || null;
  if (!partial || body.placement !== undefined) { const value = body.placement || 'banner'; if (!placements.includes(value)) throw Object.assign(new Error('Choose a valid placement.'), { statusCode: 400 }); out.placement = value; }
  for (const field of ['starts_at','ends_at']) {
    if (!partial || body[field] !== undefined) {
      const value = body[field] ? new Date(body[field]) : null;
      if (body[field] && Number.isNaN(value.getTime())) throw Object.assign(new Error('Enter valid start and end dates.'), { statusCode: 400 });
      out[field] = value ? value.toISOString() : (field === 'starts_at' ? new Date().toISOString() : null);
    }
  }
  if (out.starts_at && out.ends_at && new Date(out.ends_at) <= new Date(out.starts_at)) throw Object.assign(new Error('End date must be after start date.'), { statusCode: 400 });
  if (!partial || body.is_published !== undefined) out.is_published = body.is_published === true;

  if (adminId && !partial) out.created_by = adminId;
  out.updated_at = new Date().toISOString();
  return out;
}
async function handlePublicSiteContent(request, response) {
  if (request.method !== 'GET') { jsonResponse(response, 405, { error: 'Method Not Allowed' }); return true; }
  if (!supabaseServiceRoleKey) { jsonResponse(response, 503, { error: 'Site content is temporarily unavailable.' }); return true; }
  const result = await supabaseRequest(serviceToken(), 'rest/v1/site_announcements?select=id,kind,title,body,image_url,cta_label,cta_url,placement,starts_at,ends_at&is_published=eq.true&order=created_at.desc&limit=100', { timeoutMs: 12000 });
  if (!result.ok) {
    const detail = await result.text().catch(() => '');
    console.warn('[site-content] Public query failed', { status: result.status, detail: String(detail || '').slice(0, 300) });
    jsonResponse(response, 502, { error: 'Site content could not be loaded.' }); return true;
  }
  const now = Date.now();
  const rows = await result.json();
  const items = (Array.isArray(rows) ? rows : []).filter(item => {
    const starts = item.starts_at ? new Date(item.starts_at).getTime() : 0;
    const ends = item.ends_at ? new Date(item.ends_at).getTime() : null;
    return starts <= now && (ends === null || ends > now);
  }).slice(0, 30);
  jsonResponse(response, 200, { items });
  return true;
}
async function handlePublicSiteSettings(request, response) {
  if (request.method !== 'GET') { jsonResponse(response, 405, { error:'Method Not Allowed' }); return true; }
  if (!supabaseServiceRoleKey) { jsonResponse(response, 200, { settings:{ contact_phone:'', telegram_url:'', contact_email:'' } }); return true; }
  const result = await supabaseRequest(serviceToken(), 'rest/v1/site_public_settings?select=contact_phone,telegram_url,contact_email&id=eq.true&limit=1', { timeoutMs:12000 });
  if (!result.ok) { jsonResponse(response, 200, { settings:{ contact_phone:'', telegram_url:'', contact_email:'' } }); return true; }
  const row = (await result.json())?.[0] || {};
  jsonResponse(response, 200, { settings:{ contact_phone:row.contact_phone||'', telegram_url:row.telegram_url||'', contact_email:row.contact_email||'' } });
  return true;
}
async function handleAdminSiteSettings(request, response) {
  const admin = await requireAdmin(request);
  if (!admin) { jsonResponse(response, 403, { error:'Administrator role is required.' }); return true; }
  if (!supabaseServiceRoleKey) { jsonResponse(response, 503, { error:'Public contact settings are unavailable.' }); return true; }
  const token = serviceToken();
  if (request.method === 'GET') {
    const result = await supabaseRequest(token, 'rest/v1/site_public_settings?select=contact_phone,telegram_url,contact_email&id=eq.true&limit=1', { timeoutMs:12000 });
    if (!result.ok) { jsonResponse(response, 502, { error:'Contact settings could not be loaded.' }); return true; }
    const row=(await result.json())?.[0]||{};
    jsonResponse(response,200,{settings:{contact_phone:row.contact_phone||'',telegram_url:row.telegram_url||'',contact_email:row.contact_email||''}});return true;
  }
  if (request.method === 'PATCH') {
    try {
      const body=await readJson(request,4096);
      const phone=cleanSiteText(body.contact_phone,40);
      const telegramRaw=cleanSiteText(body.telegram_url,500);
      let telegram='';
      if (telegramRaw) {
        let parsed;
        try { parsed = new URL(/^https:\/\//i.test(telegramRaw) ? telegramRaw : 'https://' + telegramRaw); }
        catch { throw Object.assign(new Error('Enter a valid Telegram username or https://t.me link.'),{statusCode:400}); }
        const host=parsed.hostname.toLowerCase().replace(/^www\./,'');
        if (parsed.protocol!=='https:' || !['t.me','telegram.me'].includes(host) || parsed.username || parsed.password) {
          throw Object.assign(new Error('Use a Telegram link such as https://t.me/your_channel or https://t.me/+invitecode.'),{statusCode:400});
        }
        parsed.hostname='t.me';
        parsed.hash='';
        telegram=parsed.href.replace(/\/$/,'');
      }
      const email=cleanSiteText(body.contact_email,254).toLowerCase();
      if (telegram) { let parsed; try { parsed=new URL(telegram); } catch { throw Object.assign(new Error('Enter a valid Telegram URL.'),{statusCode:400}); } if (parsed.protocol!=='https:' || !['t.me','telegram.me','www.t.me','www.telegram.me'].includes(parsed.hostname.toLowerCase()) || parsed.username || parsed.password) throw Object.assign(new Error('Telegram link must use an HTTPS t.me or telegram.me address.'),{statusCode:400}); }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('Enter a valid contact email address.'),{statusCode:400});
      if (phone && phone.replace(/[^\d]/g,'').length<7) throw Object.assign(new Error('Enter a valid phone number, or leave it empty.'),{statusCode:400});
      if (!phone && !telegram && !email) throw Object.assign(new Error('Enter at least one public contact method.'),{statusCode:400});
      const payload={id:true,contact_phone:phone,telegram_url:telegram,contact_email:email,updated_at:new Date().toISOString(),updated_by:admin.id};
      const result=await supabaseRequest(token,'rest/v1/site_public_settings?on_conflict=id',{method:'POST',prefer:'resolution=merge-duplicates,return=representation',body:payload,timeoutMs:12000});
      if(!result.ok){jsonResponse(response,502,{error:'Contact settings could not be saved.'});return true;}
      jsonResponse(response,200,{settings:{contact_phone:phone,telegram_url:telegram,contact_email:email}});return true;
    } catch(error) { jsonResponse(response,error.statusCode||400,{error:error.message||'Invalid contact settings.'});return true; }
  }
  jsonResponse(response,405,{error:'Method Not Allowed'});return true;
}

async function resolveSoftwareRequestProduct(admin, row, requestId) {
  if (!row || row.request_type !== 'software_requirement') return null;
  let productId = String(row.software_product_id || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(productId)) {
    const match = String(row.body || '').match(/(?:^|\\n)Product ID:\\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\\b/i);
    productId = match ? match[1] : '';
  }
  if (!productId) return null;
  const productResult = await supabaseRequest(admin.token, 'rest/v1/software_products?id=eq.' + encodeURIComponent(productId) + '&select=id&limit=1', { timeoutMs: 12000 });
  if (!productResult.ok || !(await productResult.json())?.length) return null;
  if (String(row.software_product_id || '') !== productId) {
    const repaired = await supabaseRequest(admin.token, 'rest/v1/forum_customer_requests?id=eq.' + encodeURIComponent(requestId), {
      method: 'PATCH', prefer: 'return=minimal',
      body: { software_product_id: productId, software_status: ['not_applicable',''].includes(String(row.software_status || '')) ? 'requested' : row.software_status, updated_at: new Date().toISOString() },
      timeoutMs: 12000
    });
    if (!repaired.ok) return null;
  }
  return productId;
}

async function handleAdminCreateSoftwarePaymentLink(request, response) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error: 'Method Not Allowed' }); return true; }
  try {
    const admin = await requireAdmin(request);
    if (!admin) { jsonResponse(response, 403, { error: 'Administrator role is required.' }); return true; }
    if (!hasRazorpayConfig()) { jsonResponse(response, 503, { error: 'Razorpay is not configured. Configure live/test keys on the server first.' }); return true; }
    const body = await readJson(request);
    const requestId = String(body?.requestId || '');
    const rupees = Number(body?.amountRupees);
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) { jsonResponse(response, 400, { error: 'Invalid software request reference.' }); return true; }
    if (!Number.isFinite(rupees) || rupees <= 0 || !Number.isSafeInteger(Math.round(rupees * 100))) { jsonResponse(response, 400, { error: 'Enter a valid price greater than zero.' }); return true; }
    const amountPaise = Math.round(rupees * 100);
    const loaded = await supabaseRequest(admin.token, 'rest/v1/forum_customer_requests?id=eq.'+encodeURIComponent(requestId)+'&select=id,title,body,request_type,software_product_id,software_status,quoted_price_paise,software_payment_link,user_id,admin_reply&limit=1', { timeoutMs: 12000 });
    if (!loaded.ok) { jsonResponse(response, 502, { error: 'Software request could not be loaded.' }); return true; }
    const rows = await loaded.json(); const row = rows?.[0];
    if (!row || row.request_type !== 'software_requirement') { jsonResponse(response, 404, { error: 'Software customer request was not found. Refresh the customer request list and retry.' }); return true; }
    if (['paid','delivered','cancelled'].includes(String(row.software_status || '').toLowerCase())) { jsonResponse(response, 409, { error: 'A payment link cannot be generated for this request status.' }); return true; }
    const link = await razorpayApi('payment_links', { method:'POST', body:{
      amount: amountPaise, currency:'INR', accept_partial:false,
      description: String(row.title || 'Software purchase').slice(0,240),
      reference_id: requestId.replace(/-/g,'').slice(0,40),
      reminder_enable:true, notes:{ request_id:requestId, software_product_id:String(row.software_product_id || ''), type:'software_purchase' }
    }});
    const paymentUrl=String(link?.short_url || link?.url || '').trim();
    let parsed; try { parsed=new URL(paymentUrl); } catch { parsed=null; }
    if (!parsed || parsed.protocol!=='https:' || !/(?:^|\.)(?:rzp\.io|razorpay\.com)$/i.test(parsed.hostname) || parsed.username || parsed.password) {
      jsonResponse(response, 502, { error:'Razorpay returned an invalid payment link.' }); return true;
    }
    const paymentLinkId=String(link?.id||''); if(!/^plink_[A-Za-z0-9]+$/.test(paymentLinkId)){jsonResponse(response,502,{error:'Razorpay did not return a valid payment-link reference.'});return true;} const paymentMessage='Your software quote is ready. Use the secure Razorpay Pay now link in My Account → Your orders to complete payment: '+paymentUrl; const priorReply=String(row.admin_reply||'').trim(); const patch={ quoted_price_paise:amountPaise, software_payment_link:paymentUrl, software_payment_link_id:paymentLinkId, software_status:'awaiting_payment', status:'waiting_for_customer', admin_reply:paymentMessage, updated_at:new Date().toISOString() };
    const saved=await supabaseRequest(admin.token,'rest/v1/forum_customer_requests?id=eq.'+encodeURIComponent(requestId)+'&select=id,quoted_price_paise,software_payment_link,software_status,status',{method:'PATCH',prefer:'return=representation',body:patch,timeoutMs:12000});
    if(!saved.ok){jsonResponse(response,502,{error:'Payment link was created, but could not be saved to the request. Check Razorpay before retrying.'});return true;}
    jsonResponse(response,200,{item:(await saved.json())?.[0]||null,paymentLink:paymentUrl});
  } catch(error) { jsonResponse(response,error.statusCode || (error.code==='RAZORPAY_UPSTREAM'?502:400),{error:error.message||'Could not create the software payment link.'}); }
  return true;
}


async function handleAdminVerifySoftwarePayment(request, response) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error: 'Method Not Allowed' }); return true; }
  try {
    const admin = await requireAdmin(request);
    if (!admin) { jsonResponse(response, 403, { error: 'Administrator role is required.' }); return true; }
    if (!hasRazorpayConfig()) { jsonResponse(response, 503, { error: 'Razorpay is not configured.' }); return true; }
    const body = await readJson(request);
    const requestId = String(body?.requestId || '');
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) { jsonResponse(response, 400, { error: 'Invalid software request reference.' }); return true; }
    const loaded = await supabaseRequest(admin.token, 'rest/v1/forum_customer_requests?id=eq.'+encodeURIComponent(requestId)+'&select=id,body,request_type,software_product_id,software_status,quoted_price_paise,software_payment_link_id&limit=1', { timeoutMs: 12000 });
    if (!loaded.ok) { jsonResponse(response, 502, { error: 'Software request could not be loaded.' }); return true; }
    const row = (await loaded.json())?.[0];
    if (!row || row.request_type !== 'software_requirement') { jsonResponse(response, 404, { error: 'Software customer request was not found.' }); return true; }
    if (!row.software_payment_link_id || !/^plink_[A-Za-z0-9]+$/.test(String(row.software_payment_link_id))) { jsonResponse(response, 409, { error: 'Create a new Razorpay payment link before verifying payment.' }); return true; }
    if (!(Number(row.quoted_price_paise) > 0)) { jsonResponse(response, 409, { error: 'A valid quoted amount is required.' }); return true; }
    if (String(row.software_status||'').toLowerCase()==='delivered') { jsonResponse(response, 200, { verified:true, alreadyVerified:true, status:row.software_status }); return true; }
    const link = await razorpayApi('payment_links/'+encodeURIComponent(row.software_payment_link_id));
    const expected = Number(row.quoted_price_paise);
    if (String(link?.status||'').toLowerCase() !== 'paid' || Number(link?.amount) !== expected || Number(link?.amount_paid) !== expected) {
      jsonResponse(response, 409, { error: 'Razorpay does not confirm full payment for the quoted amount yet.', paymentStatus:String(link?.status||'unknown') }); return true;
    }
    const patch = { software_status:'paid', status:'in_review', admin_reply:'Payment received and verified by Razorpay. We will prepare your software and add the secure download here.', updated_at:new Date().toISOString() };
    const saved = await supabaseRequest(admin.token, 'rest/v1/forum_customer_requests?id=eq.'+encodeURIComponent(requestId)+'&select=id,software_status,status,quoted_price_paise', { method:'PATCH', prefer:'return=representation', body:patch, timeoutMs:12000 });
    if (!saved.ok) { jsonResponse(response, 502, { error: 'Payment was verified by Razorpay, but the request status could not be saved. Refresh and retry verification.' }); return true; }
    jsonResponse(response, 200, { verified:true, item:(await saved.json())?.[0]||null });
  } catch(error) { jsonResponse(response,error.statusCode||(error.code==='RAZORPAY_UPSTREAM'?502:400),{error:error.message||'Could not verify software payment.'}); }
  return true;
}

async function handleCustomerSoftwareDownload(request, response) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error: 'Method Not Allowed' }); return true; }
  try {
    const customer = await requireCustomer(request);
    if (!customer) { jsonResponse(response, 401, { error: 'Please sign in to download your software.' }); return true; }
    const body = await readJson(request);
    const requestId = String(body?.requestId || '');
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) { jsonResponse(response, 400, { error: 'Invalid software request reference.' }); return true; }
    if (!supabaseServiceRoleKey) { jsonResponse(response, 503, { error: 'Secure software delivery is temporarily unavailable.' }); return true; }
    const loaded = await supabaseRequest(serviceToken(), 'rest/v1/forum_customer_requests?id=eq.'+encodeURIComponent(requestId)+'&select=id,user_id,request_type,software_product_id,software_status,software_delivery_path,software_delivery_name&limit=1', { timeoutMs: 12000 });
    if (!loaded.ok) { jsonResponse(response, 502, { error: 'Could not verify software delivery. Please retry.' }); return true; }
    const row = (await loaded.json())?.[0];
    if (!row || row.user_id !== customer.id || row.request_type !== 'software_requirement' || !row.software_product_id) { jsonResponse(response, 404, { error: 'Software delivery not found.' }); return true; }
    if (String(row.software_status || '').toLowerCase() !== 'delivered' || !row.software_delivery_path) { jsonResponse(response, 403, { error: 'Payment verification and software delivery must be completed before download.' }); return true; }
    const objectPath = String(row.software_delivery_path);
    if (!objectPath.startsWith('software-deliveries/'+requestId+'/') || objectPath.includes('..') || objectPath.startsWith('/') || objectPath.includes(String.fromCharCode(92))) { jsonResponse(response, 409, { error: 'The saved software delivery path is invalid.' }); return true; }
    const signed = await supabaseRequest(serviceToken(), 'storage/v1/object/sign/private-ecu-files/'+objectPath.split('/').map(encodeURIComponent).join('/'), { method:'POST', body:{ expiresIn:60 }, timeoutMs:12000 });
    if (!signed.ok) { jsonResponse(response, 502, { error: 'The private software file could not be prepared for download.' }); return true; }
    const data = await signed.json();
    const signedPath = String(data?.signedURL || data?.signedUrl || '');
    if (!signedPath.startsWith('/object/sign/') && !signedPath.startsWith('http')) { jsonResponse(response, 502, { error: 'Storage returned an invalid secure download link.' }); return true; }
    const downloadUrl = signedPath.startsWith('http') ? signedPath : supabaseUrl+'/storage/v1'+(signedPath.startsWith('/')?signedPath:'/'+signedPath);
    let parsed; try { parsed = new URL(downloadUrl); } catch { parsed = null; }
    if (!parsed || parsed.origin !== new URL(supabaseUrl).origin || !parsed.pathname.includes('/object/sign/')) { jsonResponse(response, 502, { error: 'Storage returned an unsafe download link.' }); return true; }
    jsonResponse(response, 200, { downloadUrl, fileName: String(row.software_delivery_name || 'software-file.bin').slice(0,255) });
  } catch (error) { jsonResponse(response, error.statusCode || 400, { error: error.message || 'Secure software download failed.' }); }
  return true;
}

async function handleAdminSiteContent(request, response) {
  const admin = await requireAdmin(request);
  if (!admin) { jsonResponse(response, 403, { error: 'Administrator role is required.' }); return true; }
  if (!supabaseServiceRoleKey) { jsonResponse(response, 503, { error: 'Site content management is unavailable.' }); return true; }
  const token = serviceToken();
  if (request.method === 'GET') {
    const result = await supabaseRequest(token, 'rest/v1/site_announcements?select=*&order=created_at.desc&limit=100', { timeoutMs: 12000 });
    if (!result.ok) { jsonResponse(response, 502, { error: 'Site content could not be loaded.' }); return true; }
    jsonResponse(response, 200, { items: await result.json() }); return true;
  }
  if (request.method === 'POST') {
    try {
      const body = await readJson(request, 8192);
      const payload = announcementPayload(body, admin.id);
      const result = await supabaseRequest(token, 'rest/v1/site_announcements?select=*', { method:'POST', prefer:'return=representation', body:payload, timeoutMs:12000 });
      if (!result.ok) { jsonResponse(response, 502, { error:'Announcement could not be saved.' }); return true; }
      jsonResponse(response, 201, { item:(await result.json())?.[0] || null }); return true;
    } catch (error) { jsonResponse(response, error.statusCode || 400, { error:error.message || 'Invalid content.' }); return true; }
  }
  if (request.method === 'DELETE') {
    try {
      const body = await readJson(request, 2048);
      const id = String(body.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) { jsonResponse(response, 400, { error:'Invalid content reference.' }); return true; }
      const result = await supabaseRequest(token, 'rest/v1/site_announcements?id=eq.'+encodeURIComponent(id)+'&select=id', { method:'DELETE', prefer:'return=representation', timeoutMs:12000 });
      if (!result.ok) { jsonResponse(response, 502, { error:'Announcement could not be deleted.' }); return true; }
      const rows = await result.json();
      if (!rows || !rows.length) { jsonResponse(response, 404, { error:'Announcement not found.' }); return true; }
      jsonResponse(response, 200, { deleted:true }); return true;
    } catch (error) { jsonResponse(response, error.statusCode || 400, { error:error.message || 'Announcement could not be deleted.' }); return true; }
  }
  if (request.method === 'PATCH') {
    try {
      const body = await readJson(request, 8192);
      const id = String(body.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) { jsonResponse(response, 400, { error:'Invalid content reference.' }); return true; }
      const payload = announcementPayload(body, admin.id, true);
      const result = await supabaseRequest(token, 'rest/v1/site_announcements?id=eq.'+encodeURIComponent(id)+'&select=*', { method:'PATCH', prefer:'return=representation', body:payload, timeoutMs:12000 });
      if (!result.ok) { jsonResponse(response, 502, { error:'Announcement could not be updated.' }); return true; }
      const rows = await result.json();
      if (!rows?.length) { jsonResponse(response, 404, { error:'Announcement not found.' }); return true; }
      jsonResponse(response, 200, { item:rows[0] }); return true;
    } catch (error) { jsonResponse(response, error.statusCode || 400, { error:error.message || 'Invalid content.' }); return true; }
  }
  jsonResponse(response, 405, { error:'Method Not Allowed' }); return true;
}
async function handleAdvertisingInquiry(request, response) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error:'Method Not Allowed' }); return true; }
  if (!supabaseServiceRoleKey) { jsonResponse(response, 503, { error:'Advertising enquiries are temporarily unavailable.' }); return true; }
  const forwardedFor = String(request.headers['x-forwarded-for'] || '').split(',').map(value => value.trim()).filter(Boolean);
  const ip = String(forwardedFor.length ? forwardedFor[forwardedFor.length - 1] : (request.socket?.remoteAddress || 'unknown')).slice(0, 80);
  const now = Date.now();
  const recent = advertisingSubmitAttempts.get(ip) || [];
  const allowed = recent.filter(t => now - t < 60 * 60 * 1000);
  if (allowed.length >= 5) { jsonResponse(response, 429, { error:'Too many enquiries from this connection. Please try again later.' }); return true; }
  try {
    const body = await readJson(request, 8192);
    if (cleanSiteText(body.website_trap, 100)) { jsonResponse(response, 202, { ok:true }); return true; }
    const item = {
      business_name:cleanSiteText(body.businessName,160), contact_name:cleanSiteText(body.contactName,120),
      email:cleanSiteText(body.email,254).toLowerCase(), phone:cleanSiteText(body.phone,40),
      website:cleanSiteText(body.website,500) || null, ad_type:body.adType, message:cleanSiteText(body.message,2000)
    };
    if (item.business_name.length < 1 || item.contact_name.length < 1 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email) || item.phone.length < 5 || item.message.length < 10 || !['banner','offer','sponsorship','other'].includes(item.ad_type) || !validHttpsUrl(item.website)) {
      jsonResponse(response, 400, { error:'Please complete the required fields and use HTTPS for a website link.' }); return true;
    }
    const result = await supabaseRequest(serviceToken(), 'rest/v1/advertising_inquiries', { method:'POST', prefer:'return=minimal', body:item, timeoutMs:12000 });
    if (!result.ok) { jsonResponse(response, 502, { error:'Your enquiry could not be saved. Please try again later.' }); return true; }
    allowed.push(now); advertisingSubmitAttempts.set(ip, allowed);
    jsonResponse(response, 201, { ok:true, message:'Thank you. Your advertising enquiry has been received.' }); return true;
  } catch (error) { jsonResponse(response, error.statusCode || 400, { error:error.message || 'Enquiry could not be submitted.' }); return true; }
}
async function handleAdminAdvertisingInquiries(request, response) {
  const admin = await requireAdmin(request);
  if (!admin) { jsonResponse(response, 403, { error:'Administrator role is required.' }); return true; }
  if (!supabaseServiceRoleKey) { jsonResponse(response, 503, { error:'Advertising inbox is unavailable.' }); return true; }
  const token = serviceToken();
  if (request.method === 'GET') {
    const result = await supabaseRequest(token, 'rest/v1/advertising_inquiries?select=*&order=created_at.desc&limit=100', { timeoutMs:12000 });
    if (!result.ok) { jsonResponse(response, 502, { error:'Advertising enquiries could not be loaded.' }); return true; }
    jsonResponse(response, 200, { items:await result.json() }); return true;
  }
  if (request.method === 'DELETE') {
    const body = await readJson(request, 2048);
    const id = String(body.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) { jsonResponse(response, 400, { error:'Invalid enquiry reference.' }); return true; }
    const existing = await supabaseRequest(token, 'rest/v1/advertising_inquiries?id=eq.'+encodeURIComponent(id)+'&select=id,status&limit=1', { timeoutMs:12000 });
    if (!existing.ok) { jsonResponse(response, 502, { error:'Enquiry could not be checked before deletion.' }); return true; }
    const inquiry = (await existing.json())?.[0];
    if (!inquiry) { jsonResponse(response, 404, { error:'Enquiry not found.' }); return true; }
    const quotes = await supabaseRequest(token, 'rest/v1/advertising_quotes?inquiry_id=eq.'+encodeURIComponent(id)+'&select=id&limit=1', { timeoutMs:12000 });
    if (!quotes.ok) { jsonResponse(response, 502, { error:'Quote/payment history could not be checked; enquiry was not deleted.' }); return true; }
    if ((await quotes.json()).length) { jsonResponse(response, 409, { error:'This enquiry has quote or payment history. Set its status to Closed instead; financial records are retained.' }); return true; }
    const removed = await supabaseRequest(token, 'rest/v1/advertising_inquiries?id=eq.'+encodeURIComponent(id)+'&select=id', { method:'DELETE', prefer:'return=representation', timeoutMs:12000 });
    if (!removed.ok) { jsonResponse(response, 502, { error:'Enquiry could not be deleted.' }); return true; }
    if (!(await removed.json())?.length) { jsonResponse(response, 404, { error:'Enquiry not found.' }); return true; }
    jsonResponse(response, 200, { deleted:true }); return true;
  }
  if (request.method === 'PATCH') {
    const body = await readJson(request, 4096);
    if (!/^[0-9a-f-]{36}$/i.test(String(body.id || '')) || !['new','contacted','approved','declined','closed'].includes(body.status)) { jsonResponse(response, 400, { error:'Invalid enquiry reference or status.' }); return true; }
    const result = await supabaseRequest(token, 'rest/v1/advertising_inquiries?id=eq.'+encodeURIComponent(body.id)+'&select=id,status', { method:'PATCH', prefer:'return=representation', body:{ status:body.status, updated_at:new Date().toISOString() }, timeoutMs:12000 });
    if (!result.ok) { jsonResponse(response, 502, { error:'Enquiry status could not be updated.' }); return true; }
    const rows = await result.json();
    if (!rows?.length) { jsonResponse(response, 404, { error:'Enquiry not found.' }); return true; }
    jsonResponse(response, 200, { item:rows[0] }); return true;
  }
  jsonResponse(response, 405, { error:'Method Not Allowed' }); return true;
}


function advertisingTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}
async function findAdvertisingQuoteByToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const digest = advertisingTokenHash(token);
  const result = await supabaseRequest(serviceToken(), 'rest/v1/advertising_quotes?select=id,inquiry_id,quote_version,status,amount_paise,currency,placement,starts_at,ends_at,expires_at,terms_snapshot,creative_requirements,acceptance_token_hash,issued_at,accepted_at,paid_at,created_at,updated_at&id=not.is.null&acceptance_token_hash=eq.' + encodeURIComponent(digest) + '&limit=1', { timeoutMs: 12000 });
  if (!result.ok) throw Object.assign(new Error('Advertising quote could not be loaded.'), { statusCode: 502 });
  return (await result.json())?.[0] || null;
}
function validAdvertisingQuoteInput(body) {
  const amountPaise = body?.amountPaise;
  const placement = body?.placement;
  const startsAt = new Date(body?.startsAt);
  const endsAt = new Date(body?.endsAt);
  const expiresAt = new Date(body?.expiresAt);
  const terms = cleanSiteText(body?.terms, 8000);
  const creativeRequirements = cleanSiteText(body?.creativeRequirements, 4000);
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 1 || amountPaise > 100000000000) throw Object.assign(new Error('Enter a valid advertising quote amount in paise.'), { statusCode: 400 });
  if (!['banner','homepage','sidebar'].includes(placement)) throw Object.assign(new Error('Choose a valid advertising placement.'), { statusCode: 400 });
  if ([startsAt, endsAt, expiresAt].some(date => Number.isNaN(date.getTime())) || endsAt <= startsAt || expiresAt <= new Date()) throw Object.assign(new Error('Enter valid advertising start, end, and quote-expiry dates.'), { statusCode: 400 });
  if (!terms) throw Object.assign(new Error('Written quote terms are required.'), { statusCode: 400 });
  return { amount_paise: amountPaise, currency:'INR', placement, starts_at:startsAt.toISOString(), ends_at:endsAt.toISOString(), expires_at:expiresAt.toISOString(), terms_snapshot:terms, creative_requirements:creativeRequirements };
}
async function writeAdvertisingAudit(eventType, quoteId, paymentId, actorId, details = {}) {
  const result = await supabaseRequest(serviceToken(), 'rest/v1/advertising_payment_audit', { method:'POST', prefer:'return=minimal', body:{ event_type:eventType, quote_id:quoteId || null, payment_id:paymentId || null, actor_user_id:actorId || null, details }, timeoutMs:12000 });
  if (!result.ok) console.warn('[advertising] Audit insert failed', { eventType, status:result.status });
}
async function handleAdminAdvertisingQuotes(request, response) {
  const admin = await requireAdmin(request);
  if (!admin) { jsonResponse(response, 403, { error:'Administrator role is required.' }); return true; }
  if (!supabaseServiceRoleKey) { jsonResponse(response, 503, { error:'Advertising quote management is unavailable.' }); return true; }
  const token = serviceToken();
  if (request.method === 'GET') {
    const result = await supabaseRequest(token, 'rest/v1/advertising_quotes?select=id,inquiry_id,quote_version,status,amount_paise,currency,placement,starts_at,ends_at,expires_at,terms_snapshot,creative_requirements,issued_at,accepted_at,paid_at,created_by,created_at,updated_at,advertising_inquiries(business_name,contact_name,email,phone,ad_type),advertising_payments(id,status,provider_order_id,provider_payment_id,verified_at,amount_paise,currency,created_at)&order=created_at.desc&limit=100', { timeoutMs:12000 });
    if (!result.ok) { jsonResponse(response, 502, { error:'Advertising quotes could not be loaded.' }); return true; }
    jsonResponse(response, 200, { items:await result.json() }); return true;
  }
  if (request.method === 'POST') {
    try {
      const body = await readJson(request, 12000);
      const inquiryId = String(body?.inquiryId || '');
      if (!/^[0-9a-f-]{36}$/i.test(inquiryId)) { jsonResponse(response, 400, { error:'Select a valid advertiser enquiry.' }); return true; }
      const inquiryResult = await supabaseRequest(token, 'rest/v1/advertising_inquiries?select=id,business_name,contact_name,email&id=eq.' + encodeURIComponent(inquiryId) + '&limit=1', { timeoutMs:12000 });
      if (!inquiryResult.ok) { jsonResponse(response, 502, { error:'Advertiser enquiry could not be loaded.' }); return true; }
      const inquiry = (await inquiryResult.json())?.[0];
      if (!inquiry) { jsonResponse(response, 404, { error:'Advertiser enquiry not found.' }); return true; }
      const latestResult = await supabaseRequest(token, 'rest/v1/advertising_quotes?select=quote_version&inquiry_id=eq.' + encodeURIComponent(inquiryId) + '&order=quote_version.desc&limit=1', { timeoutMs:12000 });
      if (!latestResult.ok) { jsonResponse(response, 502, { error:'Quote version could not be determined safely.' }); return true; }
      const version = Number((await latestResult.json())?.[0]?.quote_version || 0) + 1;
      const payload = { inquiry_id:inquiryId, quote_version:version, ...validAdvertisingQuoteInput(body), status:'draft', created_by:admin.id };
      const result = await supabaseRequest(token, 'rest/v1/advertising_quotes?select=id,inquiry_id,quote_version,status,amount_paise,currency,placement,starts_at,ends_at,expires_at,terms_snapshot,creative_requirements,created_at', { method:'POST', prefer:'return=representation', body:payload, timeoutMs:12000 });
      if (!result.ok) { jsonResponse(response, result.status === 409 ? 409 : 502, { error:'Quote could not be saved. Refresh and retry; the enquiry may have changed.' }); return true; }
      const quote = (await result.json())?.[0];
      await writeAdvertisingAudit('quote_created', quote?.id, null, admin.id, { inquiry_id:inquiryId, quote_version:version });
      jsonResponse(response, 201, { item:quote, advertiser:{ businessName:inquiry.business_name, email:inquiry.email } }); return true;
    } catch (error) { jsonResponse(response, error.statusCode || 400, { error:error.message || 'Invalid advertising quote.' }); return true; }
  }
  if (request.method === 'PATCH') {
    try {
      const body = await readJson(request, 12000);
      const id = String(body?.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) { jsonResponse(response, 400, { error:'Invalid quote reference.' }); return true; }
      const currentResult = await supabaseRequest(token, 'rest/v1/advertising_quotes?select=id,status&id=eq.' + encodeURIComponent(id) + '&limit=1'.replace(' ', ''), { timeoutMs:12000 });
      if (!currentResult.ok) { jsonResponse(response, 502, { error:'Quote could not be loaded.' }); return true; }
      const current = (await currentResult.json())?.[0];
      if (!current) { jsonResponse(response, 404, { error:'Quote not found.' }); return true; }
      if (body.action === 'issue') {
        if (current.status !== 'draft') { jsonResponse(response, 409, { error:'Only a draft quote can be issued.' }); return true; }
        if (!hasResendConfig()) { jsonResponse(response, 503, { error:'Quote email delivery is not configured. The quote remains a draft.' }); return true; }
        const quoteResult = await supabaseRequest(token, 'rest/v1/advertising_quotes?select=*&id=eq.' + encodeURIComponent(id) + '&limit=1', { timeoutMs:12000 });
        if (!quoteResult.ok) { jsonResponse(response, 502, { error:'Quote could not be loaded for issuing.' }); return true; }
        const quote = (await quoteResult.json())?.[0];
        if (!quote) { jsonResponse(response, 404, { error:'Quote not found.' }); return true; }
        const inquiryResult = await supabaseRequest(token, 'rest/v1/advertising_inquiries?select=business_name,email&id=eq.' + encodeURIComponent(quote.inquiry_id) + '&limit=1', { timeoutMs:12000 });
        const inquiry = (await inquiryResult.json())?.[0];
        if (!quote || !inquiry?.email) { jsonResponse(response, 409, { error:'A valid advertiser email is required before issuing the quote.' }); return true; }
        const rawToken = crypto.randomBytes(32).toString('base64url');
        const digest = advertisingTokenHash(rawToken);
        const issuedAt = new Date().toISOString();
        const update = await supabaseRequest(token, 'rest/v1/advertising_quotes?id=eq.' + encodeURIComponent(id) + '&status=eq.draft&select=id,status', { method:'PATCH', prefer:'return=representation', body:{ status:'issued', acceptance_token_hash:digest, issued_at:issuedAt, updated_at:issuedAt }, timeoutMs:12000 });
        if (!update.ok || !(await update.json())?.length) { jsonResponse(response, 409, { error:'Quote changed while issuing. Refresh and retry.' }); return true; }
        const quoteUrl = 'https://ecufileservice.in/advertising-quote.html#' + rawToken;
        const htmlEscape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        const emailBody = { from:emailFrom, to:[inquiry.email], subject:'Advertising quote from ECU File Service India', html:'<p>Hello '+htmlEscape(inquiry.business_name)+',</p><p>Your advertising quote is ready for review.</p><p><strong>Amount:</strong> ₹'+(Number(quote.amount_paise)/100).toFixed(2)+' INR<br><strong>Placement:</strong> '+htmlEscape(quote.placement)+'<br><strong>Schedule:</strong> '+htmlEscape(quote.starts_at)+' to '+htmlEscape(quote.ends_at)+'<br><strong>Quote expiry:</strong> '+htmlEscape(quote.expires_at)+'</p><p><a href="'+quoteUrl+'">Review quote and accept</a></p><p>'+htmlEscape(quote.terms_snapshot)+'</p><p>Payment does not automatically publish the advertisement; creative approval is separate.</p>' };
        let mail;
        try { mail = await requestHttps('https://api.resend.com/emails', { method:'POST', headers:{ Authorization:'Bearer '+resendApiKey, 'Content-Type':'application/json' }, body:JSON.stringify(emailBody), timeoutMs:15000 }); }
        catch { mail = null; }
        if (!mail?.ok) {
          await supabaseRequest(token, 'rest/v1/advertising_quotes?id=eq.'+encodeURIComponent(id)+'&status=eq.issued', { method:'PATCH', prefer:'return=minimal', body:{ status:'draft', acceptance_token_hash:null, issued_at:null, updated_at:new Date().toISOString() }, timeoutMs:12000 }).catch(()=>{});
          jsonResponse(response, 502, { error:'Quote email could not be delivered. The quote was returned to draft.' }); return true;
        }
        await writeAdvertisingAudit('quote_issued', id, null, admin.id, { quote_version:quote.quote_version });
        jsonResponse(response, 200, { ok:true, status:'issued' }); return true;
      }
      if (body.action === 'decline' && ['draft','issued'].includes(current.status)) {
        const result = await supabaseRequest(token, 'rest/v1/advertising_quotes?id=eq.'+encodeURIComponent(id)+'&status=in.(draft,issued)&select=id,status', { method:'PATCH', prefer:'return=representation', body:{ status:'declined', updated_at:new Date().toISOString() }, timeoutMs:12000 });
        const rows = await result.json().catch(()=>[]);
        if (!result.ok || !rows?.length) { jsonResponse(response, 409, { error:'Quote could not be declined.' }); return true; }
        await writeAdvertisingAudit('quote_declined', id, null, admin.id);
        jsonResponse(response, 200, { item:rows[0] }); return true;
      }
      jsonResponse(response, 400, { error:'Unsupported quote action.' }); return true;
    } catch (error) { jsonResponse(response, error.statusCode || 400, { error:error.message || 'Quote action failed.' }); return true; }
  }
  jsonResponse(response, 405, { error:'Method Not Allowed' }); return true;
}
async function handlePublicAdvertisingQuote(request, response) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error:'Method Not Allowed' }); return true; }
  if (!supabaseServiceRoleKey) { jsonResponse(response, 503, { error:'Advertising quotes are temporarily unavailable.' }); return true; }
  try {
    const body = await readJson(request, 4096);
    const token = String(body?.token || '');
    const quote = await findAdvertisingQuoteByToken(token);
    if (!quote || (new Date(quote.expires_at).getTime() <= Date.now() && !['payment_pending','paid'].includes(quote.status)) || ['declined','expired','cancelled','payment_failed'].includes(quote.status)) { jsonResponse(response, 404, { error:'This quote is unavailable or has expired.' }); return true; }
    const inquiryResult = await supabaseRequest(serviceToken(), 'rest/v1/advertising_inquiries?select=business_name&id=eq.'+encodeURIComponent(quote.inquiry_id)+'&limit=1', { timeoutMs:12000 });
    const inquiry = inquiryResult.ok ? (await inquiryResult.json())?.[0] : null;
    const publicQuote = { id:quote.id, version:quote.quote_version, status:quote.status, amountPaise:quote.amount_paise, currency:quote.currency, placement:quote.placement, startsAt:quote.starts_at, endsAt:quote.ends_at, expiresAt:quote.expires_at, terms:quote.terms_snapshot, creativeRequirements:quote.creative_requirements, businessName:inquiry?.business_name || 'Advertiser' };
    if (body.action === 'view') { jsonResponse(response, 200, { quote:publicQuote }); return true; }
    if (body.action !== 'accept') { jsonResponse(response, 400, { error:'Unsupported quote action.' }); return true; }
    if (quote.status === 'accepted' || quote.status === 'payment_pending' || quote.status === 'paid') { jsonResponse(response, 200, { status:quote.status }); return true; }
    if (quote.status !== 'issued') { jsonResponse(response, 409, { error:'This quote cannot be accepted in its current state.' }); return true; }
    const result = await supabaseRequest(serviceToken(), 'rest/v1/advertising_quotes?id=eq.'+encodeURIComponent(quote.id)+'&status=eq.issued&expires_at=gt.'+encodeURIComponent(new Date().toISOString())+'&select=id,status', { method:'PATCH', prefer:'return=representation', body:{ status:'accepted', accepted_at:new Date().toISOString(), updated_at:new Date().toISOString() }, timeoutMs:12000 });
    const rows = result.ok ? await result.json() : [];
    if (!rows?.length) { jsonResponse(response, 409, { error:'Quote changed or expired before acceptance. Refresh the quote.' }); return true; }
    await writeAdvertisingAudit('quote_accepted', quote.id, null, null, { quote_version:quote.quote_version });
    jsonResponse(response, 200, { status:'accepted' }); return true;
  } catch (error) { jsonResponse(response, error.statusCode || 400, { error:error.message || 'Advertising quote request failed.' }); return true; }
}
async function handleCreateAdvertisingPayment(request, response) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error:'Method Not Allowed' }); return true; }
  if (!supabaseServiceRoleKey || !hasRazorpayConfig()) { jsonResponse(response, 503, { error:'Advertising payments are temporarily unavailable.' }); return true; }
  try {
    const body = await readJson(request, 4096);
    const quote = await findAdvertisingQuoteByToken(String(body?.token || ''));
    if (!quote) { jsonResponse(response, 404, { error:'This quote is unavailable or has expired.' }); return true; }
    if (quote.status === 'paid') { jsonResponse(response, 200, { status:'paid' }); return true; }
    const quoteExpired = new Date(quote.expires_at).getTime() <= Date.now();
    if (quoteExpired && quote.status !== 'payment_pending') { jsonResponse(response, 410, { error:'This quote has expired. Contact ECU File Service India for a renewed quote.' }); return true; }
    if (!['accepted','payment_pending'].includes(quote.status)) { jsonResponse(response, 409, { error:'Accept the valid quote before starting payment.' }); return true; }
    const token = serviceToken();
    const existingResult = await supabaseRequest(token, 'rest/v1/advertising_payments?select=id,status,amount_paise,currency,provider_order_id,provider_payment_id,created_at&id=not.is.null&quote_id=eq.'+encodeURIComponent(quote.id)+'&status=in.(creating,created,authorized,captured,verified)&order=created_at.desc&limit=1', { timeoutMs:12000 });
    if (!existingResult.ok) { jsonResponse(response, 502, { error:'Payment session could not be checked.' }); return true; }
    let paymentRow = (await existingResult.json())?.[0];
    if (paymentRow?.status === 'verified') { jsonResponse(response, quote.status === 'paid' ? 200 : 409, quote.status === 'paid' ? { status:'paid' } : { error:'Payment records require reconciliation. Do not pay again; contact support.' }); return true; }
    if (paymentRow?.provider_order_id) {
      jsonResponse(response, 200, { provider:'razorpay', keyId:razorpayKeyId, providerOrderId:paymentRow.provider_order_id, amount:paymentRow.amount_paise, currency:paymentRow.currency, quoteId:quote.id }); return true;
    }
    if (paymentRow?.status === 'creating') {
      // Recover a crashed order-creation attempt. No checkout was returned to the browser,
      // so an expired reservation can be failed safely after the provider request timeout window.
      const creatingAgeMs = Date.now() - Date.parse(paymentRow.created_at || '');
      if (!Number.isFinite(creatingAgeMs) || creatingAgeMs < 2 * 60 * 1000) {
        jsonResponse(response, 409, { error:'A payment session is being prepared. Retry in a few seconds.' }); return true;
      }
      const staleAttempt = await supabaseRequest(token, 'rest/v1/advertising_payments?id=eq.'+encodeURIComponent(paymentRow.id)+'&status=eq.creating&select=id,status', {
        method:'PATCH', prefer:'return=representation',
        body:{ status:'failed', failure_code:'STALE_ORDER_CREATION', failure_message:'Order creation did not finish before the recovery window elapsed.', updated_at:new Date().toISOString() },
        timeoutMs:12000
      });
      const staleRows = staleAttempt.ok ? await staleAttempt.json().catch(()=>[]) : [];
      if (!staleRows?.length) { jsonResponse(response, 409, { error:'The payment session changed while recovery was attempted. Refresh and retry.' }); return true; }
      paymentRow = null;
    }
    if (!paymentRow && quoteExpired) { jsonResponse(response, 410, { error:'The quote expired before a payment order was ready. Contact ECU File Service India; do not pay again.' }); return true; }
    if (!paymentRow) {
      const idempotencyKey = 'adquote:'+quote.id+':'+crypto.randomUUID();
      const inserted = await supabaseRequest(token, 'rest/v1/advertising_payments?select=id,status,amount_paise,currency,provider_order_id', { method:'POST', prefer:'return=representation', body:{ quote_id:quote.id, status:'creating', amount_paise:quote.amount_paise, currency:quote.currency, idempotency_key:idempotencyKey }, timeoutMs:12000 });
      if (!inserted.ok) {
        const retry = await supabaseRequest(token, 'rest/v1/advertising_payments?select=id,status,amount_paise,currency,provider_order_id&quote_id=eq.'+encodeURIComponent(quote.id)+'&status=in.(creating,created,authorized,captured,verified)&order=created_at.desc&limit=1', { timeoutMs:12000 });
        const row = retry.ok ? (await retry.json())?.[0] : null;
        if (row?.provider_order_id) { jsonResponse(response, 200, { provider:'razorpay', keyId:razorpayKeyId, providerOrderId:row.provider_order_id, amount:row.amount_paise, currency:row.currency, quoteId:quote.id }); return true; }
        jsonResponse(response, 409, { error:'Another payment attempt is being prepared. Retry shortly.' }); return true;
      }
      paymentRow = (await inserted.json())?.[0];
    }
    if (!paymentRow?.id) { jsonResponse(response, 502, { error:'Payment session could not be reserved safely.' }); return true; }
    let order;
    try {
      order = await razorpayApi('orders', { method:'POST', body:{ amount:quote.amount_paise, currency:'INR', receipt:'adq_'+quote.id.replaceAll('-','').slice(0,24), notes:{ advertising_quote_id:quote.id, advertising_payment_id:paymentRow.id, quote_version:String(quote.quote_version) } } });
    } catch (error) {
      await supabaseRequest(token, 'rest/v1/advertising_payments?id=eq.'+encodeURIComponent(paymentRow.id)+'&status=eq.creating', { method:'PATCH', prefer:'return=minimal', body:{ status:'failed', failure_code:String(error.code||'ORDER_CREATE_FAILED').slice(0,80), failure_message:'Razorpay order creation failed; no checkout session was returned.', updated_at:new Date().toISOString() }, timeoutMs:12000 }).catch(()=>{});
      throw error;
    }
    if (!/^order_[A-Za-z0-9]+$/.test(String(order?.id || '')) || Number(order.amount)!==Number(quote.amount_paise) || order.currency!=='INR' || order?.notes?.advertising_quote_id!==quote.id || order?.notes?.advertising_payment_id!==paymentRow.id) {
      await supabaseRequest(token, 'rest/v1/advertising_payments?id=eq.'+encodeURIComponent(paymentRow.id)+'&status=eq.creating', { method:'PATCH', prefer:'return=minimal', body:{ status:'failed', failure_code:'INVALID_PROVIDER_ORDER', failure_message:'Razorpay returned an order that did not match the saved quote.', updated_at:new Date().toISOString() }, timeoutMs:12000 }).catch(()=>{});
      throw Object.assign(new Error('Razorpay returned an invalid advertising payment order.'), { statusCode:502 });
    }
    const update = await supabaseRequest(token, 'rest/v1/advertising_payments?id=eq.'+encodeURIComponent(paymentRow.id)+'&status=eq.creating&select=id', { method:'PATCH', prefer:'return=representation', body:{ status:'created', provider_order_id:order.id, updated_at:new Date().toISOString() }, timeoutMs:12000 });
    if (!update.ok || !(await update.json())?.length) throw Object.assign(new Error('Payment order could not be saved. Please retry safely.'), { statusCode:502 });
    await supabaseRequest(token, 'rest/v1/advertising_quotes?id=eq.'+encodeURIComponent(quote.id)+'&status=eq.accepted', { method:'PATCH', prefer:'return=minimal', body:{ status:'payment_pending', updated_at:new Date().toISOString() }, timeoutMs:12000 });
    await writeAdvertisingAudit('payment_order_created', quote.id, paymentRow.id, null, { provider_order_id:order.id, amount_paise:quote.amount_paise });
    jsonResponse(response, 200, { provider:'razorpay', keyId:razorpayKeyId, providerOrderId:order.id, amount:quote.amount_paise, currency:'INR', quoteId:quote.id });
  } catch (error) {
    jsonResponse(response, error.statusCode || (error.code === 'RAZORPAY_UPSTREAM' ? 502 : 400), { error:error.message || 'Advertising payment could not be created.' });
  }
  return true;
}
async function handleVerifyAdvertisingPayment(request, response) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error:'Method Not Allowed' }); return true; }
  if (!supabaseServiceRoleKey || !hasRazorpayConfig()) { jsonResponse(response, 503, { error:'Advertising payment verification is unavailable.' }); return true; }
  try {
    const body = await readJson(request, 4096);
    const token = String(body?.token || '');
    const quote = await findAdvertisingQuoteByToken(token);
    if (!quote) { jsonResponse(response, 404, { error:'Advertising quote not found.' }); return true; }
    const providerOrderId = String(body?.razorpayOrderId || body?.razorpay_order_id || '');
    const providerPaymentId = String(body?.razorpayPaymentId || body?.razorpay_payment_id || '');
    const signature = String(body?.razorpaySignature || body?.razorpay_signature || '');
    if (!/^order_[A-Za-z0-9]+$/.test(providerOrderId) || !/^pay_[A-Za-z0-9]+$/.test(providerPaymentId)) { jsonResponse(response, 400, { error:'Valid Razorpay payment references are required.' }); return true; }
    const expected = crypto.createHmac('sha256', razorpayKeySecret).update(providerOrderId+'|'+providerPaymentId).digest('hex');
    if (!safeEqualHex(signature, expected)) { jsonResponse(response, 402, { error:'Payment signature could not be verified.' }); return true; }
    const tokenService = serviceToken();
    const paymentResult = await supabaseRequest(tokenService, 'rest/v1/advertising_payments?select=id,status,amount_paise,currency,provider_order_id,provider_payment_id&quote_id=eq.'+encodeURIComponent(quote.id)+'&provider_order_id=eq.'+encodeURIComponent(providerOrderId)+'&limit=1', { timeoutMs:12000 });
    if (!paymentResult.ok) { jsonResponse(response, 502, { error:'Payment record could not be loaded.' }); return true; }
    const paymentRow = (await paymentResult.json())?.[0];
    if (!paymentRow) { jsonResponse(response, 404, { error:'This payment order does not belong to the quote.' }); return true; }
    if (paymentRow.status === 'verified' && paymentRow.provider_payment_id === providerPaymentId && quote.status === 'paid') { jsonResponse(response, 200, { status:'paid', quoteId:quote.id }); return true; }
    if (Number(paymentRow.amount_paise)!==Number(quote.amount_paise) || paymentRow.currency!=='INR') { jsonResponse(response, 402, { error:'Saved payment amount does not match the quote.' }); return true; }
    const razorOrder = await razorpayApi('orders/'+encodeURIComponent(providerOrderId));
    if (razorOrder?.id!==providerOrderId || Number(razorOrder.amount)!==Number(quote.amount_paise) || razorOrder.currency!=='INR' || razorOrder?.notes?.advertising_quote_id!==quote.id || razorOrder?.notes?.advertising_payment_id!==paymentRow.id) { jsonResponse(response, 402, { error:'Razorpay order does not match this advertising quote.' }); return true; }
    const payment = await razorpayApi('payments/'+encodeURIComponent(providerPaymentId));
    if (payment?.order_id!==providerOrderId || payment?.status!=='captured' || Number(payment.amount)!==Number(quote.amount_paise) || payment.currency!=='INR') { jsonResponse(response, 402, { error:'Razorpay has not confirmed the full quote amount as captured.' }); return true; }
    const finalized = await supabaseRequest(tokenService, 'rest/v1/rpc/efsi_finalize_advertising_payment', { method:'POST', body:{ p_quote_id:quote.id, p_payment_id:paymentRow.id, p_provider_order_id:providerOrderId, p_provider_payment_id:providerPaymentId, p_amount_paise:quote.amount_paise, p_currency:'INR' }, timeoutMs:15000 });
    if (!finalized.ok || (await finalized.json().catch(()=>false))!==true) { jsonResponse(response, 409, { error:'Payment was verified by the gateway but could not be safely finalized. Contact support; do not pay again.' }); return true; }
    jsonResponse(response, 200, { status:'paid', quoteId:quote.id });
  } catch (error) { jsonResponse(response, error.statusCode || (error.code === 'RAZORPAY_UPSTREAM' ? 502 : 400), { error:error.message || 'Advertising payment could not be verified.' }); }
  return true;
}

async function handleReconcileAdvertisingPayment(request, response) {
  if (request.method !== 'POST') { jsonResponse(response, 405, { error:'Method Not Allowed' }); return true; }
  if (!supabaseServiceRoleKey || !hasRazorpayConfig()) { jsonResponse(response, 503, { error:'Advertising payment recovery is unavailable.' }); return true; }
  try {
    const body = await readJson(request, 4096);
    const quote = await findAdvertisingQuoteByToken(String(body?.token || ''));
    if (!quote) { jsonResponse(response, 404, { error:'Advertising quote not found.' }); return true; }
    if (quote.status === 'paid') { jsonResponse(response, 200, { status:'paid', quoteId:quote.id }); return true; }
    if (!['accepted','payment_pending'].includes(quote.status)) { jsonResponse(response, 409, { error:'This quote is not awaiting payment.' }); return true; }
    const token = serviceToken();
    const rowsResponse = await supabaseRequest(token, 'rest/v1/advertising_payments?select=id,status,amount_paise,currency,provider_order_id&quote_id=eq.'+encodeURIComponent(quote.id)+'&status=in.(created,authorized,captured)&provider_order_id=not.is.null&order=created_at.desc&limit=1', { timeoutMs:12000 });
    if (!rowsResponse.ok) { jsonResponse(response, 502, { error:'Saved advertising payment could not be loaded.' }); return true; }
    const row = (await rowsResponse.json())?.[0];
    if (!row) { jsonResponse(response, 409, { error:'No saved payment order exists for this quote yet.' }); return true; }
    const order = await razorpayApi('orders/'+encodeURIComponent(row.provider_order_id));
    if (order?.id!==row.provider_order_id || Number(order.amount)!==Number(quote.amount_paise) || order.currency!=='INR' || order?.notes?.advertising_quote_id!==quote.id || order?.notes?.advertising_payment_id!==row.id) { jsonResponse(response, 402, { error:'The saved Razorpay order does not match this quote.' }); return true; }
    const result = await razorpayApi('orders/'+encodeURIComponent(row.provider_order_id)+'/payments');
    const items = Array.isArray(result?.items) ? result.items : [];
    const payment = items.find(item => item?.order_id===row.provider_order_id && item?.status==='captured' && Number(item.amount)===Number(quote.amount_paise) && item.currency==='INR');
    if (!payment || !/^pay_[A-Za-z0-9]+$/.test(String(payment.id||''))) { jsonResponse(response, 409, { error:'Razorpay has not reported a captured payment for this quote yet. Do not pay again; retry this check later.' }); return true; }
    const finalized = await supabaseRequest(token, 'rest/v1/rpc/efsi_finalize_advertising_payment', { method:'POST', body:{ p_quote_id:quote.id, p_payment_id:row.id, p_provider_order_id:row.provider_order_id, p_provider_payment_id:payment.id, p_amount_paise:quote.amount_paise, p_currency:'INR' }, timeoutMs:15000 });
    if (!finalized.ok || (await finalized.json().catch(()=>false))!==true) { jsonResponse(response, 409, { error:'Razorpay reports payment captured, but the saved record could not be finalized safely. Contact support; do not pay again.' }); return true; }
    jsonResponse(response, 200, { status:'paid', quoteId:quote.id });
  } catch (error) { jsonResponse(response, error.statusCode || (error.code === 'RAZORPAY_UPSTREAM' ? 502 : 400), { error:error.message || 'Advertising payment recovery failed.' }); }
  return true;
}


function softwareProductPayload(body, adminId, partial = false) {
  const out = {};
  if (!partial || body.title !== undefined) { out.title = cleanSiteText(body.title, 180); if (!out.title) throw Object.assign(new Error('Software title is required.'), {statusCode:400}); }
  if (!partial || body.description !== undefined) out.description = cleanSiteText(body.description, 4000);
  if (!partial || body.version !== undefined) out.version = cleanSiteText(body.version, 80);
  if (!partial || body.price_paise !== undefined) { const amount=Number(body.price_paise); if(!Number.isSafeInteger(amount)||amount<0||amount>100000000000) throw Object.assign(new Error('Enter a valid price in INR.'),{statusCode:400}); out.price_paise=amount; }
  if(!partial || body.price_visible!==undefined)out.price_visible=body.price_visible===true;
  for(const field of ['image_url','product_url','contact_url']) if(!partial||body[field]!==undefined){const value=cleanSiteText(body[field],1000);if(!validHttpsUrl(value))throw Object.assign(new Error(field+' must use HTTPS.'),{statusCode:400});out[field]=value||null;}
  if(!partial||body.sort_order!==undefined){const order=Number(body.sort_order??100);if(!Number.isInteger(order)||order<0||order>100000)throw Object.assign(new Error('Enter a valid listing order.'),{statusCode:400});out.sort_order=order;}
  if(!partial||body.is_published!==undefined)out.is_published=body.is_published===true;
  if(adminId&&!partial)out.created_by=adminId;
  out.updated_at=new Date().toISOString();return out;
}
async function handlePublicSoftwareProducts(request,response){
  if(request.method!=='GET'){jsonResponse(response,405,{error:'Method Not Allowed'});return true;}
  if(!supabaseServiceRoleKey){jsonResponse(response,200,{items:[]});return true;}
  const result=await supabaseRequest(serviceToken(),'rest/v1/software_products?select=id,title,description,version,price_paise,price_visible,currency,image_url,product_url,contact_url,sort_order,created_at&is_published=eq.true&order=created_at.desc&limit=100',{timeoutMs:12000});
  if(!result.ok){console.warn('[software-products] Public query failed',{status:result.status});jsonResponse(response,502,{error:'Software listings could not be loaded.'});return true;}
  jsonResponse(response,200,{items:(await result.json()).map(item=>item.price_visible?item:{...item,price_paise:null})});return true;
}
async function handleAdminSoftwareProducts(request,response){
  const admin=await requireAdmin(request);if(!admin){jsonResponse(response,403,{error:'Administrator role is required.'});return true;}
  if(!supabaseServiceRoleKey){jsonResponse(response,503,{error:'Software catalogue is unavailable.'});return true;}
  const token=serviceToken();
  if(request.method==='GET'){const result=await supabaseRequest(token,'rest/v1/software_products?select=*&order=sort_order.asc,created_at.desc&limit=200',{timeoutMs:12000});if(!result.ok){jsonResponse(response,502,{error:'Software listings could not be loaded.'});return true;}jsonResponse(response,200,{items:await result.json()});return true;}
  if(request.method==='DELETE'){try{const body=await readJson(request,12000),id=String(body.id||'');if(!/^[0-9a-f-]{36}$/i.test(id)){jsonResponse(response,400,{error:'Invalid software listing reference.'});return true;}
    const removed=await supabaseRequest(token,'rest/v1/software_products?id=eq.'+encodeURIComponent(id),{method:'DELETE',prefer:'return=representation',timeoutMs:12000});if(!removed.ok){const detail=await removed.text().catch(()=> '');const linked= /foreign key|constraint|referenced/i.test(detail);jsonResponse(response,linked?409:502,{error:linked?'This software has customer request history and cannot be permanently deleted. Use Hide to remove it from the public store while preserving customer records.':'Software listing could not be deleted. Please retry.'});return true;}const rows=await removed.json().catch(()=>[]);if(!rows?.length){jsonResponse(response,404,{error:'Software listing not found.'});return true;}jsonResponse(response,200,{deleted:true});return true;
  }catch(error){jsonResponse(response,error.statusCode||400,{error:error.message||'Software listing could not be deleted.'});return true;}}
  if(request.method==='POST'||request.method==='PATCH'){try{const body=await readJson(request,12000),partial=request.method==='PATCH';let id='';if(partial){id=String(body.id||'');if(!/^[0-9a-f-]{36}$/i.test(id)){jsonResponse(response,400,{error:'Invalid software listing reference.'});return true;}}
    const payload=softwareProductPayload(body,admin.id,partial),endpoint=partial?'rest/v1/software_products?id=eq.'+encodeURIComponent(id)+'&select=*':'rest/v1/software_products?select=*';
    const result=await supabaseRequest(token,endpoint,{method:partial?'PATCH':'POST',prefer:'return=representation',body:payload,timeoutMs:12000});if(!result.ok){jsonResponse(response,502,{error:'Software listing could not be saved.'});return true;}
    const rows=await result.json();if(partial&&!rows?.length){jsonResponse(response,404,{error:'Software listing not found.'});return true;}jsonResponse(response,partial?200:201,{item:rows?.[0]||null});return true;
  }catch(error){jsonResponse(response,error.statusCode||400,{error:error.message||'Invalid software listing.'});return true;}}
  jsonResponse(response,405,{error:'Method Not Allowed'});return true;
}

async function handleApi(request, response, url) {
  if (url.pathname === '/api/health') { jsonResponse(response, 200, { configured: hasSafeSupabaseConfig, paymentConfigured: paymentsConfigured(), paymentReadiness: paymentReadinessChecks() }); return true; }
  if (url.pathname === '/api/site-content') return handlePublicSiteContent(request, response);
  if (url.pathname === '/api/software-products') return handlePublicSoftwareProducts(request, response);
  if (url.pathname === '/api/admin/software-products') return handleAdminSoftwareProducts(request, response);
  if (url.pathname === '/api/admin/advertising/quotes') return handleAdminAdvertisingQuotes(request, response);
  if (url.pathname === '/api/advertising/quote') return handlePublicAdvertisingQuote(request, response);
  if (url.pathname === '/api/advertising/payment/create-order') return handleCreateAdvertisingPayment(request, response);
  if (url.pathname === '/api/advertising/payment/verify') return handleVerifyAdvertisingPayment(request, response);
  if (url.pathname === '/api/advertising/payment/reconcile') return handleReconcileAdvertisingPayment(request, response);
  if (url.pathname === '/api/advertising/inquiries') return handleAdvertisingInquiry(request, response);
  if (url.pathname === '/api/site-settings') return handlePublicSiteSettings(request, response);
  if (url.pathname === '/api/admin/site-settings') return handleAdminSiteSettings(request, response);
  if (url.pathname === '/api/admin/software-requests/payment-link') return handleAdminCreateSoftwarePaymentLink(request, response);
  if (url.pathname === '/api/admin/software-requests/verify-payment') return handleAdminVerifySoftwarePayment(request, response);
  if (url.pathname === '/api/customer/software-download') return handleCustomerSoftwareDownload(request, response);
  if (url.pathname === '/api/admin/site-content') return handleAdminSiteContent(request, response);
  if (url.pathname === '/api/admin/advertising/inquiries') return handleAdminAdvertisingInquiries(request, response);
  if (url.pathname === '/api/pricing') return handlePricing(request, response);
  if (url.pathname === '/api/checkout/intents') return handleCreateCheckoutIntent(request, response);
  const stageMatch = url.pathname.match(/^\/api\/checkout\/intents\/([0-9a-f-]{36})\/stage$/i);
  if (stageMatch) return handleStageCheckoutIntent(request, response, stageMatch[1]);
  if (url.pathname === '/api/payment/create-order' || url.pathname === '/api/payments/orders') return handleCreateRazorpayOrder(request, response);
  if (url.pathname === '/api/payment/verify' || url.pathname === '/api/payments/complete') return handleVerifyRazorpay(request, response);
  if (url.pathname === '/api/payment/reconcile') return handleReconcilePayment(request, response);
  if (url.pathname === '/api/payment/paypal/create-order' || url.pathname === '/api/payment/paypal/capture') { jsonResponse(response, 410, { error: 'PayPal is disabled. Use Razorpay checkout instead.' }); return true; }
  if (url.pathname === '/api/admin/orders/status') return handleAdminStatus(request, response);
  if (url.pathname === '/api/admin/payment-status') return handleAdminPaymentStatus(request, response);
  if (url.pathname === '/api/admin/orders/second-stage-amount' || url.pathname === '/api/admin/orders/set-second-stage' || url.pathname === '/api/admin/orders/second-stage/create-payment-link') return handleAdminCreateSecondStagePaymentLink(request, response);
  if (url.pathname === '/api/admin/orders/second-stage/mark-paid') return handleAdminMarkSecondStagePaid(request, response);
  if (url.pathname === '/api/admin/orders/second-stage/mark-unpaid') return handleAdminMarkSecondStageUnpaid(request, response);
  if (url.pathname === '/api/orders/messages' && request.method === 'GET') return handleGetMessages(request, response, url);
  if (url.pathname === '/api/orders/messages' && request.method === 'POST') return handleSendMessage(request, response);
  if (url.pathname === '/api/admin/orders/messages' && request.method === 'GET') return handleAdminGetMessages(request, response, url);
  if (url.pathname === '/api/admin/orders/messages/reply' && request.method === 'POST') return handleAdminReply(request, response);

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
    // Baseline browser hardening on every response, including API and error paths.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
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
    if (pathname === '/robots.txt') {
      const robotsBody = [
        'User-agent: *',
        'Allow: /',
        '',
        'Sitemap: https://ecufileservice.in/sitemap.xml',
        ''
      ].join('\n');
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache', 'Expires': '0', 'X-Content-Type-Options': 'nosniff' });
      response.end(robotsBody);
      return;
    }
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (!publicFiles.has(relative)) { response.writeHead(404).end('Not found'); return; }
    const target = path.join(root, relative);
    fs.readFile(target, (error, contents) => { if (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found'); return; } const cacheControl = relative.endsWith('.html') ? 'no-store' : 'no-cache, must-revalidate'; response.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' }); response.end(contents); });
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
