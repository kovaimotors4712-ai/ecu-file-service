(() => {
  const SUPABASE_URL = window.SUPABASE_URL;
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;
  const API = '/api/supabase/';
  const SESSION_KEY = 'efsi-auth-session';
  let session = readSession();
  let configured = false;
  let authEvent = null;
  let ordersRequest = 0;
  let ordersChannel = null;
  let filesChannel = null;
  let realtimeClient = null;

  function readSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
  }
  function withExpiry(value) {
    return { ...value, expires_at: value.expires_at || Math.floor(Date.now() / 1000) + Number(value.expires_in || 3600) };
  }
  async function accessToken() {
    if (!session?.access_token) return null;
    if (session.expires_at && session.expires_at < Math.floor(Date.now() / 1000) + 90 && session.refresh_token) {
      try {
        const response = await fetch(`${API}auth/v1/token?grant_type=refresh_token`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh_token })
        });
        if (!response.ok) { saveSession(null); return null; }
        saveSession(withExpiry(await response.json()));
      } catch { saveSession(null); return null; }
    }
    return session?.access_token || null;
  }
  async function request(path, options = {}) {
    const token = await accessToken();
    const response = await fetch(`${API}${path}`, {
      method: options.method || 'GET',
      headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    });
    const raw = await response.text();
    let result; try { result = raw ? JSON.parse(raw) : null; } catch { result = raw; }
    if (!response.ok) {
      const message = typeof result === 'object' && result ? (result.error || result.message || result.msg || result.error_description) : null;
      throw new Error(message || `Request failed (${response.status})`);
    }
    return result;
  }
  async function rest(tableQuery, { method = 'GET', body, prefer } = {}) {
    const token = await accessToken();
    const response = await fetch(`${API}rest/v1/${tableQuery}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(prefer ? { Prefer: prefer } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const raw = await response.text();
    let result; try { result = raw ? JSON.parse(raw) : null; } catch { result = raw; }
    if (!response.ok) {
      const message = typeof result === 'object' && result ? (result.message || result.details || result.hint || result.error) : null;
      throw new Error(message || `Database request failed (${response.status})`);
    }
    return result;
  }
  async function upload(bucketPath, file) {
    const token = await accessToken();
    if (!token) throw new Error('Sign in before uploading a private file.');
    const encoded = bucketPath.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${encoded}`, {
      method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'false' }, body: file
    });
    const raw = await response.text();
    let result; try { result = raw ? JSON.parse(raw) : null; } catch { result = raw; }
    if (!response.ok && response.status !== 409) throw new Error(result?.message || result?.error || `File upload failed (${response.status})`);
    return result || { duplicate: response.status === 409 };
  }
  async function download(bucketPath) {
    const token = await accessToken();
    const encoded = bucketPath.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${encoded}`, { headers: { apikey: SUPABASE_ANON_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (!response.ok) { let body = null; try { body = await response.json(); } catch {} throw new Error(body?.message || body?.error || `File download failed (${response.status})`); }
    return response.blob();
  }
  function formatINR(paise) { return new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', minimumFractionDigits:0, maximumFractionDigits:2 }).format(Number(paise || 0) / 100); }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": "'" })[char]); }

  function saveSession(next) {
    const previousUserId = session?.user?.id;
    session = next;
    if (next) sessionStorage.setItem(SESSION_KEY, JSON.stringify(next)); else sessionStorage.removeItem(SESSION_KEY);
    if (previousUserId && previousUserId !== next?.user?.id) unsubscribeRealtime();
    renderAccountState();
  }

  function unsubscribeRealtime() {
    try { ordersChannel && realtimeClient?.removeChannel(ordersChannel); } catch {}
    try { filesChannel && realtimeClient?.removeChannel(filesChannel); } catch {}
    ordersChannel = null; filesChannel = null;
  }

  async function subscribeToOrders() {
    const customerId = session?.user?.id;
    const token = await accessToken();
    if (!customerId || !token || !window.supabase?.createClient) return;
    if (!realtimeClient) realtimeClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    try { realtimeClient.realtime.setAuth(token); } catch {}
    unsubscribeRealtime();
    ordersChannel = realtimeClient.channel(`customer-orders-${customerId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `customer_id=eq.${customerId}` }, () => loadCustomerOrders())
      .subscribe((status, error) => { if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.warn('Order realtime unavailable', error); });
    filesChannel = realtimeClient.channel(`customer-order-files-${customerId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_files', filter: `owner_id=eq.${customerId}` }, () => loadCustomerOrders())
      .subscribe((status, error) => { if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.warn('File realtime unavailable', error); });
  }

  function renderAccountState() {
    const trigger = document.querySelector('#account-trigger');
    const signout = document.querySelector('.account-signout');
    const email = session?.user?.email;
    if (trigger) trigger.textContent = email ? `Account · ${email}` : 'My account';
    if (signout) signout.hidden = !email;
    const ordersPanel = document.querySelector('#customer-orders');
    const pendingPanel = document.querySelector('#pending-checkouts');
    const notificationPanel = document.querySelector('#customer-notifications');
    if (ordersPanel) ordersPanel.hidden = !email;
    if (pendingPanel) pendingPanel.hidden = !email;
    if (notificationPanel) notificationPanel.hidden = !email;
    if (email && dialog?.open) {
      loadCustomerOrders(); loadPendingCheckouts(); loadCustomerNotifications(); subscribeToOrders();
      api.auth.getUser().then(user => {
        if (user?.id === session.user.id) {
          saveSession({
            ...session,
            user: {
              ...user,
              app_metadata: {
                ...(session.user.app_metadata || {}),
                ...(user.app_metadata || {})
              }
            }
          });
        }
      }).catch(console.error);
    }
  }

  async function loadCustomerOrders() {
    const panel = document.querySelector('#customer-orders');
    const list = panel?.querySelector('.customer-order-list');
    const customerId = session?.user?.id;
    if (!panel || !list || !customerId) return;
    const requestId = ++ordersRequest;
    list.textContent = 'Loading your orders…';
    try {
      const rows = await rest(`orders?select=id,status,category,vehicle_brand,vehicle_type,vehicle_model,vehicle_year,ecu_manufacturer,ecu_model,reading_tool,selected_services,payment_status,payment_provider,provider_order_id,provider_payment_id,second_stage_amount,second_stage_status,second_stage_payment_link,created_at,order_files!order_files_order_id_fkey(id,kind,original_name,object_path,created_at)&customer_id=eq.${encodeURIComponent(customerId)}&order=created_at.desc&limit=50`);
      if (requestId !== ordersRequest || session?.user?.id !== customerId) return;
      if (!Array.isArray(rows) || !rows.length) { list.textContent = 'No orders yet. Your active and completed requests will appear here.'; return; }
      list.innerHTML = rows.map(order => {
        const files = Array.isArray(order.order_files) ? order.order_files : [];
        const processed = files.filter(file => file.kind === 'processed' && String(file.object_path || '').startsWith(`${customerId}/${order.id}/processed/`));
        const vehicle = [order.vehicle_year, order.vehicle_brand, order.vehicle_model].filter(Boolean).join(' ');
        const statusSteps = ['Payment', 'File Received', 'File Review', 'Processing', 'Completed'];
        const currentStepIndex = statusSteps.indexOf(order.status) >= 0 ? statusSteps.indexOf(order.status) : 0;
        const timeline = `<div class="order-timeline">${statusSteps.map((step, index) => `<span class="${index <= currentStepIndex ? 'active' : ''}">${step}</span>`).join(' → ')}</div>`;
        const secondStage = order.second_stage_amount > 0 ? `
          <div style="margin-top:10px;padding:10px;background:#fff8ed;border:1px solid #fce3b8;border-radius:4px">
            <p style="margin:0 0 5px;font-size:12px"><strong>Second-Stage Payment:</strong> ${formatINR(order.second_stage_amount)} (${order.second_stage_status === 'paid' ? '<span style="color:#586b24">Paid</span>' : '<span style="color:#a87a2a">Pending</span>'})</p>
            ${(order.second_stage_status !== 'paid' && order.second_stage_payment_link) ? `<a href="${escapeHtml(order.second_stage_payment_link)}" target="_blank" rel="noopener noreferrer" class="button button-dark" style="font-size:10px;padding:5px 10px;text-decoration:none;display:inline-block">Pay Now</a>` : ''}
          </div>` : '';
        return `<article class="customer-order-card" data-order-id="${escapeHtml(order.id)}">
          <div class="customer-order-top">
            <b>Order: ${escapeHtml(order.id.slice(0, 8))}</b>
            <span>${escapeHtml(order.status)}</span>
          </div>
          <div class="customer-order-body">
            <p><strong>Vehicle:</strong> ${escapeHtml(vehicle || order.category)}</p>
            <p><strong>Services:</strong> ${escapeHtml((order.selected_services || []).join(', '))}</p>
            <p><strong>Created:</strong> ${new Date(order.created_at).toLocaleDateString()}</p>
            ${timeline}
            ${secondStage}
          </div>
          <div class="customer-order-actions">
            ${processed.length > 0 ? `<button type="button" class="customer-file-download" data-order-id="${escapeHtml(order.id)}" data-object-path="${escapeHtml(processed[0].object_path)}" data-file-name="${escapeHtml(processed[0].original_name)}">Result Ready · Download</button>` : '<small>Processing...</small>'}
            <button type="button" class="customer-messages-open" data-order-id="${escapeHtml(order.id)}">Messages</button>
          </div>
        </article>`;
      }).join('');
    } catch (error) { if (requestId === ordersRequest) list.textContent = `Your order history could not be loaded. ${error.message || 'Retry.'}`; }
  }

  async function loadCustomerNotifications() {
    const list = document.querySelector('#customer-notification-list');
    const customerId = session?.user?.id;
    if (!list || !customerId) return;
    list.textContent = 'Loading notifications…';
    try {
      const rows = await rest(`notifications?select=id,order_id,message,is_read,created_at&customer_id=eq.${encodeURIComponent(customerId)}&order=created_at.desc&limit=20`);
      const unreadCount = rows.filter(n => !n.is_read).length;
      const countEl = document.querySelector('.notification-count');
      if (countEl) countEl.textContent = unreadCount > 0 ? unreadCount : '';
      if (!Array.isArray(rows) || !rows.length) { list.innerHTML = '<small>No notifications yet.</small>'; return; }
      list.innerHTML = rows.map(item => `<article class="notification-item ${item.is_read ? '' : 'unread'}" data-notification-id="${escapeHtml(item.id)}" data-order-id="${escapeHtml(item.order_id)}"><div><p>${escapeHtml(item.message)}</p><small>${new Date(item.created_at).toLocaleString()}</small></div>${item.is_read ? '' : '<span class="unread-dot"></span>'}</article>`).join('');
    } catch (error) { list.innerHTML = `<small>Notifications could not be loaded: ${escapeHtml(error.message || 'Please retry.')}</small>`; }
  }

  async function markNotificationRead(notificationId) {
    try {
      await rest(`notifications?id=eq.${encodeURIComponent(notificationId)}`, { method: 'PATCH', body: { is_read: true } });
      await loadCustomerNotifications();
    } catch {}
  }
  async function loadPendingCheckouts() {
    const customerId = session?.user?.id;
    const list = document.querySelector('#pending-checkout-list');
    if (!list || !customerId) return;
    try {
      const rows = await rest(`checkout_intents?select=id,status,request_json,original_name,original_size,amount_paise,currency,payment_provider,provider_order_id,expires_at,updated_at&customer_id=eq.${encodeURIComponent(customerId)}&status=in.(DRAFT,FILE_STAGED,PAYMENT_PENDING)&order=updated_at.desc&limit=10`);
      if (!rows?.length) { list.innerHTML = '<small>No incomplete checkouts.</small>'; return; }
      list.innerHTML = rows.map(item => {
        const req = item.request_json || {};
        const vehicle = [req.vehicleYear, req.vehicleBrand, req.vehicleModel].filter(Boolean).join(' ');
        return `<article class="pending-checkout-item"><div><b>${escapeHtml(vehicle || req.category || 'Saved request')}</b><small>${escapeHtml(req.category || '')} · ${escapeHtml(item.original_name || 'original file')}</small></div><button type="button" class="button button-dark resume-checkout" data-intent-id="${escapeHtml(item.id)}">Continue · ${escapeHtml(item.status)}</button></article>`;
      }).join('');
    } catch (error) { list.textContent = `Saved checkout could not be loaded. ${error.message || ''}`; }
  }

  const api = {
    supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY, isConfigured: () => configured, getSession: () => session, getAuthEvent: () => authEvent, getAccessToken: accessToken, request, rest, upload, download,
    async signIn(email, password) { const result = await request('auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } }); saveSession(withExpiry(result)); return result; },
    async signUp(email, password) { const result = await request('auth/v1/signup', { method: 'POST', body: { email, password } }); if (result.access_token) saveSession(withExpiry(result)); return result; },
    async signOut() { try { if (session?.access_token) await request('auth/v1/logout', { method: 'POST' }); } finally { unsubscribeRealtime(); saveSession(null); } },
    auth: {
      async updateUser(attributes) { return request('auth/v1/user', { method: 'PUT', body: attributes }); },
      async getUser() { return request('auth/v1/user'); },
      async verifyRecoveryToken(tokenHash) { return request('auth/v1/verify', { method: 'POST', body: { type: 'recovery', token_hash: tokenHash } }); },
      async resetPasswordForEmail(email, { redirectTo = window.location.origin } = {}) { const redirect = new URL(redirectTo, window.location.origin); if (redirect.origin !== window.location.origin) throw new Error('Password reset must return to this website.'); return request(`auth/v1/recover?redirect_to=${encodeURIComponent(redirect.toString())}`, { method: 'POST', body: { email } }); }
    }
  };
  window.EfsiSupabase = api;

  const dialog = document.querySelector('#account-dialog');
  if (!dialog) return;
  const form = document.querySelector('#auth-form');
  const resetForm = document.querySelector('#auth-reset-form');
  const message = document.querySelector('.account-message');
  const passwordInput = document.querySelector('#auth-password');
  const confirmSignupPassword = document.querySelector('#auth-confirm-signup-password');
  const submit = document.querySelector('.auth-submit');
  const resetSubmit = document.querySelector('#auth-reset-submit');
  const authTabs = document.querySelector('.auth-tabs');
  const accountTitle = document.querySelector('#account-title');
  const accountIntro = document.querySelector('.account-intro');
  let mode = 'signin';

  function setMode(nextMode, clearMessage = true) {
    mode = nextMode;
    document.querySelectorAll('.auth-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.mode === mode));
    const signingUp = mode === 'signup';
    passwordInput.autocomplete = signingUp ? 'new-password' : 'current-password';
    confirmSignupPassword.hidden = !signingUp; confirmSignupPassword.disabled = !signingUp; confirmSignupPassword.required = signingUp; confirmSignupPassword.value = '';
    submit.innerHTML = signingUp ? 'Create account <span>→</span>' : 'Sign in <span>→</span>';
    if (clearMessage) message.textContent = '';
  }
  function showSignIn(text = '') { authTabs.hidden = false; form.hidden = false; resetForm.hidden = true; document.querySelector('.auth-reset').hidden = false; accountTitle.textContent = 'Sign in to your account'; accountIntro.textContent = 'Save requests and access your private file history.'; setMode('signin', false); message.textContent = text; }
  function showPasswordReset(text = '') { authTabs.hidden = true; form.hidden = true; resetForm.hidden = false; document.querySelector('.auth-reset').hidden = true; accountTitle.textContent = 'Set a new password'; accountIntro.textContent = 'Choose a new password for your customer account.'; message.textContent = text; if (!dialog.open) dialog.showModal(); document.querySelector('#auth-new-password').focus(); }

  document.querySelector('#account-trigger').addEventListener('click', () => { dialog.showModal(); if (session?.user?.id) { loadCustomerOrders(); loadPendingCheckouts(); subscribeToOrders(); } });
  document.querySelector('#customer-notification-list')?.addEventListener('click', async event => {
    const item = event.target.closest('.notification-item');
    if (!item) return;
    const notificationId = item.dataset.notificationId;
    const orderId = item.dataset.orderId;
    if (notificationId) markNotificationRead(notificationId);
    if (orderId) { dialog.close(); }
  });
  document.querySelector('#pending-checkout-list')?.addEventListener('click', async event => {
    const button = event.target.closest('.resume-checkout');
    if (!button) return;
    button.disabled = true;
    try {
      const rows = await rest(`checkout_intents?select=id,status,request_json,original_name,original_mime,original_size,original_sha256,storage_path,amount_paise,currency,payment_provider,provider_order_id,provider_payment_id,expires_at,updated_at&status=in.(DRAFT,FILE_STAGED,PAYMENT_PENDING)&id=eq.${encodeURIComponent(button.dataset.intentId)}&customer_id=eq.${encodeURIComponent(session?.user?.id || '')}&limit=1`);
      const intent = rows?.[0];
      if (!intent) throw new Error('Saved checkout was not found. It may have expired.');
      let recovered = false;
      if (intent.payment_provider && intent.provider_order_id) {
        try {
          const access = await accessToken();
          const response = await fetch('/api/payment/reconcile', { method:'POST', headers:{'Content-Type':'application/json', ...(access ? {Authorization:`Bearer ${access}`} : {})}, body:JSON.stringify({intentId:intent.id}) });
          const result = await response.json().catch(() => null);
          if (response.ok && result?.status === 'PAID') {
            recovered = true;
            await loadCustomerOrders();
            await loadPendingCheckouts();
            message.textContent = `Payment recovered. Order ${result.orderId || ''} is now available in your account.`;
          }
        } catch {}
      }
      if (!recovered) window.dispatchEvent(new CustomEvent('efsi:resume-checkout', { detail: intent }));
      dialog.close();
    } catch (error) {
      message.textContent = error.message || 'The saved checkout could not be resumed.';
    } finally {
      button.disabled = false;
    }
  });
  document.querySelector('.customer-order-list')?.addEventListener('click', async event => {
    const button = event.target.closest('.customer-pay-now'); if (!button || button.disabled) return;
    const orderId = button.dataset.orderId;
    if (!orderId) return;
    button.disabled = true;
    const prevText = button.textContent;
    button.textContent = 'Processing…';
    try {
      if (typeof window.Razorpay !== 'function') {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://checkout.razorpay.com/v1/checkout.js';
          script.onload = resolve;
          script.onerror = () => reject(new Error('Razorpay Checkout SDK failed to load.'));
          document.head.appendChild(script);
        });
      }
      const token = await accessToken();
      const res = await fetch('/api/payment/second-stage/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orderId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to initialize payment.');

      const rzp = new window.Razorpay({
        key: data.keyId,
        amount: data.amount,
        currency: data.currency,
        order_id: data.providerOrderId,
        name: data.businessName || 'ECU FILE SERVICE INDIA',
        description: 'Second-Stage Service Fee',
        handler: async function (response) {
          button.textContent = 'Verifying…';
          try {
            const verifyToken = await accessToken();
            const verifyRes = await fetch('/api/payment/second-stage/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${verifyToken}` },
              body: JSON.stringify({
                orderId,
                razorpayOrderId: response.razorpay_order_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature
              })
            });
            const verifyData = await verifyRes.json();
            if (!verifyRes.ok) throw new Error(verifyData.error || 'Payment verification failed.');
            await loadCustomerOrders();
          } catch (err) {
            alert(err.message || 'Verification error.');
            button.disabled = false;
            button.textContent = prevText;
          }
        },
        modal: {
          ondismiss: function () {
            button.disabled = false;
            button.textContent = prevText;
          }
        }
      });
      rzp.open();
    } catch (err) {
      alert(err.message || 'Payment failed to start.');
      button.disabled = false;
      button.textContent = prevText;
    }
  });

  document.querySelector('.customer-order-list')?.addEventListener('click', async event => {
    const button = event.target.closest('.customer-file-download'); if (!button || button.disabled) return;
    const orderId = button.dataset.orderId; const objectPath = button.dataset.objectPath || '';
    if (!/^[0-9a-f-]{36}$/i.test(orderId || '') || !objectPath.startsWith(`${session?.user?.id}/${orderId}/processed/`)) { message.textContent = 'This file link is not valid for your account.'; return; }
    button.disabled = true;
    try { const blob = await download(`private-ecu-files/${objectPath}`); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = button.dataset.fileName || 'processed-file.bin'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); message.textContent = 'Your private file download has started.'; } catch (error) { message.textContent = error.message || 'The file could not be downloaded.'; } finally { button.disabled = false; }
  });

  document.querySelector('.customer-order-list')?.addEventListener('click', async event => {
    const button = event.target.closest('.customer-messages-open'); if (!button) return;
    const orderId = button.dataset.orderId;
    openMessagesDialog(orderId);
  });

  async function openMessagesDialog(orderId) {
    const dialog = document.createElement('dialog');
    dialog.className = 'account-dialog';
    dialog.innerHTML = `<div class="messages-dialog" style="padding:20px;max-width:500px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px">
        <h3 style="margin:0;font-size:16px">Order Messages</h3>
        <button type="button" class="dialog-close-btn" style="padding:4px 8px">Close</button>
      </div>
      <div class="messages-list" style="max-height:300px;overflow-y:auto;border:1px solid var(--line);padding:10px;margin-bottom:15px;background:#fcfdfb;display:grid;gap:8px">Loading...</div>
      <form class="message-send-form" style="display:flex;gap:8px">
        <textarea name="message" required placeholder="Type a message related to this order..." maxlength="2000" style="flex:1;height:60px;padding:8px;resize:vertical"></textarea>
        <button type="submit" class="button" style="align-self:flex-end">Send</button>
      </form>
    </div>`;
    document.body.appendChild(dialog);
    dialog.showModal();

    dialog.querySelector('.dialog-close-btn').addEventListener('click', () => dialog.close());
    const list = dialog.querySelector('.messages-list');
    const form = dialog.querySelector('.message-send-form');

    async function loadMessages() {
      try {
        const res = await fetch(`/api/orders/messages?orderId=${encodeURIComponent(orderId)}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
        const result = await res.json();
        if (!res.ok) throw new Error(result?.error || 'Failed to load messages.');
        list.innerHTML = result.messages.length ? result.messages.map(m => `
          <div style="padding:8px 12px;border-radius:6px;background:${m.sender_type==='admin'?'#eef3ec':'#f1f5f9'};font-size:12px">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;font:750 10px var(--mono);color:#55605b">
              <span>${m.sender_type==='admin'?'ADMIN SUPPORT':'YOU'}</span>
              <span>${new Date(m.created_at).toLocaleString()}</span>
            </div>
            <div style="white-space:pre-wrap;word-break:break-word">${escapeHtml(m.message)}</div>
          </div>
        `).join('') : '<p style="color:#78847f;font-size:12px;margin:0">No messages yet. Send a message to our support team regarding this order.</p>';
        list.scrollTop = list.scrollHeight;
      } catch (e) { list.innerHTML = `<p style="color:#b91c1c;font-size:12px">${escapeHtml(e.message)}</p>`; }
    }

    loadMessages();

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const textarea = form.querySelector('textarea');
      const msg = textarea.value.trim();
      if (!msg) return;
      try {
        const res = await fetch('/api/orders/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ orderId, message: msg }) });
        const result = await res.json();
        if (!res.ok) throw new Error(result?.error || 'Failed to send message.');
        textarea.value = '';
        loadMessages();
      } catch (e) { alert(e.message); }
    });

    dialog.addEventListener('close', () => dialog.remove());
  }
  document.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => unsubscribeRealtime());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  document.querySelectorAll('.auth-tab').forEach(tab => tab.addEventListener('click', () => setMode(tab.dataset.mode)));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!configured) { message.textContent = 'Customer accounts are not connected yet.'; return; }
    const values = new FormData(form); const email = String(values.get('email') || '').trim();
    if (mode === 'signup' && values.get('password') !== values.get('confirmPassword')) { message.textContent = 'The passwords do not match.'; return; }
    submit.disabled = true; message.textContent = 'Connecting securely…';
    try { if (mode === 'signup') { const result = await api.signUp(email, values.get('password')); message.textContent = result.access_token ? 'Account created. You are signed in.' : 'Account request received. Check your inbox to confirm your email, then sign in.'; } else { await api.signIn(email, values.get('password')); message.textContent = `Signed in as ${session.user?.email || email}.`; } passwordInput.value = ''; confirmSignupPassword.value = ''; }
    catch (error) { message.textContent = error.message; } finally { submit.disabled = false; renderAccountState(); }
  });
  document.querySelector('.auth-reset').addEventListener('click', async () => {
    if (!configured) { message.textContent = 'Customer accounts are not connected yet.'; return; }
    const emailInput = document.querySelector('#auth-email'); const email = emailInput.value.trim();
    if (!email || !emailInput.checkValidity()) { message.textContent = 'Enter a valid email address first.'; emailInput.focus(); return; }
    message.textContent = 'Sending a password reset email…';
    try { await api.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin }); message.textContent = 'If an account uses that email, a reset link will arrive shortly. Check your inbox and spam folder.'; } catch (error) { message.textContent = error.message || 'The reset request could not be sent.'; }
  });
  document.querySelector('.auth-reset-back').addEventListener('click', () => { authEvent = null; saveSession(null); showSignIn(); });
  resetForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!configured || authEvent !== 'PASSWORD_RECOVERY' || !session?.access_token) { showSignIn('Open a valid password recovery link before setting a new password.'); return; }
    const newPassword = document.querySelector('#auth-new-password').value; const confirmPassword = document.querySelector('#auth-confirm-password').value;
    if (newPassword.length < 8) { message.textContent = 'Choose a password with at least 8 characters.'; return; }
    if (newPassword !== confirmPassword) { message.textContent = 'The passwords do not match.'; return; }
    resetSubmit.disabled = true; message.textContent = 'Updating your password…';
    try { await api.auth.updateUser({ password: newPassword }); authEvent = null; saveSession(null); showSignIn('Your password has been updated.'); } catch (error) { message.textContent = error.message || 'Your password could not be updated.'; } finally { resetSubmit.disabled = false; }
  });

  async function handleAuthCallback() {
    const query = new URLSearchParams(location.search); const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
    const getParam = name => fragment.get(name) || query.get(name); const type = String(getParam('type') || '').toLowerCase(); const recovery = type === 'recovery' || type === 'password_recovery';
    const authError = getParam('error_description') || getParam('error'); if (!recovery && !authError) return;
    history.replaceState(null, document.title, location.pathname);
    if (authError) { showSignIn(`This password reset link could not be used: ${authError}.`); if (!dialog.open) dialog.showModal(); return; }
    try {
      const access = getParam('access_token'); const hash = getParam('token_hash');
      if (access) saveSession(withExpiry({ access_token: access, refresh_token: getParam('refresh_token'), token_type: getParam('token_type') || 'bearer', expires_in: Number(getParam('expires_in')) || 3600, expires_at: Number(getParam('expires_at')) || undefined }));
      else if (hash) { saveSession(null); saveSession(withExpiry(await api.auth.verifyRecoveryToken(hash))); }
      else throw new Error('The reset link did not include a recovery session.');
      const user = await api.auth.getUser(); if (!user?.id) throw new Error('The recovery session is invalid or expired.');
      saveSession({ ...session, user }); authEvent = 'PASSWORD_RECOVERY'; showPasswordReset('Enter and confirm your new password below.');
    } catch (error) { authEvent = null; saveSession(null); showSignIn(error.message || 'This recovery link is invalid or expired.'); if (!dialog.open) dialog.showModal(); }
  }

  document.querySelector('.account-signout').addEventListener('click', async () => { try { await api.signOut(); message.textContent = 'You are signed out.'; } catch (error) { message.textContent = error.message; } });
  fetch('/api/health', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(result => { configured = Boolean(result?.configured); if (!configured && !message.textContent) message.textContent = 'Customer accounts are not connected yet. Supabase server configuration is required.'; }).catch(() => { if (!message.textContent) message.textContent = 'Account service is unavailable. Please retry.'; });
  handleAuthCallback();
  renderAccountState();
})();
