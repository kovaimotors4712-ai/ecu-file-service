(() => {
  const API = '/api/supabase/';
  const SESSION_KEY = 'efsi-auth-session';
  let session = readSession();
  let configured = false;
  let authEvent = null;
  let ordersRequest = 0;

  function readSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); }
    catch { return null; }
  }
  function saveSession(next) {
    session = next;
    if (next) sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else sessionStorage.removeItem(SESSION_KEY);
    renderAccountState();
  }
  function renderAccountState() {
    const trigger = document.querySelector('#account-trigger');
    const signedOut = document.querySelector('.account-signout');
    const email = session?.user?.email;
    if (trigger) trigger.textContent = email ? `Account · ${email}` : 'My account';
    if (signedOut) signedOut.hidden = !email;
    const ordersPanel = document.querySelector('#customer-orders');
    if (ordersPanel) ordersPanel.hidden = !email;
    if (email && dialog?.open) loadCustomerOrders();
  }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  async function loadCustomerOrders() {
    const panel = document.querySelector('#customer-orders');
    const list = panel?.querySelector('.customer-order-list');
    const customerId = session?.user?.id;
    if (!panel || !list || !customerId || !session?.access_token) return;
    const requestId = ++ordersRequest;
    list.textContent = 'Loading your orders…';
    try {
      const rows = await api.rest(`orders?select=id,status,category,vehicle_brand,vehicle_type,vehicle_model,vehicle_year,ecu_manufacturer,ecu_model,reading_tool,selected_services,payment_status,created_at,order_files!order_files_order_id_fkey(id,kind,original_name,object_path,created_at)&customer_id=eq.${encodeURIComponent(customerId)}&order=created_at.desc&limit=50`);
      if (requestId !== ordersRequest || session?.user?.id !== customerId) return;
      if (!Array.isArray(rows) || rows.length === 0) { list.textContent = 'No orders yet. Your completed and active requests will appear here.'; return; }
      list.innerHTML = rows.map(order => {
        const files = Array.isArray(order.order_files) ? order.order_files : [];
        const processed = files.filter(file => file.kind === 'processed');
        const vehicle = [order.vehicle_year, order.vehicle_brand, order.vehicle_model].filter(Boolean).join(' ');
        const module = [order.ecu_manufacturer, order.ecu_model].filter(Boolean).join(' · ');
        return `<article class="customer-order-card"><div class="customer-order-top"><b>${escapeHtml(vehicle || order.category)}</b><span>${escapeHtml(order.status)}</span></div><p>${escapeHtml(order.category)} · ${escapeHtml(order.vehicle_type)}${module ? ` · ${escapeHtml(module)}` : ''}</p><p>${escapeHtml((order.selected_services || []).join(', '))}</p><div class="customer-order-meta"><span>Payment: ${escapeHtml(order.payment_status || 'PAID')}</span><span>Original file: ${files.some(file => file.kind === 'original') ? 'received' : 'not linked'}</span></div>${processed.map(file => `<button type="button" class="customer-file-download" data-order-id="${escapeHtml(order.id)}" data-object-path="${escapeHtml(file.object_path)}" data-file-name="${escapeHtml(file.original_name)}">Download processed file · ${escapeHtml(file.original_name)}</button>`).join('') || (order.status === 'Completed' ? '<small>Completed order; the processed file is not listed yet. Contact support if you need help.</small>' : '<small>Your team is reviewing this request.</small>')}</article>`;
      }).join('');
    } catch (error) {
      if (requestId !== ordersRequest) return;
      list.textContent = `Your order history could not be loaded. ${error.message || 'Check your connection and retry.'}`;
    }
  }
  async function request(path, options = {}) {
    const token = await accessToken();
    const response = await fetch(`${API}${path}`, {
      method: options.method || 'GET',
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    });
    const raw = await response.text();
    let result;
    try { result = raw ? JSON.parse(raw) : null; } catch { result = raw; }
    if (!response.ok) throw new Error(result?.msg || result?.message || result?.error_description || result?.error || `Request failed (${response.status})`);
    return result;
  }
  async function accessToken() {
    if (!session?.access_token) return null;
    if (session.expires_at && session.expires_at < Math.floor(Date.now() / 1000) + 90 && session.refresh_token) {
      const response = await fetch(`${API}auth/v1/token?grant_type=refresh_token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token })
      });
      if (!response.ok) { saveSession(null); return null; }
      const refreshed = await response.json();
      saveSession(withExpiry(refreshed));
    }
    return session?.access_token || null;
  }
  function withExpiry(value) {
    return { ...value, expires_at: value.expires_at || Math.floor(Date.now() / 1000) + Number(value.expires_in || 3600) };
  }
  async function rest(tableQuery, { method = 'GET', body, prefer } = {}) {
    const token = await accessToken();
    const response = await fetch(`${API}rest/v1/${tableQuery}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(prefer ? { Prefer: prefer } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const raw = await response.text();
    let result;
    try { result = raw ? JSON.parse(raw) : null; } catch { result = raw; }
    if (!response.ok) throw new Error(result?.message || result?.details || result?.hint || result?.error || `Database request failed (${response.status})`);
    return result;
  }
  async function upload(bucketPath, file) {
    const token = await accessToken();
    const response = await fetch(`${API}storage/v1/object/${bucketPath}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: file
    });
    const raw = await response.text();
    let result;
    try { result = raw ? JSON.parse(raw) : null; } catch { result = raw; }
    if (!response.ok) throw new Error(result?.message || result?.error || `File upload failed (${response.status})`);
    return result;
  }
  async function download(bucketPath) {
    const token = await accessToken();
    const response = await fetch(`${API}storage/v1/object/${bucketPath}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!response.ok) {
      let message = `File download failed (${response.status})`;
      try { const body = await response.json(); message = body.message || body.error || message; } catch {}
      throw new Error(message);
    }
    return response.blob();
  }

  const api = {
    isConfigured: () => configured,
    getSession: () => session,
    getAuthEvent: () => authEvent,
    getAccessToken: accessToken,
    request,
    rest,
    upload,
    download,
    async signIn(email, password) {
      const result = await request('auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
      saveSession(withExpiry(result));
      return result;
    },
    async signUp(email, password) {
      const result = await request('auth/v1/signup', { method: 'POST', body: { email, password } });
      if (result.access_token) saveSession(withExpiry(result));
      return result;
    },
    async signOut() {
      if (session?.access_token) {
        try { await request('auth/v1/logout', { method: 'POST' }); } finally { saveSession(null); }
      } else saveSession(null);
    },
    auth: {
      async updateUser(attributes) {
        return request('auth/v1/user', { method: 'PUT', body: attributes });
      },
      async getUser() {
        return request('auth/v1/user');
      },
      async verifyRecoveryToken(tokenHash) {
        return request('auth/v1/verify', { method: 'POST', body: { type: 'recovery', token_hash: tokenHash } });
      },
      async resetPasswordForEmail(email, { redirectTo = window.location.origin } = {}) {
        const redirect = new URL(redirectTo, window.location.origin);
        if (redirect.origin !== window.location.origin) throw new Error('Password reset must return to this website.');
        return request(`auth/v1/recover?redirect_to=${encodeURIComponent(redirect.toString())}`, { method: 'POST', body: { email } });
      }
    }
  };
  window.EfsiSupabase = api;
  // Supabase Auth is proxied by the local server; expose the Auth calls with the
  // same method shape used by the Supabase client.
  const supabase = { auth: api.auth };

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
    document.querySelectorAll('.auth-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.mode === mode);
    });
    const signingUp = mode === 'signup';
    passwordInput.autocomplete = signingUp ? 'new-password' : 'current-password';
    confirmSignupPassword.hidden = !signingUp;
    confirmSignupPassword.disabled = !signingUp;
    confirmSignupPassword.required = signingUp;
    confirmSignupPassword.value = '';
    submit.innerHTML = signingUp ? 'Create account <span>→</span>' : 'Sign in <span>→</span>';
    if (clearMessage) message.textContent = '';
  }

  function showSignIn(messageText = '') {
    authTabs.hidden = false;
    form.hidden = false;
    resetForm.hidden = true;
    document.querySelector('.auth-reset').hidden = false;
    accountTitle.textContent = 'Sign in to your account';
    accountIntro.textContent = 'Save requests and access your private file history.';
    resetForm.reset();
    setMode('signin', false);
    message.textContent = messageText;
  }

  function showPasswordReset(messageText = '') {
    authTabs.hidden = true;
    form.hidden = true;
    resetForm.hidden = false;
    document.querySelector('.auth-reset').hidden = true;
    accountTitle.textContent = 'Set a new password';
    accountIntro.textContent = 'Choose a new password for your customer account.';
    message.textContent = messageText;
    if (!dialog.open) dialog.showModal();
    document.querySelector('#auth-new-password').focus();
  }

  document.querySelector('#account-trigger').addEventListener('click', () => { dialog.showModal(); if (session?.user?.id) loadCustomerOrders(); });
  document.querySelector('#refresh-customer-orders')?.addEventListener('click', loadCustomerOrders);
  document.querySelector('.customer-order-list')?.addEventListener('click', async event => {
    const button = event.target.closest('.customer-file-download');
    if (!button || button.disabled) return;
    const orderId = button.dataset.orderId;
    const objectPath = button.dataset.objectPath || '';
    if (!/^[0-9a-f-]{36}$/i.test(orderId || '') || !objectPath.startsWith(`${session?.user?.id}/${orderId}/processed/`)) {
      message.textContent = 'This file link is not valid for your account.';
      return;
    }
    button.disabled = true;
    message.textContent = 'Preparing your private download…';
    try {
      const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
      const blob = await api.download(`private-ecu-files/${encodedPath}`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = button.dataset.fileName || 'processed-file.bin';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      message.textContent = 'Your private file download has started.';
    } catch (error) { message.textContent = error.message || 'The file could not be downloaded. Please retry.'; }
    finally { button.disabled = false; }
  });
  document.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  document.querySelectorAll('.auth-tab').forEach(tab => tab.addEventListener('click', () => setMode(tab.dataset.mode)));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!configured) { message.textContent = 'Customer accounts are not connected yet. Supabase server configuration is required.'; return; }
    const values = new FormData(form);
    const email = String(values.get('email') || '').trim();
    if (mode === 'signup' && values.get('password') !== values.get('confirmPassword')) {
      message.textContent = 'The passwords do not match. Check both fields and try again.';
      confirmSignupPassword.focus();
      return;
    }
    submit.disabled = true;
    message.textContent = 'Connecting securely…';
    try {
      if (mode === 'signup') {
        const result = await api.signUp(email, values.get('password'));
        message.textContent = result.access_token ? 'Account created. You are signed in.' : 'Account request received. Check your inbox to confirm your email, then sign in.';
      } else {
        await api.signIn(email, values.get('password'));
        message.textContent = `Signed in as ${session.user?.email || email}.`;
      }
      passwordInput.value = '';
      confirmSignupPassword.value = '';
    } catch (error) { message.textContent = error.message; }
    finally { submit.disabled = false; renderAccountState(); }
  });
  document.querySelector('.auth-reset').addEventListener('click', async () => {
    if (!configured) { message.textContent = 'Customer accounts are not connected yet.'; return; }
    const emailInput = document.querySelector('#auth-email');
    const email = emailInput.value.trim();
    if (!email) { message.textContent = 'Enter your email address first.'; return; }
    emailInput.value = email;
    if (!emailInput.checkValidity()) {
      message.textContent = 'Enter a valid email address and try again.';
      emailInput.focus();
      return;
    }
    message.textContent = 'Sending a password reset email…';
    try {
      await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
      message.textContent = 'If an account uses that email, a reset link will arrive shortly. Check your inbox and spam folder.';
    } catch (error) {
      message.textContent = error.message || 'The password reset request could not be sent. Please try again.';
    }
  });
  document.querySelector('.auth-reset-back').addEventListener('click', () => {
    authEvent = null;
    saveSession(null);
    showSignIn();
  });
  resetForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!configured) { message.textContent = 'Customer accounts are not connected yet.'; return; }
    if (authEvent !== 'PASSWORD_RECOVERY' || !session?.access_token) {
      showSignIn('Open a valid password recovery link before setting a new password.');
      return;
    }
    const newPassword = document.querySelector('#auth-new-password').value;
    const confirmPassword = document.querySelector('#auth-confirm-password').value;
    if (newPassword.length < 8) { message.textContent = 'Choose a password with at least 8 characters.'; return; }
    if (newPassword !== confirmPassword) { message.textContent = 'The passwords do not match. Check both fields and try again.'; return; }
    resetSubmit.disabled = true;
    message.textContent = 'Updating your password…';
    try {
      await supabase.auth.updateUser({ password: newPassword });
      authEvent = null;
      saveSession(null);
      showSignIn('Your password has been updated. You can now sign in with your new password.');
    } catch (error) {
      message.textContent = error.message || 'Your password could not be updated. Request a new reset link and try again.';
    } finally { resetSubmit.disabled = false; }
  });

  async function handleAuthCallback() {
    const query = new URLSearchParams(location.search);
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
    const getParam = name => fragment.get(name) || query.get(name);
    const type = String(getParam('type') || '').toLowerCase();
    const recovery = type === 'recovery' || type === 'password_recovery';
    const authError = getParam('error_description') || getParam('error');
    if (!recovery && !authError) return;

    history.replaceState(null, document.title, location.pathname);
    if (authError) {
      showSignIn(`This password reset link could not be used: ${authError}. Request a new reset email and try again.`);
      if (!dialog.open) dialog.showModal();
      return;
    }

    const accessTokenValue = getParam('access_token');
    const tokenHash = getParam('token_hash');
    try {
      if (accessTokenValue) {
        saveSession(withExpiry({
          access_token: accessTokenValue,
          refresh_token: getParam('refresh_token'),
          token_type: getParam('token_type') || 'bearer',
          expires_in: Number(getParam('expires_in')) || 3600,
          expires_at: Number(getParam('expires_at')) || undefined
        }));
      } else if (tokenHash) {
        saveSession(null);
        saveSession(withExpiry(await api.auth.verifyRecoveryToken(tokenHash)));
      } else {
        throw new Error('The reset link did not include a recovery session. Request a new reset email and try again.');
      }
      if (!session?.access_token) throw new Error('The reset link is missing a valid recovery session. Request a new reset email and try again.');
      const user = await api.auth.getUser();
      if (!user?.id) throw new Error('The recovery session is invalid or expired. Request a new reset email and try again.');
      saveSession({ ...session, user });
      authEvent = 'PASSWORD_RECOVERY';
      showPasswordReset('Enter and confirm your new password below.');
    } catch (error) {
      authEvent = null;
      saveSession(null);
      showSignIn(error.message || 'This password reset link is invalid or expired. Request a new reset email and try again.');
      if (!dialog.open) dialog.showModal();
    }
  }

  document.querySelector('.account-signout').addEventListener('click', async () => {
    try { await api.signOut(); message.textContent = 'You are signed out.'; }
    catch (error) { message.textContent = error.message; }
  });

  fetch('/api/health', { cache: 'no-store' }).then(response => response.json()).then(result => {
    configured = Boolean(result.configured);
    if (!configured && !message.textContent) message.textContent = 'Customer accounts are not connected yet. Supabase server configuration is required.';
  }).catch(() => { if (!message.textContent) message.textContent = 'Account service is unavailable. Please contact us on WhatsApp.'; });
  handleAuthCallback();
  renderAccountState();
})();
