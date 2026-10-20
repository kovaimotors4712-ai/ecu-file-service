(function init() {
  const backend = window.EfsiSupabase;
  if (!backend) {
    setTimeout(init, 100);
    return;
  }
  const loginPanel = document.querySelector('#admin-login');
  const deniedPanel = document.querySelector('#admin-denied');
  const dashboard = document.querySelector('#admin-dashboard');
  const message = document.querySelector('#admin-auth-message');
  const pricingForm = document.querySelector('#pricing-form');
  const pricingInput = document.querySelector('#file-verification-price');
  const pricingMessage = document.querySelector('#pricing-message');
  const searchInput = document.querySelector('#order-search');
  const statusFilter = document.querySelector('#order-status-filter');
  const resultFilter = document.querySelector('#order-result-filter');
  const sortSelect = document.querySelector('#order-sort-order');

  let orders = [];
  let attachmentPreviewUrls = [];
  let photoPreviewObserver = null;
  let realtimeClient = null;
  let ordersChannel = null;

  function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, function(c) {
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c];
    });
  }
  function formatINR(paise) { return new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',minimumFractionDigits:0,maximumFractionDigits:2}).format(Number(paise||0)/100); }
  async function parseJson(response){const text=await response.text();try{return text?JSON.parse(text):{};}catch{return {error:text||('Server error ('+response.status+')')};}}
  async function configured(){const response=await fetch('/api/health',{cache:'no-store'});const result=await parseJson(response);return response.ok&&Boolean(result.configured);}
  function setSignedOut(){loginPanel.hidden=false;deniedPanel.hidden=true;dashboard.hidden=true;document.querySelector('#admin-signout').hidden=true;message.textContent='';unsubscribeRealtime();}
  function showDenied(text){loginPanel.hidden=true;deniedPanel.hidden=false;dashboard.hidden=true;document.querySelector('#admin-signout').hidden=true;document.querySelector('#admin-denied-message').textContent=text;unsubscribeRealtime();}

  function subscribeRealtime(){
    if(!window.supabase?.createClient||!backend.getSession()?.user?.id)return;
    if(!realtimeClient)realtimeClient=window.supabase.createClient(backend.supabaseUrl,backend.supabaseAnonKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    const token=backend.getSession()?.access_token;
    try{realtimeClient.realtime.setAuth(token);}catch{};
    unsubscribeRealtime();
    ordersChannel=realtimeClient.channel('admin-orders')
      .on('postgres_changes',{event:'*',schema:'public',table:'orders'},function(){loadOrders();})
      .on('postgres_changes',{event:'*',schema:'public',table:'order_files'},function(){loadOrders();})
      .on('postgres_changes',{event:'*',schema:'public',table:'order_attachments'},function(){loadOrders();})
      .subscribe();
  }
  function unsubscribeRealtime(){try{ordersChannel&&realtimeClient?.removeChannel(ordersChannel);}catch{}ordersChannel=null;}

  async function loadPricing(){
    try{
      const response=await fetch('/api/pricing',{cache:'no-store'});
      const pricing=await parseJson(response);
      if(!response.ok)throw new Error(pricing.error||'Pricing could not be loaded.');
      pricingInput.value=(Number(pricing.fileVerificationPricePaise)/100).toFixed(2);
      pricingInput.disabled=false;
      pricingForm.querySelector('button[type="submit"]').disabled=false;
      pricingMessage.textContent='Current fee: '+formatINR(pricing.fileVerificationPricePaise)+'.';
    }catch(error){
      pricingMessage.textContent=error.message;
      pricingMessage.classList.add('admin-error');
    }
  }

  pricingForm.addEventListener('submit',async function(event){
    event.preventDefault();
    const button=pricingForm.querySelector('button[type="submit"]');
    button.disabled=true;
    pricingMessage.classList.remove('admin-error');
    try{
      const price=Number(pricingInput.value);
      if(!Number.isFinite(price)||price<0||price>1000000)throw new Error('Enter a price from ₹0 to ₹1,000,000.');
      const token=await backend.getAccessToken();
      const response=await fetch('/api/pricing',{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({fileVerificationPricePaise:Math.round(price*100)})});
      const result=await parseJson(response);
      if(!response.ok)throw new Error(result.error||('Price could not be saved ('+response.status+').'));
      pricingMessage.textContent='Saved fee: '+formatINR(result.fileVerificationPricePaise)+'.';
    }catch(error){
      pricingMessage.textContent=error.message;
      pricingMessage.classList.add('admin-error');
    }finally{
      button.disabled=false;
    }
  });

  async function loadOrders(){
    const statusMessage=document.querySelector('#orders-message');
    statusMessage.textContent='Loading orders…';
    statusMessage.classList.remove('admin-error');
    try{
      orders=await backend.rest('orders?select=id,customer_id,status,category,vehicle_brand,vehicle_type,vehicle_model,vehicle_year,ecu_manufacturer,ecu_model,reading_tool,module_details,selected_services,notes,contact_name,contact_phone,contact_email,payment_status,payment_provider,provider_order_id,provider_payment_id,verification_amount_paise,second_stage_amount,second_stage_status,second_stage_paid_at,second_stage_payment_link,created_at,updated_at,order_files!order_files_order_id_fkey(id,kind,original_name,object_path,size_bytes,created_at),order_attachments!order_attachments_order_id_fkey(id,kind,original_name,object_path,mime_type,size_bytes,created_at)&order=created_at.desc&limit=500');
      if(!Array.isArray(orders))throw new Error('The orders response was not a list.');
      document.querySelector('#stat-total').textContent = orders.length;
      document.querySelector('#stat-payment-pending').textContent = orders.filter(function(o){return o.status==='Payment Pending'||o.payment_status==='PENDING';}).length;
      document.querySelector('#stat-paid-new').textContent = orders.filter(function(o){return o.status==='New';}).length;
      document.querySelector('#stat-processing').textContent = orders.filter(function(o){return ['File Review','Processing'].includes(o.status);}).length;
      document.querySelector('#stat-completed').textContent = orders.filter(function(o){return o.status==='Completed';}).length;
      document.querySelector('#stat-cancelled').textContent = orders.filter(function(o){return o.status==='Cancelled';}).length;

      document.querySelector('#stat-date-today').textContent = orders.filter(function(o){return new Date(o.created_at).toDateString()===new Date().toDateString();}).length;
      document.querySelector('#stat-date-7days').textContent = orders.filter(function(o){return (Date.now()-new Date(o.created_at).getTime())<=7*24*60*60*1000;}).length;
      document.querySelector('#stat-date-30days').textContent = orders.filter(function(o){return (Date.now()-new Date(o.created_at).getTime())<=30*24*60*60*1000;}).length;

      document.querySelector('#stat-result-ready').textContent = orders.filter(function(o){return (o.order_files||[]).some(function(f){return f.kind==='processed';});}).length;
      document.querySelector('#stat-result-pending').textContent = orders.filter(function(o){return !(o.order_files||[]).some(function(f){return f.kind==='processed';});}).length;

      const statAll = document.querySelector('#stat-all');
      if (statAll) statAll.textContent = orders.length;
      const statNew = document.querySelector('#stat-new');
      if (statNew) statNew.textContent = orders.filter(function(o){return o.status==='New';}).length;
      const statActive = document.querySelector('#stat-active');
      if (statActive) statActive.textContent = orders.filter(function(o){return ['File Review','Processing'].includes(o.status);}).length;
      renderOrders();
      statusMessage.textContent='';
    }catch(error){
      statusMessage.textContent=error.message;
      statusMessage.classList.add('admin-error');
    }
  }

  function renderOrders(){
    const list=document.querySelector('#order-list');
    const query=(searchInput?.value||'').toLowerCase().trim();
    const statusVal=statusFilter?.value||'all';
    const resultVal=resultFilter?.value||'all';
    const sortVal=sortSelect?.value||'newest';

    let filtered=orders.filter(function(order){
      const files=order.order_files||[];
      const hasProcessed=files.some(function(f){return f.kind==='processed';});

      if(query){
        const text=[
          order.id,
          order.contact_name,
          order.contact_phone,
          order.contact_email,
          order.vehicle_brand,
          order.vehicle_model,
          order.vehicle_type,
          order.category,
          (order.selected_services||[]).join(' ')
        ].join(' ').toLowerCase();
        if(!text.includes(query))return false;
      }

      if(statusVal!=='all'){
        if(statusVal==='New'){
          if(order.status!=='New')return false;
        }else if(order.status!==statusVal){
          return false;
        }
      }

      if(resultVal==='ready'){
        if(!hasProcessed)return false;
      }else if(resultVal==='pending'){
        if(hasProcessed)return false;
      }

      return true;
    });

    filtered.sort(function(a,b){
      const tA=new Date(a.created_at).getTime();
      const tB=new Date(b.created_at).getTime();
      return sortVal==='oldest'?(tA-tB):(tB-tA);
    });

    if(!filtered.length){
      list.innerHTML='<div class="admin-empty">No orders match the search and filter criteria.</div>';
      return;
    }

    const statuses=['New','File Review','Processing','Possible','Not Possible','Completed','Cancelled','Payment Pending'];

    list.innerHTML=filtered.map(function(order){
      const services=(order.selected_services||[]).join(', ');
      const files=order.order_files||[];
      const originalFile=files.find(function(f){return f.kind==='original';});
      const processedFile=files.find(function(f){return f.kind==='processed';});
      const module=order.category==='ECU'?[order.ecu_manufacturer,order.ecu_model].filter(Boolean).join(' · ')||'Not specified':order.category==='AIRBAG'?(order.module_details||'Not specified'):'Historical dashboard order';
      const attachments=Array.isArray(order.order_attachments)?order.order_attachments:[];
      const photoRows=attachments.map(function(att){const label=att.kind==='module_photo'?'AIRBAG MODULE PHOTO':'PART-NUMBER PHOTO';return '<div class="admin-airbag-attachment"><div class="admin-file-info"><span>'+label+'</span><b>'+escape(att.original_name)+' ('+Math.max(1,Math.round((att.size_bytes||0)/1024))+' KB)</b></div><img class="admin-airbag-photo" data-photo-path="'+escape(att.object_path)+'" alt="'+escape(label)+'" loading="lazy"><div class="admin-file-actions"><button class="button button-ghost" type="button" data-admin-download="true" data-object-path="'+escape(att.object_path)+'" data-file-name="'+escape(att.original_name)+'">Download Photo</button></div></div>';}).join('');
      const payment=[order.payment_status||'PENDING',order.payment_provider||'—'].join(' · ');
      const paymentRef=order.provider_payment_id||order.razorpay_payment_id||'—';

      return '<article class="admin-order" data-order-id="'+escape(order.id)+'">'+
        '<div class="admin-order-head">'+
          '<div>'+
            '<span class="admin-order-id">ORDER '+escape(order.id)+'</span>'+
            '<h2>'+escape(order.vehicle_year?(order.vehicle_year+' '):'')+escape(order.vehicle_brand)+' '+escape(order.vehicle_model)+'</h2>'+
            '<time>'+escape(new Date(order.created_at).toLocaleString())+'</time>'+
          '</div>'+
          '<span class="admin-status-badge">'+escape(order.status)+'</span>'+
        '</div>'+
        '<div class="admin-order-grid">'+
          '<div><small>CUSTOMER</small><b>'+escape(order.contact_name)+' · '+escape(order.contact_phone)+'<br>'+escape(order.contact_email||'')+'</b></div>'+
          '<div><small>SYSTEM / VEHICLE TYPE</small><b>'+escape(order.category)+' · '+escape(order.vehicle_type)+'</b></div>'+
          '<div><small>ECU / MODULE</small><b>'+escape(order.category==='AIRBAG'?'Airbag SRS module':module)+'</b></div>'+
          (order.category==='AIRBAG'&&order.module_details?'<div style="grid-column:1/-1"><small>AIRBAG MODULE DETAILS</small><b>'+escape(order.module_details)+'</b></div>':'')+
          '<div><small>READING TOOL</small><b>'+escape(order.category==='ECU'?(order.reading_tool||'Not specified'):'Not applicable')+'</b></div>'+
          '<div><small>FILE SERVICES</small><b>'+escape(services)+'</b></div>'+
          '<div><small>FILE VERIFICATION FEE</small><b>'+(order.verification_amount_paise!=null?escape(formatINR(order.verification_amount_paise)):'—')+'</b></div>'+
          '<div><small>PAYMENT STATUS</small><b>'+escape(payment)+'<br><span style="font-family:var(--mono);font-size:9px;color:#7f8a84">Ref: '+escape(paymentRef)+'</span></b></div>'+
          '<div><small>RESULT AVAILABILITY</small><b>'+(processedFile?'<span style="color:#586b24">Processed Result Ready</span>':'<span style="color:#a87a2a">Result Pending</span>')+'</b></div>'+
          (order.status==='Possible' ? ('<div class="admin-second-stage-wrap" style="grid-column:1/-1;border-top:1px solid #e3e8df;margin-top:8px;padding-top:8px"><small style="display:block;font:800 8px var(--mono);color:#7d8983;letter-spacing:0.1em;margin-bottom:3px">SECOND-STAGE PAYMENT</small><div style="display:flex;gap:8px;align-items:center"><input type="number" id="stage-amount-'+escape(order.id)+'" value="'+(order.second_stage_amount?Math.round(order.second_stage_amount/100):'')+'" placeholder="Amount (₹ rupees)" style="padding:4px;width:120px;font-size:11px"><button class="button button-dark" type="button" onclick="window.handleAdminSetSecondStage(\''+escape(order.id)+'\')">Create Payment Link</button>'+(order.second_stage_status==='paid'?'<span style="color:#586b24;font-size:11px;margin-left:8px">✓ Paid</span><button class="button button-ghost" style="font-size:9px;padding:2px 5px;margin-left:8px" type="button" onclick="window.handleAdminMarkSecondStageUnpaid(\''+escape(order.id)+'\')">Unmark</button>':'<button class="button button-ghost" type="button" onclick="window.handleAdminMarkSecondStagePaid(\''+escape(order.id)+'\')">Mark Paid</button>')+'</div></div>') : '')+
        '</div>'+
        (order.notes?('<div style="margin-bottom:14px;padding:10px 14px;background:#f9fbf7;border:1px solid #e8ede3;font-size:11px"><small style="display:block;font:800 8px var(--mono);color:#7d8983;letter-spacing:0.1em;margin-bottom:3px">CUSTOMER NOTES</small>'+escape(order.notes)+'</div>'):'')+
        '<div class="admin-files-box">'+
          (photoRows?'<div class="admin-airbag-photos"><small style="display:block;font:800 9px var(--mono);letter-spacing:.1em;color:#7f8a84;margin-bottom:10px">CUSTOMER AIRBAG PHOTOS</small>'+photoRows+'</div>':'')+
          (originalFile?('<div class="admin-file-row"><div class="admin-file-info"><span>ORIGINAL FILE</span><b>'+escape(originalFile.original_name)+' ('+Math.round((originalFile.size_bytes||0)/1024)+' KB)</b></div><div class="admin-file-actions"><button class="button button-ghost" type="button" data-admin-download="true" data-object-path="'+escape(originalFile.object_path)+'" data-file-name="'+escape(originalFile.original_name)+'">Download Original</button></div></div>'):'<div style="font-size:11px;color:#7f8a84">Original file record missing.</div>')+
          (processedFile?('<div class="admin-file-row" style="background:#f4f8ec"><div class="admin-file-info"><span>PROCESSED RESULT</span><b>'+escape(processedFile.original_name)+' ('+Math.round((processedFile.size_bytes||0)/1024)+' KB)</b></div><div class="admin-file-actions"><button class="button button-ghost" type="button" data-admin-download="true" data-object-path="'+escape(processedFile.object_path)+'" data-file-name="'+escape(processedFile.original_name)+'">Download Result</button></div></div>'):'<div style="font-size:11px;color:#a87a2a">Processed result not uploaded yet.</div>')+
          '<div class="admin-upload-wrap">'+
            '<input type="file" id="upload-input-'+escape(order.id)+'">'+
            '<button class="button button-dark" type="button" onclick="window.handleAdminUpload(\''+escape(order.id)+'\')">Upload Processed Result</button>'+
          '</div>'+
        '</div>'+
        '<div class="admin-order-footer">'+
          '<div class="admin-status-row">'+
            '<label for="status-select-'+escape(order.id)+'" style="font:800 9px var(--mono);color:#7f8a84;letter-spacing:0.1em">UPDATE STATUS:</label>'+
            '<select id="status-select-'+escape(order.id)+'" class="order-status-select" onchange="window.handleAdminStatusUpdate(\''+escape(order.id)+'\', this.value)">'+
              statuses.map(function(st){return '<option value="'+st+'" '+(order.status===st?'selected':'')+'>'+st+'</option>';}).join('')+
            '</select>'+
            '<button class="button button-ghost" type="button" onclick="window.openAdminMessages(\''+escape(order.id)+'\')">Customer Support Messages</button>'+
          '</div>'+
          '<p class="admin-message" role="status"></p>'+
        '</div>'+
        '</article>';
    }).join('');
    loadAdminAirbagPhotoPreviews();
  }

  async function loadAdminAirbagPhotoPreviews(){
    if (photoPreviewObserver) photoPreviewObserver.disconnect();
    attachmentPreviewUrls.forEach(function(url){URL.revokeObjectURL(url);});
    attachmentPreviewUrls=[];
    const images=[...document.querySelectorAll('.admin-airbag-photo[data-photo-path]')];
    const loadOne=async function(img){
      if(img.dataset.previewLoaded)return;
      img.dataset.previewLoaded='true';
      try{const blob=await backend.download('private-ecu-files/'+img.dataset.photoPath);const url=URL.createObjectURL(blob);attachmentPreviewUrls.push(url);img.src=url;}
      catch{img.alt='Private photo preview unavailable; use Download Photo.';img.classList.add('photo-unavailable');}
    };
    if(typeof IntersectionObserver==='function'){
      photoPreviewObserver=new IntersectionObserver(function(entries,observer){entries.forEach(function(entry){if(entry.isIntersecting){observer.unobserve(entry.target);loadOne(entry.target);}});},{rootMargin:'180px'});
      images.forEach(function(img){photoPreviewObserver.observe(img);});
    }else{await Promise.all(images.map(loadOne));}
  }

  document.querySelector('#order-list')?.addEventListener('click',function(event){
    const button=event.target.closest('button[data-admin-download]');
    if(!button)return;
    window.downloadAdminFile(button.dataset.objectPath,button.dataset.fileName);
  });

  window.downloadAdminFile = async function(objectPath, name) {
    try {
      const blob = await backend.download('private-ecu-files/'+objectPath);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name || 'file.bin';
      a.click();
      setTimeout(function(){ URL.revokeObjectURL(url); }, 30000);
    } catch (error) {
      document.querySelector('#orders-message').textContent = error.message;
      document.querySelector('#orders-message').classList.add('admin-error');
    }
  };

  window.handleAdminUpload = async function(id) {
    const card = document.querySelector('[data-order-id="'+CSS.escape(id)+'"]');
    const fileInput = document.querySelector('#upload-input-'+CSS.escape(id));
    const local = card?.querySelector('.admin-message');
    const file = fileInput?.files?.[0];
    const order = orders.find(function(o){return o.id===id;});
    const userId = order?.customer_id;
    const session = backend.getSession();

    if (!file) {
      if (local) { local.textContent = 'Select a file to upload first.'; local.classList.add('admin-error'); }
      return;
    }
    if (!userId || !session?.user?.id || file.size > 50 * 1024 * 1024) {
      if (local) {
        local.textContent = !userId ? 'Order owner details are missing.' : file.size > 50 * 1024 * 1024 ? 'File exceeds the 50 MB limit.' : 'Admin session is missing.';
        local.classList.add('admin-error');
      }
      return;
    }

    if (local) { local.textContent = 'Uploading directly to private storage…'; local.classList.remove('admin-error'); }
    try {
      const safeName = file.name.normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(-180) || 'processed.bin';
      const objectPath = userId+'/'+id+'/processed/'+crypto.randomUUID()+'_'+safeName;
      await backend.upload('private-ecu-files/'+objectPath, file);
      const inserted = await backend.rest('order_files', {
        method: 'POST',
        body: {
          order_id: id,
          owner_id: userId,
          kind: 'processed',
          bucket_id: 'private-ecu-files',
          object_path: objectPath,
          original_name: file.name.slice(0, 255),
          mime_type: file.type || 'application/octet-stream',
          size_bytes: file.size,
          uploaded_by: session.user.id
        }
      });
      if (!inserted) throw new Error('The processed file could not be registered.');
      if (local) local.textContent = 'Processed file uploaded and linked successfully.';
      await loadOrders();
    } catch (error) {
      if (local) {
        local.textContent = error.message;
        local.classList.add('admin-error');
      }
    }
  };

  window.handleAdminSetSecondStage = async function(id) {
    const card = document.querySelector('[data-order-id="'+CSS.escape(id)+'"]');
    const inputAmount = document.querySelector('#stage-amount-'+CSS.escape(id));
    const local = card?.querySelector('.admin-message');
    const amountVal = Number(inputAmount?.value);
    if (!Number.isFinite(amountVal) || amountVal <= 0) {
      if (local) { local.textContent = 'Enter a valid positive amount in rupees.'; local.classList.add('admin-error'); }
      return;
    }
    if (local) { local.textContent = 'Creating Razorpay Payment Link…'; local.classList.remove('admin-error'); }
    try {
      const token = await backend.getAccessToken();
      const response = await fetch('/api/admin/orders/second-stage/create-payment-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer '+token },
        body: JSON.stringify({ orderId: id, amountRupees: amountVal })
      });
      const result = await parseJson(response);
      if (!response.ok) throw new Error(result.error || 'Second-stage payment link could not be created.');
      if (local) local.textContent = 'Second-stage payment link created successfully.';
      await loadOrders();
    } catch (error) {
      if (local) {
        local.textContent = error.message;
        local.classList.add('admin-error');
      }
    }
  };

  window.handleAdminMarkSecondStageUnpaid = async function(id) {
    if (!confirm('This will only mark the payment as UNPAID in the website records. It does NOT refund or reverse the actual Razorpay payment. Are you sure?')) return;
    const card = document.querySelector('[data-order-id="'+CSS.escape(id)+'"]');
    const local = card?.querySelector('.admin-message');
    if (local) { local.textContent = 'Marking unpaid…'; local.classList.remove('admin-error'); }
    try {
      const token = await backend.getAccessToken();
      const response = await fetch('/api/admin/orders/second-stage/mark-unpaid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer '+token },
        body: JSON.stringify({ orderId: id })
      });
      const result = await parseJson(response);
      if (!response.ok) throw new Error(result.error || 'Second-stage payment could not be marked unpaid.');
      await loadOrders();
    } catch (error) {
      if (local) {
        local.textContent = error.message;
        local.classList.add('admin-error');
      }
    }
  };

  window.handleAdminMarkSecondStagePaid = async function(id) {
    const card = document.querySelector('[data-order-id="'+CSS.escape(id)+'"]');
    const local = card?.querySelector('.admin-message');
    if (local) { local.textContent = 'Marking paid…'; local.classList.remove('admin-error'); }
    try {
      const token = await backend.getAccessToken();
      const response = await fetch('/api/admin/orders/second-stage/mark-paid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer '+token },
        body: JSON.stringify({ orderId: id })
      });
      const result = await parseJson(response);
      if (!response.ok) throw new Error(result.error || 'Second-stage payment could not be marked paid.');
      await loadOrders();
    } catch (error) {
      if (local) {
        local.textContent = error.message;
        local.classList.add('admin-error');
      }
    }
  };

  window.handleAdminStatusUpdate = async function(id, status) {
    const card = document.querySelector('[data-order-id="'+CSS.escape(id)+'"]');
    const local = card?.querySelector('.admin-message');
    if (local) { local.textContent = 'Saving status…'; local.classList.remove('admin-error'); }
    try {
      const token = await backend.getAccessToken();
      const response = await fetch('/api/admin/orders/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer '+token },
        body: JSON.stringify({ orderId: id, status })
      });
      const result = await parseJson(response);
      if (!response.ok) throw new Error(result.error || 'The order status could not be saved.');
      await loadOrders();
    } catch (error) {
      if (local) {
        local.textContent = error.message;
        local.classList.add('admin-error');
      }
    }
  };


  const siteContentForm = document.querySelector('#site-content-form');
  const siteContentMessage = document.querySelector('#site-content-message');
  async function adminApi(path, options = {}) {
    const token = await backend.getAccessToken();
    const response = await fetch(path, { ...options, headers: { ...(options.body ? {'Content-Type':'application/json'} : {}), Authorization:'Bearer '+token, ...(options.headers||{}) } });
    const result = await parseJson(response);
    if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
    return result;
  }
  function localDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset()*60000);
    return local.toISOString().slice(0,16);
  }
  async function loadSiteContent() {
    const list = document.querySelector('#site-content-list');
    try {
      const result = await adminApi('/api/admin/site-content');
      list.innerHTML = (result.items||[]).map(item => '<article class="admin-order-card" style="padding:14px;margin-bottom:10px"><div style="display:flex;gap:12px;justify-content:space-between;flex-wrap:wrap"><div><span class="form-kicker">'+escape(item.kind)+' · '+escape(item.placement)+'</span><h3>'+escape(item.title)+'</h3><p>'+escape(item.body||'')+'</p><small>'+escape(item.is_published?'Published':'Draft / hidden')+' · Starts '+escape(item.starts_at?new Date(item.starts_at).toLocaleString():'now')+(item.ends_at?' · Ends '+escape(new Date(item.ends_at).toLocaleString()):'')+'</small></div><div style="display:flex;gap:8px;align-items:flex-start"><button type="button" class="button button-ghost" data-edit-content-id="'+escape(item.id)+'">Edit</button><button type="button" class="button button-ghost" data-content-id="'+escape(item.id)+'" data-published="'+String(Boolean(item.is_published))+'">'+(item.is_published?'Hide':'Publish')+'</button></div></div></article>').join('') || '<p>No announcements, offers or ads have been created.</p>';
      list.querySelectorAll('button[data-edit-content-id]').forEach(button => button.addEventListener('click', () => {
        const item=(result.items||[]).find(x=>x.id===button.dataset.editContentId); if(!item)return;
        const set=(name,value)=>{const field=siteContentForm.elements.namedItem(name);if(field)field.value=value??'';};
        set('id',item.id);set('kind',item.kind);set('placement',item.placement);set('title',item.title);set('body',item.body);set('image_url',item.image_url);set('cta_label',item.cta_label);set('cta_url',item.cta_url);set('starts_at',localDateTime(item.starts_at));set('ends_at',localDateTime(item.ends_at));
        siteContentForm.elements.namedItem('is_published').checked=Boolean(item.is_published);
        siteContentForm.querySelector('button[type="submit"]').textContent='Update website content →';
        document.querySelector('#site-content-cancel-edit').hidden=false;
        siteContentMessage.textContent='Editing: '+item.title;
        siteContentForm.scrollIntoView({behavior:'smooth',block:'start'});
      }));
      list.querySelectorAll('button[data-content-id]').forEach(button => button.addEventListener('click', async () => {
        button.disabled = true;
        try { await adminApi('/api/admin/site-content',{method:'PATCH',body:JSON.stringify({id:button.dataset.contentId,is_published:button.dataset.published!=='true'})}); await loadSiteContent(); }
        catch(error){siteContentMessage.textContent=error.message;siteContentMessage.classList.add('admin-error');}
        finally{button.disabled=false;}
      }));
    } catch(error) { list.textContent=error.message; }
  }
  function resetSiteContentForm() {
    siteContentForm.reset(); siteContentForm.elements.namedItem('id').value='';
    siteContentForm.querySelector('button[type="submit"]').textContent='Save website content →';
    document.querySelector('#site-content-cancel-edit').hidden=true;
  }
  document.querySelector('#site-content-cancel-edit')?.addEventListener('click',resetSiteContentForm);
  async function loadAdvertisingInquiries() {
    const list = document.querySelector('#advertising-inquiry-list');
    try {
      const result = await adminApi('/api/admin/advertising/inquiries');
      list.innerHTML = (result.items||[]).map(item => '<article class="admin-order-card" style="padding:14px;margin-bottom:10px"><span class="form-kicker">'+escape(item.ad_type)+' · '+escape(new Date(item.created_at).toLocaleString())+'</span><h3>'+escape(item.business_name)+'</h3><p>'+escape(item.contact_name)+' · '+escape(item.email)+' · '+escape(item.phone)+'</p>'+(item.website?'<p><a href="'+escape(item.website)+'" target="_blank" rel="noopener noreferrer">'+escape(item.website)+'</a></p>':'')+'<p>'+escape(item.message)+'</p><label>Status <select data-inquiry-id="'+escape(item.id)+'"><option value="new">New</option><option value="contacted">Contacted</option><option value="approved">Approved</option><option value="declined">Declined</option><option value="closed">Closed</option></select></label></article>').join('') || '<p>No advertiser enquiries received yet.</p>';
      list.querySelectorAll('select[data-inquiry-id]').forEach(select => {
        const item=(result.items||[]).find(x=>x.id===select.dataset.inquiryId); select.value=item?.status||'new';
        select.addEventListener('change',async()=>{select.disabled=true;try{await adminApi('/api/admin/advertising/inquiries',{method:'PATCH',body:JSON.stringify({id:select.dataset.inquiryId,status:select.value})});document.querySelector('#advertising-inquiry-message').textContent='Enquiry status updated.';}catch(error){document.querySelector('#advertising-inquiry-message').textContent=error.message;select.value=item?.status||'new';}finally{select.disabled=false;}});
      });
    } catch(error) { list.textContent=error.message; }
  }
  siteContentForm?.addEventListener('submit', async event => {
    event.preventDefault(); const button=siteContentForm.querySelector('button[type="submit"]');button.disabled=true;siteContentMessage.classList.remove('admin-error');siteContentMessage.textContent='Saving…';
    try {
      const data=new FormData(siteContentForm), id=String(data.get('id')||'').trim();
      const value={kind:data.get('kind'),placement:data.get('placement'),title:data.get('title'),body:data.get('body'),image_url:data.get('image_url'),cta_label:data.get('cta_label'),cta_url:data.get('cta_url'),starts_at:data.get('starts_at')?new Date(data.get('starts_at')).toISOString():null,ends_at:data.get('ends_at')?new Date(data.get('ends_at')).toISOString():null,is_published:data.get('is_published')==='on'};
      if(id)value.id=id;
      await adminApi('/api/admin/site-content',{method:id?'PATCH':'POST',body:JSON.stringify(value)});
      resetSiteContentForm();siteContentMessage.textContent='Saved. The public page will show it when published and within its date window.';await loadSiteContent();
    } catch(error) { siteContentMessage.textContent=error.message;siteContentMessage.classList.add('admin-error'); }
    finally { button.disabled=false; }
  });

  async function enterAdmin(){
    const session = backend.getSession();
    if (!session?.user) { setSignedOut(); return; }
    if (session.user.app_metadata?.role !== 'admin') {
      showDenied('This account is signed in but has no trusted administrator role.');
      return;
    }
    loginPanel.hidden = true;
    deniedPanel.hidden = true;
    dashboard.hidden = false;
    document.querySelector('#admin-signout').hidden = false;
    await loadPricing();
    await loadOrders();
    await loadSiteContent();
    await loadAdvertisingInquiries();
    subscribeRealtime();
  }

  document.querySelector('#admin-auth').addEventListener('submit', async function(event) {
    event.preventDefault();
    message.classList.remove('admin-error');
    message.textContent = 'Authenticating...';
    try {
      const isConfigured = await configured();
      if (!isConfigured) throw new Error('Supabase is not configured on this server.');
      await backend.signIn(document.querySelector('#admin-email').value.trim(), document.querySelector('#admin-password').value);
      document.querySelector('#admin-password').value = '';
      const session = backend.getSession();
      if (!session?.user) throw new Error('Sign-in failed.');
      if (session.user.app_metadata?.role !== 'admin') {
         showDenied('This account is signed in but has no trusted administrator role.');
         return;
      }
      await enterAdmin();
    } catch (error) {
      message.textContent = error.message;
      message.classList.add('admin-error');
    }
  });

  window.openAdminMessages = async function(orderId) {
    const dialog = document.createElement('dialog');
    dialog.className = 'admin-dialog';
    dialog.innerHTML = `<div style="padding:20px;max-width:500px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px">
        <h3 style="margin:0;font-size:16px">Admin Reply: ${escape(orderId.slice(0, 8))}</h3>
        <button type="button" class="dialog-close-btn">Close</button>
      </div>
      <div class="messages-list" style="max-height:300px;overflow-y:auto;border:1px solid #ddd;padding:10px;margin-bottom:15px;background:#f9f9f9;display:grid;gap:8px">Loading...</div>
      <form class="message-reply-form" style="display:flex;gap:8px">
        <textarea name="message" required placeholder="Reply to customer..." maxlength="2000" style="flex:1;height:60px;padding:8px"></textarea>
        <button type="submit" class="button button-dark">Send Reply</button>
      </form>
    </div>`;
    document.body.appendChild(dialog);
    dialog.showModal();

    dialog.querySelector('.dialog-close-btn').addEventListener('click', () => dialog.close());
    const list = dialog.querySelector('.messages-list');
    const form = dialog.querySelector('.message-reply-form');

    async function loadMessages() {
      try {
        const token = await backend.getAccessToken();
        const res = await fetch(`/api/admin/orders/messages?orderId=${encodeURIComponent(orderId)}`, { headers: { Authorization: `Bearer ${token}` } });
        const result = await res.json();
        if (!res.ok) throw new Error(result?.error || 'Failed to load messages.');
        list.innerHTML = result.messages.length ? result.messages.map(m => `
          <div style="padding:8px 12px;border-radius:6px;background:${m.sender_type==='admin'?'#eef3ec':'#f1f5f9'};font-size:12px">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;font:750 10px var(--mono);color:#55605b">
              <span>${m.sender_type==='admin'?'YOU (ADMIN)':'CUSTOMER'}</span>
              <span>${new Date(m.created_at).toLocaleString()}</span>
            </div>
            <div style="white-space:pre-wrap;word-break:break-word">${escape(m.message)}</div>
          </div>
        `).join('') : '<p>No messages yet.</p>';
        list.scrollTop = list.scrollHeight;
      } catch (e) { list.innerHTML = `<p style="color:red">${escape(e.message)}</p>`; }
    }

    loadMessages();

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const textarea = form.querySelector('textarea');
      const msg = textarea.value.trim();
      if (!msg) return;
      try {
        const token = await backend.getAccessToken();
        const res = await fetch('/api/admin/orders/messages/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ orderId, message: msg }) });
        const result = await res.json();
        if (!res.ok) throw new Error(result?.error || 'Failed to send reply.');
        textarea.value = '';
        loadMessages();
      } catch (e) { alert(e.message); }
    });

    dialog.addEventListener('close', () => dialog.remove());
  };

  document.querySelector('#admin-signout').addEventListener('click', async function() { await backend.signOut(); setSignedOut(); });
  document.querySelector('#admin-denied-signout').addEventListener('click', async function() { await backend.signOut(); setSignedOut(); });
  document.querySelector('#refresh-orders').addEventListener('click', loadOrders);

  if (searchInput) searchInput.addEventListener('input', renderOrders);
  if (statusFilter) statusFilter.addEventListener('change', renderOrders);
  if (resultFilter) resultFilter.addEventListener('change', renderOrders);
  if (sortSelect) sortSelect.addEventListener('change', renderOrders);

  enterAdmin();
})();
