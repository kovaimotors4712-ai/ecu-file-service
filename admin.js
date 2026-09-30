(() => {
  const backend = window.EfsiSupabase;
  const loginPanel = document.querySelector('#admin-login');
  const deniedPanel = document.querySelector('#admin-denied');
  const dashboard = document.querySelector('#admin-dashboard');
  const message = document.querySelector('#admin-auth-message');
  const pricingForm = document.querySelector('#pricing-form');
  const pricingInput = document.querySelector('#file-verification-price');
  const pricingMessage = document.querySelector('#pricing-message');
  let orders = [];

  async function configured() {
    const response = await fetch('/api/health', { cache: 'no-store' });
    return Boolean((await response.json()).configured);
  }
  function showDenied(text) {
    loginPanel.hidden = true; dashboard.hidden = true; deniedPanel.hidden = false;
    document.querySelector('#admin-denied-message').textContent = text;
  }
  function setSignedOut() {
    loginPanel.hidden = false; deniedPanel.hidden = true; dashboard.hidden = true;
    document.querySelector('#admin-signout').hidden = true;
  }
  function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  function formatINR(paise) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(paise / 100);
  }
  function orderPricing(notes) {
    const value = String(notes || '');
    const match = value.match(/\[EFSI_PRICE_SNAPSHOT_V1\]\r?\nfile_verification_paise=(\d+)/);
    const pricePaise = match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
    const payment = value.match(/\[EFSI_PAYMENT_V1\]\r?\npayment_status=(PAID)\r?\npayment_provider=razorpay\r?\nrazorpay_order_id=(order_[A-Za-z0-9]+)\r?\nrazorpay_payment_id=(pay_[A-Za-z0-9]+)\r?\nrequest_sha256=[a-f0-9]{64}\r?\npayment_proof=[a-f0-9]{64}/i);
    const cleanNotes = value.replace(/(?:\r?\n){1,2}\[EFSI_PRICE_SNAPSHOT_V1\]\r?\nfile_verification_paise=\d+/, '').replace(/(?:\r?\n){1,2}\[EFSI_PAYMENT_V1\]\r?\npayment_status=PAID\r?\npayment_provider=[^\r\n]+\r?\nrazorpay_order_id=[^\r\n]+\r?\nrazorpay_payment_id=[^\r\n]+\r?\nrequest_sha256=[^\r\n]+\r?\npayment_proof=[^\r\n]+/i, '').trim();
    return { pricePaise, notes: cleanNotes, payment: payment ? { status: payment[1], provider: 'razorpay', paymentId: payment[3] } : null };
  }
  function nextStatus(status) { return ({ New: 'File Review', 'File Review': 'Processing', Processing: 'Completed' })[status] || null; }

  async function loadPricing() {
    pricingMessage.classList.remove('admin-error');
    pricingMessage.textContent = 'Loading current price…';
    try {
      const response = await fetch('/api/pricing', { cache: 'no-store' });
      const pricing = await response.json();
      if (!response.ok) throw new Error(pricing.error || `Pricing request failed (${response.status})`);
      if (pricing.currency !== 'INR' || !Number.isSafeInteger(pricing.fileVerificationPricePaise) || pricing.fileVerificationPricePaise < 0) throw new Error('The pricing configuration is invalid.');
      pricingInput.value = (pricing.fileVerificationPricePaise / 100).toFixed(2);
      pricingInput.disabled = false;
      pricingForm.querySelector('button[type="submit"]').disabled = false;
      pricingMessage.textContent = `Current fee: ${formatINR(pricing.fileVerificationPricePaise)}`;
    } catch (error) {
      pricingMessage.textContent = error.message;
      pricingMessage.classList.add('admin-error');
    }
  }

  pricingForm.addEventListener('submit', async event => {
    event.preventDefault();
    pricingMessage.classList.remove('admin-error');
    const rupees = Number(pricingInput.value);
    if (!Number.isFinite(rupees) || rupees < 0 || rupees > 1000000) {
      pricingMessage.textContent = 'Enter a price from ₹0 to ₹1,000,000.';
      pricingMessage.classList.add('admin-error');
      return;
    }
    const pricePaise = Math.round(rupees * 100);
    const button = pricingForm.querySelector('button[type="submit"]');
    button.disabled = true;
    pricingMessage.textContent = 'Saving price…';
    try {
      const token = await backend.getAccessToken();
      if (!token) throw new Error('Your admin session expired. Sign in again.');
      const response = await fetch('/api/pricing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fileVerificationPricePaise: pricePaise })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Price could not be saved (${response.status})`);
      pricingInput.value = (result.fileVerificationPricePaise / 100).toFixed(2);
      pricingMessage.textContent = `Price saved: ${formatINR(result.fileVerificationPricePaise)}. New requests will use this fee.`;
    } catch (error) {
      pricingMessage.textContent = error.message;
      pricingMessage.classList.add('admin-error');
    } finally { button.disabled = false; }
  });

  async function loadOrders() {
    const statusMessage = document.querySelector('#orders-message');
    statusMessage.textContent = 'Loading orders…';
    try {
      orders = await backend.rest('orders?select=*,order_files!order_files_order_id_fkey(*)&order=created_at.desc');
      if (!Array.isArray(orders)) throw new Error('The orders response was not a list.');
      const taggedOrders = orders.filter(order => String(order.notes || '').includes('[EFSI_PAYMENT_V1]'));
      if (taggedOrders.length) {
        const token = await backend.getAccessToken();
        const response = await fetch('/api/admin/payment-status', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ orderIds: taggedOrders.map(order => order.id) })
        });
        const verification = await response.json();
        if (!response.ok) throw new Error(verification.error || 'Payment records could not be verified.');
        orders = orders.map(order => ({ ...order, serverPaymentVerified: Boolean(verification.verified?.[order.id]) }));
      }
      document.querySelector('#stat-all').textContent = orders.length;
      document.querySelector('#stat-new').textContent = orders.filter(order => order.status === 'New').length;
      document.querySelector('#stat-active').textContent = orders.filter(order => ['File Review', 'Processing'].includes(order.status)).length;
      document.querySelector('#stat-completed').textContent = orders.filter(order => order.status === 'Completed').length;
      statusMessage.textContent = '';
      renderOrders();
    } catch (error) { statusMessage.textContent = error.message; statusMessage.classList.add('admin-error'); }
  }
  function renderOrders() {
    const list = document.querySelector('#order-list');
    if (!orders.length) { list.innerHTML = '<div class="admin-empty">No orders are visible. New customer requests will appear here.</div>'; return; }
    list.innerHTML = orders.map(order => {
      const services = (order.selected_services || []).join(', ');
      const files = order.order_files || [];
      const pricing = orderPricing(order.notes);
      const next = nextStatus(order.status);
      const hasProcessed = files.some(file => file.kind === 'processed');
      const disableComplete = next === 'Completed' && !hasProcessed;
      const verificationFee = pricing.pricePaise === null ? 'Not selected' : formatINR(pricing.pricePaise);
      const paymentDetails = pricing.payment && order.serverPaymentVerified ? `${pricing.payment.status} · ${escape(verificationFee)} · Razorpay` : pricing.payment ? 'Payment record unverified' : 'No verified payment record';
      return `<article class="admin-order" data-order-id="${escape(order.id)}"><div class="admin-order-head"><div><span class="admin-order-id">ORDER ${escape(order.id)}</span><h2>${escape(order.vehicle_year ? `${order.vehicle_year} ` : '')}${escape(order.vehicle_brand)} ${escape(order.vehicle_model)}</h2><time>${escape(new Date(order.created_at).toLocaleString())}</time></div><span class="admin-status">${escape(order.status)}</span></div><div class="admin-order-grid"><div><small>CUSTOMER</small><b>${escape(order.contact_name)} · ${escape(order.contact_phone)}<br>${escape(order.contact_email || '')}</b></div><div><small>SYSTEM / VEHICLE TYPE</small><b>${escape(order.category)} · ${escape(order.vehicle_type)}</b></div><div><small>ECU / MODULE</small><b>${escape([order.ecu_manufacturer, order.ecu_model].filter(Boolean).join(' · ') || 'Not specified')}</b></div><div><small>READING TOOL</small><b>${escape(order.reading_tool || 'Not specified')}</b></div><div><small>FILE SERVICES</small><b>${escape(services)}</b></div><div><small>FILE VERIFICATION FEE</small><b>${escape(verificationFee)}</b></div><div><small>PAYMENT STATUS</small><b>${paymentDetails}${pricing.payment ? `<br><small>Razorpay payment ref · ${escape(pricing.payment.paymentId)}</small>` : ''}</b></div><div><small>NOTES</small><b>${escape(pricing.notes || 'None')}</b></div></div><div class="admin-files"><h3>Order files</h3><div class="admin-file-list">${files.length ? files.map(file => `<span class="admin-file">${file.kind === 'processed' ? 'DELIVERABLE' : 'ORIGINAL'} · ${escape(file.original_name)} <button type="button" data-download="${escape(file.object_path)}" data-name="${escape(file.original_name)}">Download</button></span>`).join('') : '<span class="field-help">No uploaded files</span>'}</div></div><div class="admin-actions">${next ? `<button type="button" class="advance-status" data-next-status="${escape(next)}" ${disableComplete ? 'disabled title="Upload a processed file before completing this order."' : ''}>Move to ${escape(next)} →</button>` : ''}<label>Upload processed file<input type="file" accept=".bin,.ori,.mod,.hex,.eep,.epr,.dat,.zip,.rar,.7z,.txt,.read,.frf,.s19,.rom,.mpc,.a2l"></label></div><p class="admin-message" role="status"></p></article>`;
    }).join('');
    list.querySelectorAll('.advance-status').forEach(button => button.addEventListener('click', () => updateStatus(button.closest('.admin-order').dataset.orderId, button.dataset.nextStatus)));
    list.querySelectorAll('input[type=file]').forEach(input => input.addEventListener('change', () => {
      if (input.files[0]) uploadProcessed(input.closest('.admin-order').dataset.orderId, input.files[0], input.closest('.admin-order'));
    }));
    list.querySelectorAll('[data-download]').forEach(button => button.addEventListener('click', () => downloadFile(button.dataset.download, button.dataset.name)));
  }
  async function updateStatus(id, status) {
    const card = document.querySelector(`[data-order-id="${CSS.escape(id)}"]`);
    const localMessage = card.querySelector('.admin-message');
    localMessage.textContent = 'Saving status…';
    try {
      await backend.rest(`orders?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', prefer: 'return=minimal', body: { status } });
      await loadOrders();
    } catch (error) { localMessage.textContent = error.message; localMessage.classList.add('admin-error'); }
  }
  async function uploadProcessed(id, file, card) {
    const localMessage = card.querySelector('.admin-message');
    const order = orders.find(item => item.id === id);
    const userId = order?.customer_id;
    const session = backend.getSession();
    if (!userId || file.size > 50 * 1024 * 1024) { localMessage.textContent = !userId ? 'Order owner details are missing.' : 'File exceeds the 50 MB limit.'; return; }
    localMessage.textContent = 'Uploading to private storage…';
    try {
      const safeName = file.name.normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(-180) || 'processed.bin';
      const objectPath = `${userId}/${id}/processed/${crypto.randomUUID()}_${safeName}`;
      const encoded = objectPath.split('/').map(encodeURIComponent).join('/');
      await backend.upload(`private-ecu-files/${encoded}`, file);
      await backend.rest('order_files', { method: 'POST', body: {
        order_id: id, owner_id: userId, kind: 'processed', bucket_id: 'private-ecu-files',
        object_path: objectPath, original_name: file.name.slice(0, 255),
        mime_type: file.type || 'application/octet-stream', size_bytes: file.size,
        uploaded_by: session.user.id
      } });
      localMessage.textContent = 'Processed file uploaded and linked to the order.';
      await loadOrders();
    } catch (error) { localMessage.textContent = error.message; localMessage.classList.add('admin-error'); }
  }
  async function downloadFile(objectPath, name) {
    const statusMessage = document.querySelector('#orders-message');
    try {
      const encoded = objectPath.split('/').map(encodeURIComponent).join('/');
      const blob = await backend.download(`private-ecu-files/${encoded}`);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) { statusMessage.textContent = error.message; statusMessage.classList.add('admin-error'); }
  }
  async function enterAdmin() {
    const session = backend.getSession();
    if (!session?.user) { setSignedOut(); return; }
    if (session.user.app_metadata?.role !== 'admin') { showDenied('This account is signed in but has no admin role in trusted Supabase app_metadata.'); return; }
    loginPanel.hidden = true; deniedPanel.hidden = true; dashboard.hidden = false;
    document.querySelector('#admin-signout').hidden = false;
    await loadPricing();
    await loadOrders();
  }
  document.querySelector('#admin-auth').addEventListener('submit', async event => {
    event.preventDefault();
    message.classList.remove('admin-error'); message.textContent = 'Signing in…';
    try {
      if (!await configured()) throw new Error('Supabase is not configured on this server yet.');
      await backend.signIn(document.querySelector('#admin-email').value.trim(), document.querySelector('#admin-password').value);
      document.querySelector('#admin-password').value = '';
      await enterAdmin();
    } catch (error) { message.textContent = error.message; message.classList.add('admin-error'); }
  });
  document.querySelector('#admin-signout').addEventListener('click', async () => { await backend.signOut(); setSignedOut(); });
  document.querySelector('#admin-denied-signout').addEventListener('click', async () => { await backend.signOut(); setSignedOut(); });
  document.querySelector('#refresh-orders').addEventListener('click', loadOrders);
  configured().then(ready => { if (!ready) message.textContent = 'Supabase isn’t configured yet. See .env.example and the migration instructions.'; });
  enterAdmin();
})();
