(() => {
  const form = document.querySelector('#order-form');
  const pages = [...document.querySelectorAll('.form-page')];
  const progress = [...document.querySelectorAll('.progress-step')];
  const fileInput = document.querySelector('#original-file');
  const verificationPriceLabel = document.querySelector('#verification-price');
  const brandInput = document.querySelector('#brand');
  const brandResults = document.querySelector('#brand-results');
  const maxFileSize = 50 * 1024 * 1024;
  let currentPage = 0;
  let activeBrandOption = -1;
  let savedOrderId = null;
  let fileVerificationPricePaise = null;
  let capturedPayment = null;
  let paymentReady = false;
  let razorpayScriptPromise = null;
  let checkoutStarting = false;

  function loadRazorpayCheckout(timeoutMs = 12000) {
    if (typeof window.Razorpay === 'function') return Promise.resolve(window.Razorpay);
    if (razorpayScriptPromise) return razorpayScriptPromise;
    razorpayScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.onload = null;
        script.onerror = null;
        if (error) reject(error);
        else if (typeof window.Razorpay === 'function') resolve(window.Razorpay);
        else reject(new Error('Razorpay Checkout loaded without its checkout API. Reload the page and retry.'));
      };
      const timer = setTimeout(() => finish(new Error('Razorpay Checkout did not load in time. Check your connection and retry.')), timeoutMs);
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.async = true;
      script.dataset.razorpayCheckout = 'true';
      script.onload = () => finish();
      script.onerror = () => finish(new Error('Razorpay Checkout could not load. Check your connection or content blocker and retry.'));
      document.head.appendChild(script);
    }).catch(error => {
      razorpayScriptPromise = null;
      throw error;
    });
    return razorpayScriptPromise;
  }

  async function fetchJsonWithTimeout(url, options, timeoutMs, timeoutMessage) {
    let response;
    try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) }); }
    catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error(timeoutMessage);
      throw new Error('The secure payment server could not be reached. Your file was not submitted; please retry.');
    }
    let result;
    try { result = await response.json(); }
    catch { throw new Error(`The secure payment server returned an unreadable response (HTTP ${response.status}). Your file was not submitted.`); }
    return { response, result };
  }

  function withTimeout(promise, timeoutMs, timeoutMessage) {
    let timer;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs); })
    ]).finally(() => clearTimeout(timer));
  }

  const brandGroups = [
    ['Indian passenger & EV', ['Ather', 'Bajaj', 'Bajaj Auto', 'BYD', 'Citroën', 'DC2', 'Hindustan Motors', 'Isuzu', 'Kinetic', 'LML', 'Mahindra', 'Mahindra Electric', 'Maruti Suzuki', 'MG Motor', 'Morris Garages', 'OLA Electric', 'Premier', 'Pravaig', 'Revolt', 'Royal Enfield', 'Strom Motors', 'Tata Motors', 'Tork Motors', 'TVS', 'VinFast']],
    ['Indian commercial & bus', ['AMW', 'Ashok Leyland', 'Atul Auto', 'BharatBenz', 'Bharat Earth Movers (BEML)', 'Eicher', 'Force Motors', 'JBM Auto', 'Mahindra Truck and Bus', 'Olectra Greentech', 'Piaggio Commercial Vehicles', 'SML Isuzu', 'Tata Daewoo', 'Tata Motors Commercial Vehicles', 'VE Commercial Vehicles']],
    ['Tractor & agricultural', ['ACE (Action Construction Equipment)', 'Captain Tractors', 'Eicher Tractors', 'Escorts Kubota', 'Farmtrac', 'Hindustan Tractors', 'John Deere', 'Kubota', 'Mahindra Tractors', 'New Holland Agriculture', 'Preet', 'Sonalika', 'Swaraj', 'TAFE', 'VST Tillers Tractors', 'Yanmar']],
    ['Construction & off-road', ['Atlas Copco', 'BEML', 'Bobcat', 'Caterpillar', 'CASE Construction', 'Doosan', 'Eicher Construction', 'Hitachi', 'Hyundai Construction Equipment', 'JCB', 'Komatsu', 'Liebherr', 'LiuGong', 'Manitou', 'SANY', 'Scania Industrial', 'Tata Hitachi', 'Terex', 'Volvo Construction Equipment', 'Wirtgen']],
    ['Japanese & Korean', ['Daewoo', 'Datsun', 'Genesis', 'Honda', 'Hyundai', 'Infiniti', 'Isuzu', 'Kia', 'Lexus', 'Mazda', 'Mitsubishi', 'Nissan', 'SsangYong / KGM', 'Subaru', 'Suzuki', 'Toyota']],
    ['European', ['Abarth', 'Alfa Romeo', 'Aston Martin', 'Bentley', 'Bugatti', 'Citroën', 'Cupra', 'Dacia', 'DS Automobiles', 'Ferrari', 'Fiat', 'Jaguar', 'Lamborghini', 'Land Rover', 'Lotus', 'Maserati', 'McLaren', 'Mercedes-Benz', 'MINI', 'Opel', 'Peugeot', 'Porsche', 'Renault', 'Rolls-Royce', 'SEAT', 'Škoda', 'Smart', 'Volkswagen', 'Volvo']],
    ['Other international & premium', ['Acura', 'Cadillac', 'Chevrolet', 'Chrysler', 'Dodge', 'GMC', 'Hummer', 'Jeep', 'Lucid', 'Polestar', 'Rivian', 'Tesla', 'Other / Not Listed']]
  ];

  document.querySelector('#year').textContent = new Date().getFullYear();

  function formatINR(paise) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(paise / 100);
  }

  async function loadPricing() {
    try {
      const response = await fetch('/api/pricing', { cache: 'no-store', signal: AbortSignal.timeout(7000) });
      if (!response.ok) throw new Error('Pricing unavailable');
      const pricing = await response.json();
      if (pricing.currency !== 'INR' || !Number.isSafeInteger(pricing.fileVerificationPricePaise) || pricing.fileVerificationPricePaise < 0) throw new Error('Invalid pricing');
      fileVerificationPricePaise = pricing.fileVerificationPricePaise;
      const formattedFee = formatINR(fileVerificationPricePaise);
      verificationPriceLabel.textContent = formattedFee;
      document.querySelectorAll('[data-fee-inline]').forEach(label => { label.textContent = formattedFee; });
      const submitButton = document.querySelector('.verification-submit');
      submitButton.disabled = true;
      const [healthResult, checkoutResult] = await Promise.allSettled([
        fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(7000) }).then(response => {
          if (!response.ok) throw new Error(`Health check failed (HTTP ${response.status}).`);
          return response.json();
        }),
        loadRazorpayCheckout()
      ]);
      paymentReady = healthResult.status === 'fulfilled' && Boolean(healthResult.value.paymentConfigured);
      const checkoutLoaded = checkoutResult.status === 'fulfilled';
      submitButton.disabled = fileVerificationPricePaise < 1 || !paymentReady || !checkoutLoaded;
      const status = document.querySelector('.verification-status');
      status.textContent = !paymentReady
        ? 'Secure payment is not configured or the payment server did not respond. Your file will not be submitted.'
        : !checkoutLoaded
          ? checkoutResult.reason?.message || 'Razorpay Checkout could not load. Your file will not be submitted.'
          : 'Secure checkout verifies your payment before your order or file is submitted.';
      if (!paymentReady) status.dataset.error = 'true';
      else if (!checkoutLoaded) status.dataset.error = 'true';
      else delete status.dataset.error;
      updateSummary();
    } catch {
      verificationPriceLabel.textContent = 'Price unavailable';
      document.querySelectorAll('[data-fee-inline]').forEach(label => { label.textContent = 'Price unavailable'; });
      document.querySelector('.verification-submit').disabled = true;
      paymentReady = false;
      document.querySelector('.verification-status').textContent = 'The verification fee or payment service could not be loaded. Reload the page or contact support; your file will not be submitted.';
      document.querySelector('.verification-status').dataset.error = 'true';
      updateSummary();
    }
  }

  function setPage(index) {
    currentPage = index;
    pages.forEach((page, i) => page.classList.toggle('active', i === index));
    progress.forEach((step, i) => step.classList.toggle('active', i <= Math.min(index, progress.length - 1)));
    document.querySelector('.order-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (index === 5) updateSummary();
    if (index === 6) updateWhatsAppLink();
  }

  function showError(pageIndex, message) {
    const box = pages[pageIndex].querySelector('.form-error');
    box.textContent = message;
    box.classList.add('visible');
  }

  function clearError(pageIndex) {
    const box = pages[pageIndex]?.querySelector('.form-error');
    if (box) { box.textContent = ''; box.classList.remove('visible'); }
  }

  function validatePage(index) {
    clearError(index);
    if (index === 1) {
      const missing = ['#brand', '#vehicle-type', '#vehicle-model'].some(selector => !form.querySelector(selector).value.trim());
      if (missing) { showError(index, 'Please choose or enter a brand, vehicle type, and model or variant.'); return false; }
    }
    if (index === 3 && !form.querySelector('input[name="service"]:checked')) {
      showError(index, 'Please choose at least one file service to continue.'); return false;
    }
    if (index === 4) {
      if (!fileInput.files[0]) {
        showError(index, 'Please attach your original file before continuing to verification.'); return false;
      }
      if (!form.elements.name.value.trim() || !form.elements.phone.value.trim()) {
        showError(index, 'Please enter your name and a WhatsApp or phone number.'); return false;
      }
      if (fileInput.files[0] && fileInput.files[0].size > maxFileSize) {
        showError(index, 'That file is over 50 MB. Please compress it or contact us on WhatsApp.'); return false;
      }
      if (form.elements.email.value && !form.elements.email.validity.valid) {
        showError(index, 'Please enter a valid email address or leave it blank.'); return false;
      }
    }
    if (index === 5 && !form.elements.consent.checked) {
      showError(index, 'Please confirm you’re authorised to submit this request.'); return false;
    }
    return true;
  }

  document.querySelectorAll('.next-button').forEach(button => button.addEventListener('click', () => {
    if (validatePage(currentPage)) setPage(currentPage + 1);
  }));
  document.querySelectorAll('.button-back').forEach(button => button.addEventListener('click', () => setPage(Math.max(0, currentPage - 1))));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!validatePage(5)) return;
    if (checkoutStarting) return;
    if (capturedPayment) {
      await finishVerifiedPayment(capturedPayment);
      return;
    }
    const submitButton = document.querySelector('.verification-submit');
    const status = document.querySelector('.verification-status');
    const backend = window.EfsiSupabase;
    const session = backend?.getSession();
    if (!session?.user?.id) {
      showError(5, 'Sign in to your customer account before paying and submitting your file.');
      return;
    }
    submitButton.disabled = true;
    status.textContent = 'Checking your customer session…';
    let token;
    try { token = await withTimeout(backend?.getAccessToken(), 12000, 'Your sign-in session check timed out. Retry or sign in again.'); }
    catch (error) {
      submitButton.disabled = false;
      status.textContent = 'Checkout could not be started. Your file was not submitted.';
      showError(5, error.message);
      return;
    }
    if (!session?.user?.id || !token) {
      submitButton.disabled = false;
      status.textContent = 'Checkout could not be started. Your file was not submitted.';
      showError(5, 'Sign in to your customer account before paying and submitting your file.');
      return;
    }
    if (!Number.isSafeInteger(fileVerificationPricePaise) || fileVerificationPricePaise < 1 || !paymentReady) {
      submitButton.disabled = false;
      status.textContent = 'Checkout could not be started. Your file was not submitted.';
      showError(5, 'The secure payment service or verification fee is not ready. Reload the current fee and retry. Your file was not submitted.');
      return;
    }
    checkoutStarting = true;
    clearError(5);
    status.textContent = 'Loading secure Razorpay Checkout…';
    let checkoutStage = 'checkout-sdk';
    try {
      const RazorpayCheckout = await loadRazorpayCheckout();
      const file = fileInput.files[0];
      if (!file) throw new Error('Select your original file before starting checkout.');
      const requestData = getPaymentRequestData(file);
      checkoutStage = 'file-hash';
      status.textContent = 'Preparing your secure file request…';
      requestData.originalSha256 = await withTimeout(hashFile(file), 20000, 'Preparing the original file took too long. Try a smaller file or retry.');
      checkoutStage = 'create-order';
      console.info('[payment] create-order request started');
      status.textContent = 'Requesting the ₹99 Test Mode order…';
      const { response, result } = await fetchJsonWithTimeout('/api/payment/create-order', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ request: requestData })
      }, 40000, 'The payment server did not respond within 40 seconds. No file was submitted; please retry.');
      console.info('[payment] create-order response', { httpStatus: response.status, orderIdReceived: Boolean(result?.razorpayOrderId), amount: result?.amount, currency: result?.currency });
      if (!response.ok) throw new Error(result.error || `Secure checkout request failed (HTTP ${response.status}).`);
      if (!/^order_[A-Za-z0-9]+$/.test(String(result.razorpayOrderId || ''))) throw new Error('The payment server did not return a valid Razorpay order reference. Your file was not submitted.');
      if (!/^rzp_test_[A-Za-z0-9]+$/.test(String(result.keyId || ''))) throw new Error('The server did not return a Razorpay Test Mode key. Checkout was stopped safely.');
      if (result.amount !== fileVerificationPricePaise || result.currency !== 'INR') {
        fileVerificationPricePaise = result.amount;
        const latestFee = formatINR(result.amount);
        verificationPriceLabel.textContent = latestFee;
        document.querySelectorAll('[data-fee-inline]').forEach(label => { label.textContent = latestFee; });
        updateSummary();
        throw new Error('The verification fee changed. Please review the updated amount and submit again.');
      }
      checkoutStage = 'checkout-constructor';
      const checkout = new RazorpayCheckout({
        key: result.keyId, amount: result.amount, currency: result.currency, order_id: result.razorpayOrderId,
        name: result.businessName, description: 'File Verification & Support Fee',
        prefill: { name: requestData.contactName, email: requestData.contactEmail || undefined, contact: requestData.contactPhone },
        theme: { color: '#829738' },
        modal: { ondismiss: () => { checkoutStarting = false; submitButton.disabled = false; status.textContent = 'Checkout was closed. No file was submitted.'; } },
        handler: async paymentResult => {
          checkoutStarting = false;
          capturedPayment = { ...paymentResult, requestData };
          await finishVerifiedPayment(capturedPayment);
        }
      });
      checkout.on('payment.failed', failure => {
        checkoutStarting = false;
        submitButton.disabled = false;
        status.textContent = 'Payment was not completed. Your file was not submitted.';
        showError(5, failure?.error?.description || 'Payment was not completed. Your file was not submitted.');
      });
      if (typeof checkout.open !== 'function') throw new Error('Razorpay Checkout was created but could not open. Reload the page and retry.');
      console.info('[payment] checkout instance created');
      checkoutStage = 'checkout-open';
      status.textContent = 'Opening secure Razorpay Checkout…';
      checkout.open();
      console.info('[payment] checkout.open() invoked');
      const opened = await waitForRazorpayFrame(8000);
      if (!opened) {
        try { checkout.close(); } catch {}
        throw new Error('Razorpay Checkout did not finish loading. A browser content blocker or network filter may be blocking checkout. Your file was not submitted; close any blank checkout panel and retry in a browser that allows checkout.');
      }
      checkoutStarting = false;
      status.textContent = 'Secure Razorpay Checkout is open. Complete payment or close the checkout to cancel.';
    } catch (error) {
      checkoutStarting = false;
      submitButton.disabled = false;
      status.textContent = 'Checkout could not be started. Your file was not submitted.';
      showError(5, error.message || 'Checkout failed unexpectedly. Your file was not submitted; please retry.');
      console.error('[payment] checkout initialization failed', { stage: checkoutStage, errorType: error.name || 'Error' });
    }
  });

  function waitForRazorpayFrame(timeoutMs) {
    return new Promise(resolve => {
      const started = Date.now();
      const poll = () => {
        const frame = [...document.querySelectorAll('iframe')].some(item => {
          if (!/razorpay/i.test(`${item.id} ${item.name} ${item.src}`)) return false;
          let frameUrl;
          try { frameUrl = new URL(item.src, window.location.href); } catch { return false; }
          // Checkout inserts a visible about:blank frame before its hosted UI
          // is ready. Do not report success until the iframe has navigated to
          // Razorpay's HTTPS checkout origin.
          if (frameUrl.protocol !== 'https:' || !['api.razorpay.com', 'checkout.razorpay.com'].includes(frameUrl.hostname)) return false;
          const rect = item.getBoundingClientRect();
          const style = getComputedStyle(item);
          return rect.width > 100 && rect.height > 100 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
        });
        if (frame) return resolve(true);
        if (Date.now() - started >= timeoutMs) return resolve(false);
        setTimeout(poll, 100);
      };
      poll();
    });
  }

  document.querySelectorAll('input[name="category"]').forEach(radio => radio.addEventListener('change', () => {
    document.querySelectorAll('.choice-card').forEach(card => card.classList.toggle('selected', card.contains(radio) && radio.checked));
    updateSummary();
  }));
  form.addEventListener('input', updateSummary);
  form.addEventListener('change', updateSummary);

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    document.querySelector('.file-selected').textContent = file ? `Selected: ${file.name} (${formatSize(file.size)})` : '';
    updateSummary(); clearError(4);
  });
  const uploadArea = document.querySelector('.upload-area');
  uploadArea.addEventListener('dragover', event => { event.preventDefault(); uploadArea.classList.add('dragging'); });
  ['dragleave', 'drop'].forEach(name => uploadArea.addEventListener(name, () => uploadArea.classList.remove('dragging')));
  uploadArea.addEventListener('drop', event => {
    event.preventDefault();
    if (event.dataTransfer.files.length) { fileInput.files = event.dataTransfer.files; fileInput.dispatchEvent(new Event('change', { bubbles: true })); }
  });

  document.querySelectorAll('[data-category-link]').forEach(link => link.addEventListener('click', () => {
    const radio = form.querySelector(`input[name="category"][value="${link.dataset.categoryLink}"]`);
    if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
  }));

  function allBrands() { return brandGroups.flatMap(([group, brands]) => brands.map(name => ({ group, name }))); }
  const brands = allBrands();
  function closeBrandResults() { brandResults.classList.remove('open'); brandInput.setAttribute('aria-expanded', 'false'); activeBrandOption = -1; }
  function renderBrands(query = '') {
    const normalized = query.trim().toLocaleLowerCase();
    const other = brands.find(item => item.name === 'Other / Not Listed');
    const matches = brands.filter(item => item.name !== 'Other / Not Listed' && (!normalized || item.name.toLocaleLowerCase().includes(normalized) || item.group.toLocaleLowerCase().includes(normalized)));
    if (!normalized || 'other / not listed'.includes(normalized)) matches.push(other);
    const byGroup = new Map();
    matches.forEach(item => { if (!byGroup.has(item.group)) byGroup.set(item.group, []); byGroup.get(item.group).push(item); });
    brandResults.innerHTML = [...byGroup.entries()].map(([group, items]) => `<div class="brand-group-label">${escapeHtml(group)}</div>${items.map(item => `<button class="brand-option" type="button" role="option" data-brand="${escapeHtml(item.name)}">${escapeHtml(item.name)}</button>`).join('')}`).join('') || '<div class="brand-no-results">No matching brand. You can enter it as text.</div>';
    brandResults.querySelectorAll('.brand-option').forEach(option => option.addEventListener('click', () => {
      brandInput.value = option.dataset.brand; closeBrandResults(); updateSummary(); clearError(1); brandInput.focus();
    }));
    brandResults.classList.add('open'); brandInput.setAttribute('aria-expanded', 'true'); activeBrandOption = -1;
  }
  brandInput.addEventListener('focus', () => renderBrands(brandInput.value));
  brandInput.addEventListener('input', () => { renderBrands(brandInput.value); updateSummary(); });
  brandInput.addEventListener('keydown', event => {
    const options = [...brandResults.querySelectorAll('.brand-option')];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); activeBrandOption = (activeBrandOption + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options.forEach((option, i) => option.classList.toggle('keyboard-active', i === activeBrandOption)); options[activeBrandOption]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && activeBrandOption >= 0) { event.preventDefault(); options[activeBrandOption]?.click(); }
    else if (event.key === 'Escape') closeBrandResults();
  });
  document.addEventListener('click', event => { if (!event.target.closest('.brand-search-wrap')) closeBrandResults(); });

  function updateSummary() {
    const data = new FormData(form);
    const category = data.get('category') || 'ECU';
    document.querySelector('.sum-category').textContent = category;
    document.querySelector('.review-category').textContent = category;
    document.querySelector('.summary-symbol').textContent = category === 'AIRBAG' ? '◈' : category === 'DASHBOARD' ? '▤' : '▦';
    const vehicle = [data.get('year'), data.get('brand'), data.get('vehicleType'), data.get('vehicleModel')].filter(Boolean).join(' · ');
    const module = [data.get('ecuManufacturer'), data.get('ecuModel')].filter(Boolean).join(' · ') || 'Not specified';
    const serviceList = data.getAll('service').join(', ') || 'Not selected';
    const file = fileInput.files[0]?.name || 'No file attached';
    const contact = [data.get('name'), data.get('phone'), data.get('email')].filter(Boolean).join(' · ') || 'Add contact details';
    const verificationText = fileVerificationPricePaise !== null ? formatINR(fileVerificationPricePaise) : 'Price unavailable';
    document.querySelector('.sum-vehicle').textContent = vehicle || 'Add vehicle details';
    document.querySelector('.sum-module').textContent = module;
    document.querySelector('.sum-services').innerHTML = data.getAll('service').length ? data.getAll('service').map(service => `<span>${escapeHtml(service)}</span>`).join('') : '<span class="sum-empty">Choose services to see them here</span>';
    document.querySelector('.sum-file').textContent = file;
    document.querySelector('.sum-verification').textContent = verificationText;
    document.querySelector('.review-vehicle').textContent = vehicle || 'Add vehicle details';
    document.querySelector('.review-module').textContent = module;
    document.querySelector('.review-tool').textContent = data.get('readingTool') || 'Not specified';
    document.querySelector('.review-services').textContent = serviceList;
    document.querySelector('.review-verification').textContent = verificationText;
    document.querySelector('.review-file').textContent = file;
    document.querySelector('.review-contact').textContent = contact;
  }

  function updateWhatsAppLink() {
    const data = new FormData(form);
    const lines = ['*ECU FILE SERVICE INDIA — File Service Request*', '',
      `*System:* ${data.get('category') || '—'}`,
      `*Vehicle:* ${[data.get('year'), data.get('brand'), data.get('vehicleType'), data.get('vehicleModel')].filter(Boolean).join(' · ') || '—'}`,
      `*ECU / module:* ${[data.get('ecuManufacturer'), data.get('ecuModel')].filter(Boolean).join(' · ') || 'Not specified'}`,
      `*Reading tool:* ${data.get('readingTool') || 'Not specified'}`,
      `*Services:* ${data.getAll('service').join(', ') || '—'}`,
      `*File Verification & Support Fee:* ${fileVerificationPricePaise !== null ? `${formatINR(fileVerificationPricePaise)} required` : 'Price unavailable'}`,
      `*Notes:* ${data.get('notes') || '—'}`,
      `*Name:* ${data.get('name') || '—'}`,
      `*Phone:* ${data.get('phone') || '—'}`,
      `*Email:* ${data.get('email') || '—'}`,
      `*Original file:* ${fileInput.files[0]?.name || 'I will attach it in this chat'}`,
      ...(savedOrderId ? [`*Order reference:* ${savedOrderId}`] : []),
      '', `Payment for the verification fee has been confirmed. Please use order reference ${savedOrderId || '—'} and advise the expected turnaround.`];
    document.querySelector('.whatsapp-submit').href = `https://wa.me/918300409707?text=${encodeURIComponent(lines.join('\n'))}`;
  }

  function getPaymentRequestData(file) {
    const data = new FormData(form);
    return {
      category: data.get('category'), vehicleBrand: String(data.get('brand') || '').trim(),
      vehicleType: data.get('vehicleType'), vehicleModel: String(data.get('vehicleModel') || '').trim(),
      vehicleYear: data.get('year') || '', ecuManufacturer: data.get('ecuManufacturer') || '',
      ecuModel: data.get('ecuModel') || '', readingTool: data.get('readingTool') || '',
      selectedServices: data.getAll('service'), notes: data.get('notes') || '',
      contactName: String(data.get('name') || '').trim(), contactPhone: String(data.get('phone') || '').trim(),
      contactEmail: data.get('email') || '', originalName: file.name,
      originalMime: file.type || 'application/octet-stream', originalSize: file.size, originalSha256: ''
    };
  }

  async function hashFile(file) {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function fileToBase64(file) {
    return file.arrayBuffer().then(buffer => {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let start = 0; start < bytes.length; start += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(start, Math.min(start + 0x8000, bytes.length)));
      }
      return btoa(binary);
    });
  }

  async function finishVerifiedPayment(payment) {
    const button = document.querySelector('.verification-submit');
    const status = document.querySelector('.verification-status');
    button.disabled = true;
    status.textContent = 'Confirming payment securely and submitting your file…';
    try {
      const backend = window.EfsiSupabase;
      const token = await withTimeout(backend?.getAccessToken(), 12000, 'Your customer session check timed out. Sign in again and retry securely.');
      if (!token) throw new Error('Your customer session expired. Sign in again to finish submitting the paid request.');
      const file = fileInput.files[0];
      if (!file) throw new Error('The selected original file is missing. Re-select it before retrying.');
      const { response, result } = await fetchJsonWithTimeout('/api/payment/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          razorpay_payment_id: payment.razorpay_payment_id,
          razorpay_order_id: payment.razorpay_order_id,
          razorpay_signature: payment.razorpay_signature,
          request: payment.requestData,
          fileBase64: await fileToBase64(file)
        })
      }, 90000, 'Payment verification is taking longer than expected. Your file is not marked submitted; keep this page open and retry securely.');
      if (!response.ok || result.status !== 'PAID' || !result.orderId) throw new Error(result.error || 'Payment could not be verified. Your file was not submitted.');
      savedOrderId = result.orderId;
      capturedPayment = null;
      status.textContent = 'Payment verified. Your original file is securely stored and your order is available to our service team.';
      document.querySelector('.success-state > p').textContent = `Payment verified successfully. Your File Verification & Support Fee is ${formatINR(fileVerificationPricePaise)}. Order ${savedOrderId} and your original file are now securely available to our service team.`;
      document.querySelector('.paid-order-reference').textContent = `Order reference: ${savedOrderId}`;
      setPage(6);
    } catch (error) {
      button.disabled = false;
      status.textContent = 'Your request is not submitted yet. Keep this page open and use Confirm My Request again to retry securely.';
      showError(5, error.message);
    }
  }
  function formatSize(bytes) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }

  const menuToggle = document.querySelector('.menu-toggle');
  const nav = document.querySelector('.desktop-nav');
  menuToggle.addEventListener('click', () => { const isOpen = nav.classList.toggle('open'); menuToggle.setAttribute('aria-expanded', String(isOpen)); });
  nav.querySelectorAll('a').forEach(link => link.addEventListener('click', () => { nav.classList.remove('open'); menuToggle.setAttribute('aria-expanded', 'false'); }));
  document.querySelector('.start-over').addEventListener('click', () => { form.reset(); savedOrderId = null; capturedPayment = null; document.querySelectorAll('input[name="category"]').forEach(radio => { if (radio.value === 'ECU') radio.checked = true; }); document.querySelectorAll('.choice-card').forEach((card, i) => card.classList.toggle('selected', i === 0)); document.querySelector('.file-selected').textContent = ''; document.querySelector('.paid-order-reference').textContent = ''; document.querySelector('.success-state > p').textContent = 'Your verified order and original file are now securely available to our service team.'; setPage(0); updateSummary(); });
  loadPricing();
  updateSummary();
})();
