(() => {
  const form = document.querySelector('#order-form');
  if (!form) return;
  const pages = [...document.querySelectorAll('.form-page')];
  const progress = [...document.querySelectorAll('.progress-step')];
  const fileInput = document.querySelector('#original-file');
  const verificationPriceLabel = document.querySelector('#verification-price');
  const brandInput = document.querySelector('#brand');
  const brandResults = document.querySelector('#brand-results');
  const maxFileSize = 50 * 1024 * 1024;
  const brands = ['Ather','Bajaj','BYD','Citroën','Daewoo','Datsun','Eicher','Force Motors','Honda','Hyundai','Isuzu','JCB','Jeep','Kia','Kubota','Land Rover','Mahindra','Mahindra Truck and Bus','Mahindra Tractors','Maruti Suzuki','Mercedes-Benz','MG Motor','Mitsubishi','Nissan','OLA Electric','Piaggio Commercial Vehicles','Porsche','Renault','Royal Enfield','Scania Industrial','Skoda','SML Isuzu','Sonalika','Suzuki','Tata Motors','Tata Motors Commercial Vehicles','TAFE','Toyota','TVS','Volkswagen','Volvo Construction Equipment','VST Tillers Tractors','Yanmar','Other / Not Listed'];
  let currentPage = 0;
  let activeBrandOption = -1;
  let fileVerificationPricePaise = null;
  let paymentReady = false;
  let providerReadiness = { razorpay: false, paypal: false };
  let checkoutStarting = false;
  let activeIntent = null;
  let activeProvider = null;
  let razorpayScriptPromise = null;
  let fileStagedInStorage = false;
  let originalFileSha256 = '';

  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
  function formatINR(paise) { return new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', minimumFractionDigits:0, maximumFractionDigits:2 }).format(paise / 100); }
  function setError(index, text) { const box = pages[index]?.querySelector('.form-error'); if (box) { box.textContent = text; box.classList.toggle('visible', Boolean(text)); } }
  function clearError(index) { setError(index, ''); }
  function setPage(index) { clearError(index); currentPage = index; pages.forEach((page,i)=>page.classList.toggle('active', i===index)); progress.forEach((step,i)=>step.classList.toggle('active', i<=Math.min(index,progress.length-1))); document.querySelector('.order-form')?.scrollIntoView({behavior:'smooth',block:'start'}); updateSummary(); }

  function normalizeFormData({ includeFile = true } = {}) {
    const data = new FormData(form);
    const category = String(data.get('category') || 'ECU');
    const isEcu = category === 'ECU';
    return {
      category,
      vehicleBrand: String(data.get('brand') || '').trim(), vehicleType: String(data.get('vehicleType') || '').trim(), vehicleModel: String(data.get('vehicleModel') || '').trim(), vehicleYear: String(data.get('year') || '').trim(),
      ecuManufacturer: isEcu ? String(data.get('ecuManufacturer') || '').trim() : '', ecuModel: isEcu ? String(data.get('ecuModel') || '').trim() : '', readingTool: isEcu ? String(data.get('readingTool') || '').trim() : '',
      selectedServices: data.getAll('service'), notes: String(data.get('notes') || '').trim(), contactName: String(data.get('name') || '').trim(), contactPhone: String(data.get('phone') || '').trim(), contactEmail: String(data.get('email') || '').trim()
    };
  }

  function validatePage(index) {
    clearError(index);
    const values = normalizeFormData({ includeFile: false });
    if (index === 1) {
      const year = values.vehicleYear;
      if (!values.vehicleBrand || !values.vehicleType || !values.vehicleModel) { setError(index, 'Brand, vehicle type and model are required.'); return false; }
      if (values.category !== 'ECU' && !year) { setError(index, 'Year is required for Airbag and Dashboard requests.'); return false; }
      if (year && (!/^\d{4}$/.test(year) || Number(year)<1950 || Number(year)>2100)) { setError(index, 'Enter a valid vehicle year.'); return false; }
    }
    if (index === 2 && values.category === 'ECU') { /* optional ECU details */ }
    if (index === 3 && !values.selectedServices.length) { setError(index, 'Select at least one file service.'); return false; }
    if (index === 4) {
      if (!fileInput.files[0] && !fileStagedInStorage) { setError(index, 'Select your original file before continuing.'); return false; }
      if (fileInput.files[0] && fileInput.files[0].size > maxFileSize) { setError(index, 'The original file must be 50 MB or smaller.'); return false; }
      if (!values.contactName || !values.contactPhone) { setError(index, 'Your name and phone are required.'); return false; }
          }
    if (index === 5) {
      if (!values.vehicleBrand || !values.vehicleType || !values.vehicleModel || !values.selectedServices.length) { setError(index, 'Complete the required request details before payment.'); return false; }
      if (!values.contactName || !values.contactPhone) { setError(index, 'Your name and phone are required before payment.'); return false; }
      if (values.category !== 'ECU' && !values.vehicleYear) { setError(index, 'Year is required for this category.'); return false; }
    }
    return true;
  }

  function applyCategoryFields() {
    const category = String(new FormData(form).get('category') || 'ECU');
    const ecu = category === 'ECU';
    document.querySelectorAll('.ecu-only').forEach(el => { el.hidden = !ecu; el.querySelectorAll('input,select,textarea').forEach(control => { control.disabled = !ecu; if (!ecu) control.value = ''; }); });
    const tool = document.querySelector('.tool-field');
    if (tool) { tool.hidden = !ecu; const select = tool.querySelector('select'); if (select) { select.disabled = !ecu; if (!ecu) select.value = ''; } }
    const thirdStep = document.querySelector('[data-page="2"]');
    if (thirdStep) { const kicker = thirdStep.querySelector('.form-kicker'); const title = thirdStep.querySelector('h3'); const intro = thirdStep.querySelector('.form-title p'); if (kicker && title && intro) { if (ecu) { kicker.textContent='STEP 03 OF 06'; title.textContent='Select ECU / module'; intro.textContent='Add the controller details and the tool used to read the file.'; } else { kicker.textContent='STEP 03 OF 06'; title.textContent='Confirm module'; intro.textContent='For this service category, only the selected vehicle/module details are collected.'; } } }
    document.querySelector('.sum-module').textContent = ecu ? ([new FormData(form).get('ecuManufacturer'),new FormData(form).get('ecuModel')].filter(Boolean).join(' · ') || 'Not specified') : 'Not applicable';
  }

  function updateSummary() {
    applyCategoryFields();
    const data = normalizeFormData({ includeFile:false });
    const vehicle = [data.vehicleYear,data.vehicleBrand,data.vehicleType,data.vehicleModel].filter(Boolean).join(' · ');
    const module = data.category === 'ECU' ? ([data.ecuManufacturer,data.ecuModel].filter(Boolean).join(' · ') || 'Not specified') : 'Not applicable';
    document.querySelector('.sum-category').textContent = data.category;
    document.querySelector('.review-category').textContent = data.category;
    document.querySelector('.summary-symbol').textContent = data.category === 'AIRBAG' ? '◈' : data.category === 'DASHBOARD' ? '▤' : '▦';
    document.querySelector('.sum-vehicle').textContent = vehicle || 'Add vehicle details';
    document.querySelector('.sum-module').textContent = module;
    document.querySelector('.sum-services').innerHTML = data.selectedServices.length ? data.selectedServices.map(s=>`<span>${escapeHtml(s)}</span>`).join('') : '<span class="sum-empty">Choose services to see them here</span>';
    document.querySelector('.sum-file').textContent = fileInput.files[0]?.name || (fileStagedInStorage ? 'Private file already staged' : 'No file attached');
    const fee = fileVerificationPricePaise === null ? 'Price unavailable' : formatINR(fileVerificationPricePaise);
    document.querySelector('.sum-verification').textContent = fee;
    document.querySelector('.review-vehicle').textContent = vehicle || 'Add vehicle details';
    document.querySelector('.review-module').textContent = module;
    document.querySelector('.review-tool').textContent = data.category === 'ECU' ? (data.readingTool || 'Not specified') : 'N/A';
    document.querySelector('.review-services').textContent = data.selectedServices.join(', ') || 'Not selected';
    document.querySelector('.review-verification').textContent = fee;
    document.querySelector('.review-file').textContent = fileInput.files[0]?.name || (fileStagedInStorage ? 'Private file already staged' : 'No file attached');
    document.querySelector('.review-contact').textContent = [data.contactName,data.contactPhone,data.contactEmail].filter(Boolean).join(' · ') || 'Add contact details';
    const stagedNote = document.querySelector('.staged-file-note'); if (stagedNote) stagedNote.hidden = !fileStagedInStorage;
    updatePaymentButtons();
  }

  function renderBrands(query='') {
    const needle = query.trim().toLowerCase();
    const matches = brands.filter(brand => !needle || brand.toLowerCase().includes(needle)).slice(0,20);
    brandResults.innerHTML = matches.map((brand,index)=>`<button type="button" class="brand-option" role="option" data-brand="${escapeHtml(brand)}" aria-selected="false">${escapeHtml(brand)}</button>`).join('');
    brandResults.classList.toggle('open', matches.length>0 && document.activeElement===brandInput);
    activeBrandOption = -1;
  }
  function closeBrandResults(){ brandResults.classList.remove('open'); brandInput.setAttribute('aria-expanded','false'); }
  brandInput.addEventListener('input',()=>{renderBrands(brandInput.value);brandInput.setAttribute('aria-expanded','true');});
  brandInput.addEventListener('focus',()=>{renderBrands(brandInput.value);brandInput.setAttribute('aria-expanded','true');});
  brandInput.addEventListener('keydown',event=>{const options=[...brandResults.querySelectorAll('.brand-option')]; if (!options.length) return; if (event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();activeBrandOption=(activeBrandOption+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;options.forEach((o,i)=>o.classList.toggle('keyboard-active',i===activeBrandOption));options[activeBrandOption]?.scrollIntoView({block:'nearest'});} else if(event.key==='Enter'&&activeBrandOption>=0){event.preventDefault();options[activeBrandOption].click();} else if(event.key==='Escape') closeBrandResults();});
  brandResults.addEventListener('click',event=>{const button=event.target.closest('.brand-option');if(!button)return;brandInput.value=button.dataset.brand;closeBrandResults();updateSummary();});
  document.addEventListener('click',event=>{if(!event.target.closest('.brand-search-wrap'))closeBrandResults();});
  document.querySelectorAll('input[name="category"]').forEach(radio=>radio.addEventListener('change',()=>{document.querySelectorAll('.choice-card').forEach(card=>card.classList.toggle('selected',card.querySelector('input')?.checked));fileStagedInStorage=false;activeIntent=null;updateSummary();}));
  document.querySelectorAll('input[name="service"],#vehicle-type,#vehicle-model,#vehicle-year,#ecu-maker,#ecu-model,#reading-tool,#customer-name,#customer-phone,#customer-email,#request-notes').forEach(el=>el.addEventListener('input',updateSummary));
  document.querySelector('#original-file').addEventListener('change',()=>{fileStagedInStorage=false;activeIntent=null;originalFileSha256=''; const label=document.querySelector('.file-selected'); if(label) label.textContent=fileInput.files[0] ? `${fileInput.files[0].name} · ${formatSize(fileInput.files[0].size)}` : ''; updateSummary();});
  function formatSize(bytes){return bytes<1024*1024?`${Math.max(1,Math.round(bytes/1024))} KB`:`${(bytes/(1024*1024)).toFixed(1)} MB`;}

  function loadRazorpayCheckout(timeoutMs=12000){
    if (typeof window.Razorpay === 'function') return Promise.resolve(window.Razorpay);
    if (razorpayScriptPromise) return razorpayScriptPromise;
    razorpayScriptPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');let done=false;const finish=error=>{if(done)return;done=true;clearTimeout(timer);if(error)reject(error);else if(typeof window.Razorpay==='function')resolve(window.Razorpay);else reject(new Error('Razorpay Checkout did not load.'));};const timer=setTimeout(()=>finish(new Error('Razorpay Checkout did not load in time.')),timeoutMs);script.src='https://checkout.razorpay.com/v1/checkout.js';script.async=true;script.onload=()=>finish();script.onerror=()=>finish(new Error('Razorpay Checkout could not load.'));document.head.appendChild(script);}).catch(error=>{razorpayScriptPromise=null;throw error;});
    return razorpayScriptPromise;
  }
  async function hashFile(file){const buffer=await file.arrayBuffer();const digest=await crypto.subtle.digest('SHA-256',buffer);return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');}
  async function fetchJson(url,options={},timeoutMs=30000){const response=await fetch(url,{...options,signal:AbortSignal.timeout(timeoutMs)});let result=null;try{result=await response.json();}catch{}return {response,result};}
  function requestDataFromForm(file){const data=normalizeFormData({includeFile:false});return {...data,originalName:file?.name || String(activeIntent?.original_name || ''),originalMime:file?.type || String(activeIntent?.original_mime || 'application/octet-stream'),originalSize:file?.size || Number(activeIntent?.original_size || 0),originalSha256:originalFileSha256 || String(activeIntent?.original_sha256 || '')};}

  async function ensureCheckoutIntent() {
    if (activeIntent?.id && fileStagedInStorage && (activeIntent.status==='FILE_STAGED'||activeIntent.status==='PAYMENT_PENDING')) {
      const current = requestDataFromForm(null);
      const saved = activeIntent.request_json || {};
      const same = JSON.stringify(current) === JSON.stringify(saved);
      if (same) return activeIntent;
      activeIntent = null; fileStagedInStorage = false; originalFileSha256 = ''; updateSummary();
    }
    const file=fileInput.files[0];
    if (!file) throw new Error('Select your original file before starting checkout.');
    if (file.size>maxFileSize) throw new Error('The original file must be 50 MB or smaller.');
    const backend=window.EfsiSupabase; if(!backend?.getSession()?.user?.id) throw new Error('Sign in to your customer account before payment.');
    const request=requestDataFromForm(file);
    if(!originalFileSha256) originalFileSha256=await hashFile(file);
    request.originalSha256=originalFileSha256;
    const token=await backend.getAccessToken(); if(!token) throw new Error('Your customer session expired. Sign in again.');
    const created=await fetchJson('/api/checkout/intents',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({request})},30000);
    if(!created.response.ok) throw new Error(created.result?.error||'Secure checkout could not be saved.');
    activeIntent={id:created.result.intentId,status:created.result.status,amount_paise:created.result.amount,currency:created.result.currency,storage_path:created.result.storagePath,expires_at:created.result.expiresAt,request_sha256:created.result.requestSha256,original_sha256:originalFileSha256,original_name:file.name,original_size:file.size,request_json:request};
    const encoded=activeIntent.storage_path.split('/').map(encodeURIComponent).join('/');
    await backend.upload(`private-ecu-files/${encoded}`,file);
    const staged=await fetchJson(`/api/checkout/intents/${encodeURIComponent(activeIntent.id)}/stage`,{method:'POST',headers:{Authorization:`Bearer ${token}`}},30000);
    if(!staged.response.ok) throw new Error(staged.result?.error||'Private file staging could not be confirmed.');
    activeIntent={...activeIntent,status:'FILE_STAGED'};fileStagedInStorage=true;updateSummary();return activeIntent;
  }

  async function startRazorpay(intent) {
    const backend=window.EfsiSupabase; const token=await backend.getAccessToken();
    const {response,result}=await fetchJson('/api/payment/create-order',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({intentId:intent.id})},40000);
    if(!response.ok) throw new Error(result?.error||'Razorpay checkout could not be created.');
    const RazorpayCheckout=await loadRazorpayCheckout();
    const checkout=new RazorpayCheckout({key:result.keyId,amount:result.amount,currency:result.currency,order_id:result.providerOrderId,name:'ECU FILE SERVICE INDIA',description:'File Verification & Support Fee',prefill:{name:intent.request_json.contactName,email:intent.request_json.contactEmail||undefined,contact:intent.request_json.contactPhone},modal:{ondismiss:()=>{checkoutStarting=false;document.querySelector('.verification-status').textContent='Checkout closed. Your saved checkout is still available in My account.';document.querySelector('.verification-submit').disabled=false;}},handler:async payment=>{await verifyRazorpay(intent.id,payment);}});
    activeProvider='razorpay';checkout.open();
  }
  async function verifyRazorpay(intentId,payment){const backend=window.EfsiSupabase;const token=await backend.getAccessToken();const {response,result}=await fetchJson('/api/payment/verify',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({intentId,razorpay_order_id:payment.razorpay_order_id,razorpay_payment_id:payment.razorpay_payment_id,razorpay_signature:payment.razorpay_signature})},90000);if(!response.ok)throw new Error(result?.error||'Payment verification failed.');if(result.status!=='PAID')throw new Error('Payment is not confirmed yet.');completeSuccess(result.orderId);}
  async function startPayPal(intent) {
    const backend=window.EfsiSupabase;const token=await backend.getAccessToken();const {response,result}=await fetchJson('/api/payment/paypal/create-order',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({intentId:intent.id})},40000);if(!response.ok)throw new Error(result?.error||'PayPal checkout could not be created.');if(!result.approvalUrl)throw new Error('PayPal did not return an approval link.');activeProvider='paypal';window.location.assign(result.approvalUrl);
  }
  async function resumePaypalReturn(){const query=new URLSearchParams(location.search);if(query.get('paypal_return')!=='1')return;const intentId=query.get('intent');const token=query.get('token');history.replaceState(null,document.title,location.pathname);if(!intentId||!token)return;const backend=window.EfsiSupabase;const session=backend?.getSession();if(!session?.user?.id){document.querySelector('.verification-status').textContent='Sign in to the account that started this PayPal checkout, then open My account to resume payment verification.';return;}try{document.querySelector('.verification-status').textContent='Confirming PayPal payment securely…';const access=await backend.getAccessToken();const {response,result}=await fetchJson('/api/payment/paypal/capture',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${access}`},body:JSON.stringify({intentId,paypalOrderId:token})},90000);if(!response.ok)throw new Error(result?.error||'PayPal payment could not be confirmed.');completeSuccess(result.orderId);}catch(error){document.querySelector('.verification-status').textContent=error.message;}}
  async function resumeFromIntent(intent){activeIntent=intent;const req=intent.request_json||{};for(const [name,id] of [['brand','brand'],['vehicleType','vehicle-type'],['vehicleModel','vehicle-model'],['year','vehicle-year'],['ecuManufacturer','ecu-maker'],['ecuModel','ecu-model'],['readingTool','reading-tool'],['notes','request-notes'],['name','customer-name'],['phone','customer-phone']]){const el=document.getElementById(id);if(el)el.value=req[name]||'';}document.querySelectorAll('input[name="category"]').forEach(r=>r.checked=r.value===req.category);document.querySelectorAll('.choice-card').forEach(card=>card.classList.toggle('selected',card.querySelector('input')?.checked));document.querySelectorAll('input[name="service"]').forEach(cb=>cb.checked=(req.selectedServices||[]).includes(cb.value));fileStagedInStorage=true;originalFileSha256=intent.original_sha256||'';setPage(5);document.querySelector('.verification-status').textContent='This checkout is saved securely. Choose a payment method to continue.';updateSummary();}
  function completeSuccess(orderId){activeIntent=null;fileStagedInStorage=false;document.querySelector('.verification-submit').disabled=true;document.querySelector('.verification-status').textContent='Payment verified and your order is now available in My account.';document.querySelector('.success-state > p').textContent='Payment verified successfully. Your order and private original file are now available to our service team.';document.querySelector('.paid-order-reference').textContent=`Order reference: ${orderId}`;setPage(6);}
  function updatePaymentButtons(){const razor=document.querySelector('#pay-razorpay');const paypal=document.querySelector('#pay-paypal');if(razor)razor.disabled=!providerReadiness.razorpay||checkoutStarting;if(paypal)paypal.disabled=!providerReadiness.paypal||checkoutStarting;}
  async function beginPayment(provider){if(checkoutStarting)return;if(!validatePage(5))return;if(!providerReadiness[provider]){setError(5,`${provider==='paypal'?'PayPal':'Razorpay'} is not configured yet.`);return;}const consent=form.querySelector('input[name=consent]');if(!consent?.checked){setError(5,'Please confirm you are authorised to request this service.');return;}const button=document.querySelector('.verification-submit');const status=document.querySelector('.verification-status');const backend=window.EfsiSupabase;if(!backend?.getSession()?.user?.id){setError(5,'Sign in to your customer account before payment.');return;}checkoutStarting=true;updatePaymentButtons();clearError(5);status.textContent='Saving your checkout and securely staging the original file…';try{const intent=await ensureCheckoutIntent();status.textContent=provider==='paypal'?'Opening secure PayPal approval…':'Opening secure Razorpay Checkout…';if(provider==='paypal')await startPayPal(intent);else await startRazorpay(intent);}catch(error){status.textContent=error.message||'Checkout could not be started.';setError(5,status.textContent);checkoutStarting=false;updatePaymentButtons();}}

  document.querySelectorAll('.next-button').forEach(button=>button.addEventListener('click',()=>{if(validatePage(currentPage))setPage(currentPage+1);}));
  document.querySelectorAll('.button-back').forEach(button=>button.addEventListener('click',()=>setPage(Math.max(0,currentPage-1))));
  document.querySelector('#pay-razorpay')?.addEventListener('click',()=>beginPayment('razorpay'));
  document.querySelector('#pay-paypal')?.addEventListener('click',()=>beginPayment('paypal'));
  document.querySelector('.start-over')?.addEventListener('click',()=>{form.reset();activeIntent=null;fileStagedInStorage=false;originalFileSha256='';document.querySelectorAll('input[name="category"]').forEach(r=>r.checked=r.value==='ECU');document.querySelectorAll('.choice-card').forEach((card,i)=>card.classList.toggle('selected',i===0));const fs=document.querySelector('.file-selected');if(fs)fs.textContent='';setPage(0);updateSummary();});
  window.addEventListener('efsi:resume-checkout',event=>resumeFromIntent(event.detail));
  fetch('/api/health',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(health=>{providerReadiness={razorpay:Boolean(health?.paymentReadiness?.razorpay),paypal:Boolean(health?.paymentReadiness?.paypal)};paymentReady=Boolean(health?.paymentConfigured);const status=document.querySelector('.verification-status');const gateways=document.querySelector('.payment-gateway-note');if(gateways)gateways.textContent=health?.paymentReadiness?.razorpay&&health?.paymentReadiness?.paypal?'Razorpay or PayPal secure checkout is available.':health?.paymentReadiness?.razorpay?'Razorpay secure checkout is available.':health?.paymentReadiness?.paypal?'PayPal secure checkout is available.':'Secure payment is not configured yet.';updatePaymentButtons();}).catch(()=>{paymentReady=false;updatePaymentButtons();});
  fetch('/api/pricing',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(pricing=>{if(!pricing)throw new Error('pricing');fileVerificationPricePaise=pricing.fileVerificationPricePaise;const fee=formatINR(fileVerificationPricePaise);verificationPriceLabel.textContent=fee;document.querySelectorAll('[data-fee-inline]').forEach(el=>el.textContent=fee);updateSummary();}).catch(()=>{verificationPriceLabel.textContent='Price unavailable';document.querySelector('.verification-status').dataset.error='true';document.querySelector('.verification-status').textContent='The verification fee could not be loaded. Reload and retry.';});
  updateSummary();
  resumePaypalReturn();
})();

