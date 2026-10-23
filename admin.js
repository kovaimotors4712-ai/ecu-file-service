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
  let showArchivedOrders = false;
  let showArchivedCustomerRequests = false;
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
    const orderList=document.querySelector('#order-list');
    let archiveToggle=document.querySelector('#admin-orders-archive-toggle');
    if(orderList&&!archiveToggle){archiveToggle=document.createElement('button');archiveToggle.id='admin-orders-archive-toggle';archiveToggle.type='button';archiveToggle.className='button button-ghost';orderList.parentElement.insertBefore(archiveToggle,orderList);archiveToggle.addEventListener('click',function(){showArchivedOrders=!showArchivedOrders;loadOrders();});}
    if(archiveToggle)archiveToggle.textContent=showArchivedOrders?'Show active orders':'Show archived orders';
    statusMessage.textContent='Loading orders…';
    statusMessage.classList.remove('admin-error');
    try{
      orders=await backend.rest(`orders?select=id,customer_id,status,admin_archived_at,category,vehicle_brand,vehicle_type,vehicle_model,vehicle_year,ecu_manufacturer,ecu_model,reading_tool,module_details,selected_services,notes,contact_name,contact_phone,contact_email,payment_status,payment_provider,provider_order_id,provider_payment_id,verification_amount_paise,second_stage_amount,second_stage_status,second_stage_paid_at,second_stage_payment_link,created_at,updated_at,order_files!order_files_order_id_fkey(id,kind,original_name,object_path,size_bytes,created_at),order_attachments!order_attachments_order_id_fkey(id,kind,original_name,object_path,mime_type,size_bytes,created_at)&admin_archived_at=${showArchivedOrders?'not.is.null':'is.null'}&order=created_at.desc&limit=500`);
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
      updateAdminFolderBadges();
    }catch(error){
      statusMessage.textContent=error.message;
      statusMessage.classList.add('admin-error');
      updateAdminFolderBadges();
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

    function renderOrderCard(order){
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
            '<button class="button button-ghost admin-order-archive-action" type="button" data-order-id="'+escape(order.id)+'" data-archived="'+(order.admin_archived_at?'true':'false')+'">'+(order.admin_archived_at?'Restore order':'Archive order')+'</button>'+
          '</div>'+
          '<p class="admin-message" role="status"></p>'+
        '</div>'+
        '</article>';
    }

    const customerGroups=new Map();
    filtered.forEach(function(order){
      const key=String(order.customer_id||order.contact_email||order.contact_phone||order.id);
      if(!customerGroups.has(key))customerGroups.set(key,{key:key,orders:[]});
      customerGroups.get(key).orders.push(order);
    });
    list.innerHTML=Array.from(customerGroups.values()).map(function(group){
      const first=group.orders[0];
      const pending=group.orders.filter(function(order){return ['New','File Review','Processing','Payment Pending'].includes(order.status)||order.payment_status==='PENDING';}).length;
      const name=first.contact_name||'Customer';
      const contact=[first.contact_phone,first.contact_email].filter(Boolean).join(' · ');
      return '<details class="admin-customer-folder">'+
        '<summary><span class="admin-customer-folder-main"><b>'+escape(name)+'</b><small>'+escape(contact||'Contact details not available')+'</small></span>'+
        '<span class="admin-customer-folder-count">'+group.orders.length+' order'+(group.orders.length===1?'':'s')+(pending?' · '+pending+' pending':'')+'</span></summary>'+
        '<div class="admin-customer-orders">'+group.orders.map(renderOrderCard).join('')+'</div></details>';
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

  document.querySelector('#order-list')?.addEventListener('click',async function(event){
    const archiveButton=event.target.closest('.admin-order-archive-action');
    if(archiveButton){
      const orderId=archiveButton.getAttribute('data-order-id');
      const wasArchived=archiveButton.getAttribute('data-archived')==='true';
      if(!orderId)return;
      archiveButton.disabled=true;
      try{await backend.rest('rpc/efsi_admin_archive_order',{method:'POST',body:{p_order_id:orderId,p_archived:!wasArchived}});await loadOrders();document.querySelector('#orders-message').textContent=wasArchived?'Order restored to active list.':'Order archived. Payment and file records are retained.';}
      catch(error){document.querySelector('#orders-message').textContent='Archive update failed: '+(error.message||'Please retry.');document.querySelector('#orders-message').classList.add('admin-error');archiveButton.disabled=false;}
      return;
    }
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
  const publicContactForm=document.querySelector('#public-contact-form');
  const publicContactMessage=document.querySelector('#public-contact-message');
  async function loadPublicContactSettings(){
    if(!publicContactForm)return;
    try{const result=await adminApi('/api/admin/site-settings');const s=result.settings||{};
      publicContactForm.elements.namedItem('contact_phone').value=s.contact_phone||'';
      publicContactForm.elements.namedItem('telegram_url').value=s.telegram_url||'';
      publicContactForm.elements.namedItem('contact_email').value=s.contact_email||'';
      publicContactMessage.textContent='Current public contact details loaded.';
    }catch(error){publicContactMessage.textContent=error.message;publicContactMessage.classList.add('admin-error');}
  }
  publicContactForm?.addEventListener('submit',async event=>{
    event.preventDefault();const button=publicContactForm.querySelector('button[type="submit"]');button.disabled=true;publicContactMessage.classList.remove('admin-error');publicContactMessage.textContent='Saving…';
    try{const data=new FormData(publicContactForm);const result=await adminApi('/api/admin/site-settings',{method:'PATCH',body:JSON.stringify({contact_phone:String(data.get('contact_phone')||'').trim(),telegram_url:String(data.get('telegram_url')||'').trim(),contact_email:String(data.get('contact_email')||'').trim()})});publicContactForm.elements.namedItem('telegram_url').value=result.settings?.telegram_url||'';publicContactForm.elements.namedItem('contact_phone').value=result.settings?.contact_phone||'';publicContactForm.elements.namedItem('contact_email').value=result.settings?.contact_email||'';publicContactMessage.textContent='Saved successfully. Reload the homepage to verify each contact link.';}
    catch(error){publicContactMessage.textContent=error.message;publicContactMessage.classList.add('admin-error');}
    finally{button.disabled=false;}
  });

  async function loadSiteContent() {
    const list = document.querySelector('#site-content-list');
    try {
      const result = await adminApi('/api/admin/site-content');
      list.innerHTML = (result.items||[]).map(item => '<article class="admin-order-card" style="padding:14px;margin-bottom:10px"><div style="display:flex;gap:12px;justify-content:space-between;flex-wrap:wrap"><div><span class="form-kicker">'+escape(item.kind)+' · '+escape(item.placement)+'</span><h3>'+escape(item.title)+'</h3><p>'+escape(item.body||'')+'</p><small>'+escape(item.is_published?'Published':'Draft / hidden')+' · Starts '+escape(item.starts_at?new Date(item.starts_at).toLocaleString():'now')+(item.ends_at?' · Ends '+escape(new Date(item.ends_at).toLocaleString()):'')+'</small></div><div style="display:flex;gap:8px;align-items:flex-start"><button type="button" class="button button-ghost" data-edit-content-id="'+escape(item.id)+'">Edit</button><button type="button" class="button button-ghost" data-content-id="'+escape(item.id)+'" data-published="'+String(Boolean(item.is_published))+'">'+(item.is_published?'Hide':'Publish')+'</button><button type="button" class="button button-ghost" data-delete-content-id="'+escape(item.id)+'">Delete</button></div></div></article>').join('') || '<p>No announcements, offers or ads have been created.</p>';
      list.querySelectorAll('button[data-edit-content-id]').forEach(button => button.addEventListener('click', () => {
        const item=(result.items||[]).find(x=>x.id===button.dataset.editContentId); if(!item)return;
        const set=(name,value)=>{const field=siteContentForm.elements.namedItem(name);if(field)field.value=value??'';};
        set('id',item.id);set('kind',item.kind);set('placement',item.placement);set('advertising_quote_id',item.advertising_quote_id);set('title',item.title);set('body',item.body);set('image_url',item.image_url);set('cta_label',item.cta_label);set('cta_url',item.cta_url);set('starts_at',localDateTime(item.starts_at));set('ends_at',localDateTime(item.ends_at));
        siteContentForm.elements.namedItem('is_published').checked=Boolean(item.is_published);
        updateAdQuoteRequirement();
        siteContentForm.querySelector('button[type="submit"]').textContent='Update website content →';
        document.querySelector('#site-content-cancel-edit').hidden=false;
        siteContentMessage.textContent='Editing: '+item.title;
        siteContentForm.scrollIntoView({behavior:'smooth',block:'start'});
      }));
      list.querySelectorAll('button[data-delete-content-id]').forEach(button => button.addEventListener('click', async () => {
        const item=(result.items||[]).find(x=>x.id===button.dataset.deleteContentId);
        if(!item || !window.confirm('Permanently delete this content? This cannot be undone.')) return;
        button.disabled=true;
        try { await adminApi('/api/admin/site-content',{method:'DELETE',body:JSON.stringify({id:item.id})}); siteContentMessage.textContent='Content deleted.'; resetSiteContentForm(); await loadSiteContent(); }
        catch(error){siteContentMessage.textContent=error.message;siteContentMessage.classList.add('admin-error');button.disabled=false;}
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
    updateAdQuoteRequirement();
    siteContentForm.querySelector('button[type="submit"]').textContent='Save website content →';
    document.querySelector('#site-content-cancel-edit').hidden=true;
  }
  document.querySelector('#site-content-cancel-edit')?.addEventListener('click',resetSiteContentForm);
  const contentKindField=siteContentForm?.elements.namedItem('kind');
  const contentPublishedField=siteContentForm?.elements.namedItem('is_published');
  const contentQuoteField=siteContentForm?.elements.namedItem('advertising_quote_id');
  function updateAdQuoteRequirement(){
    if(!contentQuoteField)return;
    // Directly managed advertisements may be published after admin review without an online quote.
    // If a paid quote is linked, the database trigger still verifies payment and the schedule.
    contentQuoteField.required=false;
    contentQuoteField.setCustomValidity('');
  }
  contentKindField?.addEventListener('change',updateAdQuoteRequirement);
  contentPublishedField?.addEventListener('change',updateAdQuoteRequirement);
  contentQuoteField?.addEventListener('change',updateAdQuoteRequirement);

  async function loadAdvertisingInquiries() {
    const list = document.querySelector('#advertising-inquiry-list');
    try {
      const result = await adminApi('/api/admin/advertising/inquiries');
      const inquirySelect=document.querySelector('#advertising-quote-inquiry');
      if(inquirySelect){
        const previous=inquirySelect.value;
        inquirySelect.innerHTML='<option value="">Choose an enquiry…</option>'+(result.items||[]).filter(item=>!['declined','closed'].includes(item.status)).map(item=>'<option value="'+escape(item.id)+'">'+escape(item.business_name)+' — '+escape(item.email)+' ('+escape(item.status)+')</option>').join('');
        if(previous)inquirySelect.value=previous;
      }
      list.innerHTML = (result.items||[]).map(item => '<article class="admin-order-card" style="padding:14px;margin-bottom:10px"><span class="form-kicker">'+escape(item.ad_type)+' · '+escape(new Date(item.created_at).toLocaleString())+'</span><h3>'+escape(item.business_name)+'</h3><p>'+escape(item.contact_name)+' · '+escape(item.email)+' · '+escape(item.phone)+'</p>'+(item.website?'<p><a href="'+escape(item.website)+'" target="_blank" rel="noopener noreferrer">'+escape(item.website)+'</a></p>':'')+'<p>'+escape(item.message)+'</p><label>Status <select data-inquiry-id="'+escape(item.id)+'"><option value="new">New</option><option value="contacted">Contacted</option><option value="approved">Approved</option><option value="declined">Declined</option><option value="closed">Closed</option></select></label></article>').join('') || '<p>No advertiser enquiries received yet.</p>';
      list.querySelectorAll('select[data-inquiry-id]').forEach(select => {
        const item=(result.items||[]).find(x=>x.id===select.dataset.inquiryId); select.value=item?.status||'new';
        select.addEventListener('change',async()=>{select.disabled=true;try{await adminApi('/api/admin/advertising/inquiries',{method:'PATCH',body:JSON.stringify({id:select.dataset.inquiryId,status:select.value})});document.querySelector('#advertising-inquiry-message').textContent='Enquiry status updated.';}catch(error){document.querySelector('#advertising-inquiry-message').textContent=error.message;select.value=item?.status||'new';}finally{select.disabled=false;}});
      });
    } catch(error) { list.textContent=error.message; }
  }
  const advertisingQuoteForm=document.querySelector('#advertising-quote-form');
  const advertisingQuoteMessage=document.querySelector('#advertising-quote-message');
  async function loadAdvertisingQuotes(){
    const list=document.querySelector('#advertising-quote-list');if(!list)return;
    try{
      const result=await adminApi('/api/admin/advertising/quotes');
      const adQuoteSelect=document.querySelector('#site-content-advertising-quote');
      if(adQuoteSelect){
        const previous=adQuoteSelect.value;
        adQuoteSelect.innerHTML='<option value="">Not linked (announcements/offers only)</option>'+(result.items||[]).filter(item=>item.status==='paid').map(item=>'<option value="'+escape(item.id)+'">Paid quote v'+escape(item.quote_version)+' · '+escape((Number(item.amount_paise)/100).toLocaleString('en-IN',{style:'currency',currency:'INR'}))+' · '+escape(item.placement)+'</option>').join('');
        if(previous)adQuoteSelect.value=previous;
      }
      list.innerHTML=(result.items||[]).map(item=>{
        const inquiry=Array.isArray(item.advertising_inquiries)?item.advertising_inquiries[0]:item.advertising_inquiries;
        const amount=(Number(item.amount_paise)/100).toLocaleString('en-IN',{style:'currency',currency:'INR'});
        const payments=Array.isArray(item.advertising_payments)?item.advertising_payments:[];
        const paymentInfo=payments.slice(0,5).map(p=>'<p><b>Payment '+escape(p.status)+'</b> · '+escape((Number(p.amount_paise)/100).toLocaleString('en-IN',{style:'currency',currency:'INR'}))+(p.verified_at?' · Verified '+escape(new Date(p.verified_at).toLocaleString()):'')+'<br><small>Order: '+escape(p.provider_order_id||'pending')+' · Payment: '+escape(p.provider_payment_id||'—')+'</small></p>').join('')||'<p>Payment: not started</p>';
        return '<article class="admin-order-card" style="padding:14px;margin-bottom:10px"><span class="form-kicker">QUOTE V'+escape(item.quote_version)+' · '+escape(item.status)+'</span><h3>'+escape(inquiry?.business_name||'Advertiser enquiry')+' — '+escape(amount)+'</h3><p>'+escape(item.placement)+' · '+escape(new Date(item.starts_at).toLocaleString())+' to '+escape(new Date(item.ends_at).toLocaleString())+'</p><p>Expires '+escape(new Date(item.expires_at).toLocaleString())+'</p><p>'+escape(item.terms_snapshot)+'</p>'+paymentInfo+'<div style="display:flex;gap:8px;flex-wrap:wrap">'+(item.status==='draft'?'<button class="button button-dark" type="button" data-issue-quote="'+escape(item.id)+'">Issue & email quote</button>':'')+(['draft','issued'].includes(item.status)?'<button class="button button-ghost" type="button" data-decline-quote="'+escape(item.id)+'">Decline quote</button>':'')+'</div></article>';
      }).join('')||'<p>No advertising quotes created yet.</p>';
      list.querySelectorAll('[data-issue-quote]').forEach(button=>button.addEventListener('click',async()=>{
        button.disabled=true;advertisingQuoteMessage.textContent='Issuing quote and sending secure link…';advertisingQuoteMessage.classList.remove('admin-error');
        try{await adminApi('/api/admin/advertising/quotes',{method:'PATCH',body:JSON.stringify({id:button.dataset.issueQuote,action:'issue'})});advertisingQuoteMessage.textContent='Quote issued and email accepted by the delivery provider.';await loadAdvertisingQuotes();}
        catch(error){advertisingQuoteMessage.textContent=error.message;advertisingQuoteMessage.classList.add('admin-error');}
        finally{button.disabled=false;}
      }));
      list.querySelectorAll('[data-decline-quote]').forEach(button=>button.addEventListener('click',async()=>{
        if(!confirm('Decline this quote? A new quote version can be created later.'))return;
        button.disabled=true;
        try{await adminApi('/api/admin/advertising/quotes',{method:'PATCH',body:JSON.stringify({id:button.dataset.declineQuote,action:'decline'})});advertisingQuoteMessage.textContent='Quote declined.';await loadAdvertisingQuotes();}
        catch(error){advertisingQuoteMessage.textContent=error.message;advertisingQuoteMessage.classList.add('admin-error');}
        finally{button.disabled=false;}
      }));
    }catch(error){list.textContent=error.message;}
  }
  advertisingQuoteForm?.addEventListener('submit',async event=>{
    event.preventDefault();const button=advertisingQuoteForm.querySelector('button[type="submit"]');button.disabled=true;advertisingQuoteMessage.classList.remove('admin-error');advertisingQuoteMessage.textContent='Saving quote draft…';
    try{
      const data=new FormData(advertisingQuoteForm), amountText=String(data.get('amount')||'').trim();
      if(!/^\d+(?:\.\d{1,2})?$/.test(amountText))throw new Error('Enter a valid amount with up to two decimal places.');
      const parts=amountText.split('.'), amountPaise=Number(parts[0])*100+Number((parts[1]||'').padEnd(2,'0'));
      if(!Number.isSafeInteger(amountPaise)||amountPaise<1)throw new Error('Enter a valid positive amount.');
      const result=await adminApi('/api/admin/advertising/quotes',{method:'POST',body:JSON.stringify({inquiryId:data.get('inquiryId'),amountPaise,placement:data.get('placement'),startsAt:new Date(data.get('startsAt')).toISOString(),endsAt:new Date(data.get('endsAt')).toISOString(),expiresAt:new Date(data.get('expiresAt')).toISOString(),terms:data.get('terms'),creativeRequirements:data.get('creativeRequirements')})});
      advertisingQuoteForm.reset();advertisingQuoteMessage.textContent='Draft quote saved. Review it below, then issue it to email a private acceptance link.';await loadAdvertisingQuotes();
    }catch(error){advertisingQuoteMessage.textContent=error.message;advertisingQuoteMessage.classList.add('admin-error');}
    finally{button.disabled=false;}
  });

  siteContentForm?.addEventListener('submit', async event => {
    event.preventDefault(); const button=siteContentForm.querySelector('button[type="submit"]');button.disabled=true;siteContentMessage.classList.remove('admin-error');siteContentMessage.textContent='Saving…';
    try {
      const data=new FormData(siteContentForm), id=String(data.get('id')||'').trim();
      const value={kind:data.get('kind'),placement:data.get('placement'),advertising_quote_id:data.get('advertising_quote_id')||null,title:data.get('title'),body:data.get('body'),image_url:data.get('image_url'),cta_label:data.get('cta_label'),cta_url:data.get('cta_url'),starts_at:data.get('starts_at')?new Date(data.get('starts_at')).toISOString():null,ends_at:data.get('ends_at')?new Date(data.get('ends_at')).toISOString():null,is_published:data.get('is_published')==='on'};
      if(id)value.id=id;
      await adminApi('/api/admin/site-content',{method:id?'PATCH':'POST',body:JSON.stringify(value)});
      resetSiteContentForm();siteContentMessage.textContent='Saved. The public page will show it when published and within its date window.';await loadSiteContent();
    } catch(error) { siteContentMessage.textContent=error.message;siteContentMessage.classList.add('admin-error'); }
    finally { button.disabled=false; }
  });

  const softwareProductForm=document.querySelector('#software-product-form');
  const softwareProductList=document.querySelector('#software-product-list');
  const softwareProductMessage=document.querySelector('#software-product-message');
  function resetSoftwareProductForm(){if(!softwareProductForm)return;softwareProductForm.reset();softwareProductForm.elements.namedItem('id').value='';softwareProductForm.elements.namedItem('sort_order').value='100';softwareProductForm.querySelector('button[type="submit"]').textContent='Save software listing →';document.querySelector('#software-product-cancel').hidden=true;}
  async function loadSoftwareProducts(){
    if(!softwareProductList)return;
    try{
      const result=await adminApi('/api/admin/software-products');
      softwareProductList.innerHTML=(result.items||[]).map(item=>'<article class="admin-order-card" style="padding:14px;margin-bottom:10px"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><span class="form-kicker">'+escape(item.is_published?'PUBLISHED':'DRAFT / HIDDEN')+' · '+escape(item.version||'No version')+'</span><h3>'+escape(item.title)+'</h3><p>'+escape(item.description||'')+'</p><strong>'+escape((Number(item.price_paise||0)/100).toLocaleString('en-IN',{style:'currency',currency:item.currency||'INR'}))+'</strong></div><div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap"><button type="button" class="button button-ghost" data-edit-software="'+escape(item.id)+'">Edit</button><button type="button" class="button button-ghost" data-publish-software="'+escape(item.id)+'" data-published="'+String(Boolean(item.is_published))+'">'+(item.is_published?'Hide':'Publish')+'</button></div></div></article>').join('')||'<p>No software listings yet. Add the first listing above.</p>';
      updateAdminFolderBadges();
      softwareProductList.querySelectorAll('[data-edit-software]').forEach(button=>button.addEventListener('click',()=>{const item=(result.items||[]).find(x=>x.id===button.dataset.editSoftware);if(!item)return;const set=(name,value)=>{const f=softwareProductForm.elements.namedItem(name);if(f)f.value=value??'';};set('id',item.id);set('title',item.title);set('version',item.version);set('price',(Number(item.price_paise||0)/100).toFixed(2));set('sort_order',item.sort_order);set('description',item.description);set('image_url',item.image_url);set('product_url',item.product_url);set('contact_url',item.contact_url);softwareProductForm.elements.namedItem('is_published').checked=Boolean(item.is_published);softwareProductForm.elements.namedItem('price_visible').checked=Boolean(item.price_visible);softwareProductForm.querySelector('button[type="submit"]').textContent='Update software listing →';document.querySelector('#software-product-cancel').hidden=false;softwareProductMessage.textContent='Editing '+item.title;softwareProductForm.scrollIntoView({behavior:'smooth',block:'start'});}));
      softwareProductList.querySelectorAll('[data-publish-software]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{await adminApi('/api/admin/software-products',{method:'PATCH',body:JSON.stringify({id:button.dataset.publishSoftware,is_published:button.dataset.published!=='true'})});await loadSoftwareProducts();softwareProductMessage.textContent='Software listing visibility updated.';}catch(error){softwareProductMessage.textContent=error.message;softwareProductMessage.classList.add('admin-error');}finally{button.disabled=false;}}));
    }catch(error){softwareProductList.textContent=error.message;}
  }
  document.querySelector('#software-product-cancel')?.addEventListener('click',resetSoftwareProductForm);
  softwareProductForm?.addEventListener('submit',async event=>{
    event.preventDefault();const button=softwareProductForm.querySelector('button[type="submit"]');button.disabled=true;softwareProductMessage.classList.remove('admin-error');softwareProductMessage.textContent='Saving software listing…';
    try{
      const data=new FormData(softwareProductForm),priceText=String(data.get('price')||'').trim();
      if(!/^\d+(?:\.\d{1,2})?$/.test(priceText))throw new Error('Enter a valid price with up to two decimal places.');
      const parts=priceText.split('.'),pricePaise=Number(parts[0])*100+Number((parts[1]||'').padEnd(2,'0'));
      if(!Number.isSafeInteger(pricePaise)||pricePaise<0)throw new Error('Enter a valid non-negative price.');
      const id=String(data.get('id')||'').trim(),payload={title:data.get('title'),version:data.get('version'),description:data.get('description'),price_paise:pricePaise,price_visible:data.get('price_visible')==='on',sort_order:Number(data.get('sort_order')||100),image_url:data.get('image_url'),product_url:data.get('product_url'),contact_url:data.get('contact_url'),is_published:data.get('is_published')==='on'};
      if(id)payload.id=id;
      await adminApi('/api/admin/software-products',{method:id?'PATCH':'POST',body:JSON.stringify(payload)});
      resetSoftwareProductForm();softwareProductMessage.textContent='Software listing saved.';await loadSoftwareProducts();
    }catch(error){softwareProductMessage.textContent=error.message;softwareProductMessage.classList.add('admin-error');}
    finally{button.disabled=false;}
  });


  let adminRequestRows = [];
  function setFolderBadge(key, count) {
    const value=Math.max(0,Number(count)||0);
    document.querySelectorAll('[data-admin-folder-badge="'+key+'"]').forEach(function(b){b.textContent=value>99?'99+':String(value);b.hidden=value===0;});
  }
  function updateAdminFolderBadges() {
    const pendingOrders=orders.filter(function(o){return ['New','File Review','Processing','Payment Pending'].includes(o.status)||o.payment_status==='PENDING';}).length;
    const openRequests=adminRequestRows.filter(function(r){return ['open','in_review','waiting_for_customer'].includes(r.status||'open');}).length;
    const adItems=document.querySelectorAll('#advertising-inquiry-list .admin-order-card').length;
    const softwareItems=document.querySelectorAll('#software-product-list .admin-order-card').length;
    setFolderBadge('orders',pendingOrders);setFolderBadge('advertising',adItems);setFolderBadge('software',softwareItems);setFolderBadge('requirements',openRequests);setFolderBadge('notifications',pendingOrders+adItems+openRequests);
    const list=document.querySelector('#admin-notifications-list');if(!list)return;list.replaceChildren();
    [['orders','Customer orders awaiting work',pendingOrders],['advertising','Advertising enquiries to review',adItems],['requirements','Open customer requirements',openRequests]].forEach(function(entry){
      const row=document.createElement('button');row.type='button';row.className='admin-notification-row';const label=document.createElement('span');label.textContent=entry[1];const count=document.createElement('strong');count.textContent=String(entry[2]);row.append(label,count);
      row.addEventListener('click',function(){const target=document.querySelector('[data-admin-folder="'+entry[0]+'"]');if(target){target.open=true;target.scrollIntoView({behavior:'smooth',block:'start'});}});list.append(row);
    });
    if(!pendingOrders&&!adItems&&!openRequests){const empty=document.createElement('p');empty.className='muted';empty.textContent='No pending items are currently counted. Refresh each folder to check again.';list.append(empty);}
  }
  function setupAdminFolders() {
    const dashboard=document.querySelector('#admin-dashboard');if(!dashboard||dashboard.dataset.folderized==='true')return;
    const title=dashboard.querySelector('.admin-title');if(!title)return;dashboard.dataset.folderized='true';
    const nav=document.createElement('nav');nav.className='admin-folder-nav';nav.setAttribute('aria-label','Admin workspace folders');
    const grid=document.createElement('div');grid.className='admin-folder-grid';
    const requests=document.createElement('section');requests.className='pricing-settings admin-customer-requests';
    requests.innerHTML='<div><span class="form-kicker">CUSTOMER INBOX</span><h2>Customer requirements</h2><p>Private requests from customers. Only authorized administrators can review and reply.</p></div><p id="admin-customer-requests-message" class="admin-message" role="status">Loading customer requirements…</p><div id="admin-customer-requests-list" class="admin-order-list"></div>';
    const notifications=document.createElement('section');notifications.className='admin-notifications-panel';
    notifications.innerHTML='<span class="form-kicker">WORK QUEUE</span><h2>Notifications & pending work</h2><p>Counts summarize current pending queues. Open a folder to review the actual records.</p><div id="admin-notifications-list" class="admin-notifications-list"></div>';
    const defs=[{key:'orders',title:'Customer Orders',nodes:[]},{key:'advertising',title:'Announcements & Advertising',nodes:[]},{key:'software',title:'Software Store',nodes:[]},{key:'requirements',title:'Customer Requirements',nodes:[requests]},{key:'settings',title:'Pricing & Website Settings',nodes:[]},{key:'notifications',title:'Notifications',nodes:[notifications]}];
    const pick=function(selector){return dashboard.querySelector(selector);};
    defs.find(x=>x.key==='orders').nodes=[pick('.admin-dashboard-controls'),...Array.from(dashboard.querySelectorAll('.admin-analytics-section')),pick('#orders-message'),pick('#order-list')].filter(Boolean);
    defs.find(x=>x.key==='advertising').nodes=[pick('[aria-labelledby="site-content-title"]')].filter(Boolean);
    defs.find(x=>x.key==='software').nodes=[pick('[aria-labelledby="software-products-title"]')].filter(Boolean);
    defs.find(x=>x.key==='settings').nodes=[pick('[aria-labelledby="pricing-settings-title"]'),pick('[aria-labelledby="public-contact-title"]')].filter(Boolean);
    defs.forEach(function(def){
      const details=document.createElement('details');details.className='admin-folder';details.dataset.adminFolder=def.key;details.open=def.key==='orders';
      const summary=document.createElement('summary');const label=document.createElement('span');label.className='admin-folder-title';label.textContent=def.title;
      const badge=document.createElement('span');badge.className='admin-folder-badge';badge.dataset.adminFolderBadge=def.key;badge.hidden=true;badge.textContent='0';summary.append(label,badge);details.append(summary);
      const content=document.createElement('div');content.className='admin-folder-content';details.append(content);def.nodes.forEach(function(node){content.append(node);});grid.append(details);
      const shortcut=document.createElement('button');shortcut.type='button';shortcut.className='admin-folder-shortcut';shortcut.dataset.adminFolderOpen=def.key;
      const shortcutLabel=document.createElement('span');shortcutLabel.textContent=def.title;const shortcutBadge=document.createElement('span');shortcutBadge.className='admin-folder-badge';shortcutBadge.dataset.adminFolderBadge=def.key;shortcutBadge.hidden=true;shortcutBadge.textContent='0';shortcut.append(shortcutLabel,shortcutBadge);
      shortcut.addEventListener('click',function(){details.open=true;details.scrollIntoView({behavior:'smooth',block:'start'});});nav.append(shortcut);
    });
    title.after(nav,grid);updateAdminFolderBadges();
  }
  async function loadAdminCustomerRequests() {
    const list=document.querySelector('#admin-customer-requests-list'),status=document.querySelector('#admin-customer-requests-message');if(!list||!status)return;
    let archiveToggle=document.querySelector('#admin-customer-requests-archive-toggle');
    if(!archiveToggle){archiveToggle=document.createElement('button');archiveToggle.id='admin-customer-requests-archive-toggle';archiveToggle.type='button';archiveToggle.className='button button-ghost';list.parentElement.insertBefore(archiveToggle,list);archiveToggle.addEventListener('click',function(){showArchivedCustomerRequests=!showArchivedCustomerRequests;loadAdminCustomerRequests();});}
    archiveToggle.textContent=showArchivedCustomerRequests?'Show active requests':'Show archived requests';
    status.classList.remove('admin-error');status.textContent='Loading customer requirements…';
    try{
      const archiveFilter=showArchivedCustomerRequests?'not.is.null':'is.null';
      const rows=await backend.rest(`forum_customer_requests?select=id,user_id,request_type,title,body,status,admin_reply,software_product_id,software_status,quoted_price_paise,software_payment_link,software_delivery_url,created_at,updated_at,admin_archived_at&admin_archived_at=${archiveFilter}&order=created_at.asc&limit=200`);
      adminRequestRows=Array.isArray(rows)?rows:[];list.replaceChildren();
      if(!adminRequestRows.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='No customer requirements have been submitted yet.';list.append(empty);}
      adminRequestRows.forEach(function(row){
        const card=document.createElement('article');card.className='admin-order-card admin-request-card';
        const type=document.createElement('span');type.className='form-kicker';type.textContent=({suggestion:'SUGGESTION / GENERAL',service_requirement:'SERVICE REQUIREMENT',feature_request:'WEBSITE FEATURE',software_requirement:'SOFTWARE REQUIREMENT',wiring_diagram:'WIRING DIAGRAM',issue:'CUSTOMER ISSUE',other:'OTHER'})[row.request_type]||'CUSTOMER REQUEST';
        const heading=document.createElement('h3');heading.textContent=row.title||'Customer request';if(['open','in_review'].includes(String(row.status||'open'))){const badge=document.createElement('span');badge.className='admin-folder-badge';badge.textContent='ACTION REQUIRED';badge.setAttribute('aria-label','Request needs admin review');card.append(badge);}
        const meta=document.createElement('p');meta.textContent='Request '+String(row.id||'').slice(0,8)+' · '+new Date(row.created_at).toLocaleString('en-IN')+' · '+String(row.status||'open').replace(/_/g,' ');
        const body=document.createElement('p');body.className='admin-request-body';body.textContent=row.body||'';
        const reply=document.createElement('textarea');reply.maxLength=4000;reply.rows=3;reply.className='admin-request-reply';reply.placeholder='Private reply to customer';reply.value=row.admin_reply||'';
        const isSoftware=row.request_type==='software_requirement'&&Boolean(row.software_product_id);
        const softwareFields=[];
        let softwareStatus, quotePrice, paymentLink, deliveryLink;
        if(isSoftware){
          const field=(label,type,value,placeholder)=>{const wrap=document.createElement('label');wrap.textContent=label;const input=document.createElement('input');input.type=type;input.value=value||'';input.placeholder=placeholder||'';wrap.append(input);softwareFields.push(wrap);return input;};
          softwareStatus=document.createElement('select');[['requested','Request received'],['in_review','Under review'],['quoted','Price quote ready'],['awaiting_payment','Payment required — send Pay now link'],['paid','Payment verified'],['delivered','Download available'],['cancelled','Cancelled']].forEach(([v,label])=>{const o=document.createElement('option');o.value=v;o.textContent=label;softwareStatus.append(o);});softwareStatus.value=row.software_status||'requested';
          quotePrice=field('Quoted price (INR)','number',row.quoted_price_paise==null?'':(Number(row.quoted_price_paise)/100).toFixed(2),'e.g. 11999.00');quotePrice.min='0';quotePrice.step='0.01';
          paymentLink=field('Payment link (HTTPS)','url',row.software_payment_link,'https://…');
          deliveryLink=field('Software download / delivery link (HTTPS)','url',row.software_delivery_url,'https://…');
        }
        const statusSelect=document.createElement('select');statusSelect.className='admin-request-status';['open','in_review','waiting_for_customer','resolved','closed'].forEach(function(value){const option=document.createElement('option');option.value=value;option.textContent=value.replace(/_/g,' ');statusSelect.append(option);});statusSelect.value=row.status||'open';
        if(isSoftware){statusSelect.setAttribute('aria-label','Request status (synced from software order status)');statusSelect.disabled=true;statusSelect.title='Automatically follows the software order workflow below.';}
        const save=document.createElement('button');save.type='button';save.className='button button-dark';save.textContent='Save reply & status';
        const archive=document.createElement('button');archive.type='button';archive.className='button button-ghost';archive.textContent=row.admin_archived_at?'Restore request':'Archive request';archive.addEventListener('click',async function(){archive.disabled=true;const wasArchived=Boolean(row.admin_archived_at);try{await backend.rest('rpc/efsi_admin_archive_customer_request',{method:'POST',body:{p_request_id:row.id,p_archived:!wasArchived}});await loadAdminCustomerRequests();status.textContent=wasArchived?'Request restored to active list.':'Request archived. Customer replies and audit history are retained.';}catch(error){status.textContent='Archive update failed: '+(error.message||'Please retry.');status.classList.add('admin-error');archive.disabled=false;}});
        save.addEventListener('click',async function(){save.disabled=true;status.textContent='Saving private reply…';status.classList.remove('admin-error');try{const patch={admin_reply:reply.value.trim(),status:statusSelect.value,updated_at:new Date().toISOString()};if(isSoftware){const priceText=String(quotePrice.value||'').trim();if(priceText&&!/^\\d+(?:\\.\\d{1,2})?$/.test(priceText))throw new Error('Enter a valid quote price.');const toPaise=priceText?Math.round(Number(priceText)*100):null;for(const [label,value] of [['Payment link',paymentLink.value],['Delivery link',deliveryLink.value]])if(value){const url=new URL(value);if(url.protocol!=='https:')throw new Error(label+' must use HTTPS.');}patch.software_status=softwareStatus.value;patch.quoted_price_paise=toPaise;patch.software_payment_link=paymentLink.value.trim()||null;patch.software_delivery_url=deliveryLink.value.trim()||null;if(['quoted','awaiting_payment','paid','delivered'].includes(softwareStatus.value)&&!(toPaise>0))throw new Error('Enter the confirmed software price before this status.');if(['awaiting_payment','paid','delivered'].includes(softwareStatus.value)&&!patch.software_payment_link)throw new Error('Add the official payment link before this status.');if(softwareStatus.value==='delivered'&&!patch.software_delivery_url)throw new Error('Add the secure software download/delivery link before marking Delivered.');if(softwareStatus.value==='delivered'&&row.software_status!=='paid'&&row.software_status!=='delivered')throw new Error('Mark the request Paid only after verifying payment, then add the download link.');patch.status=softwareStatus.value==='awaiting_payment'?'waiting_for_customer':softwareStatus.value==='delivered'?'resolved':softwareStatus.value==='cancelled'?'closed':softwareStatus.value==='requested'?'open':'in_review';}await backend.rest('forum_customer_requests?id=eq.'+encodeURIComponent(row.id),{method:'PATCH',body:patch,prefer:'return=minimal'});status.textContent='Private reply saved.';await loadAdminCustomerRequests();}catch(error){status.textContent=error.message||'Could not save the reply.';status.classList.add('admin-error');}finally{save.disabled=false;}});
        if(isSoftware){const workflow=document.createElement('div');workflow.className='admin-software-request-fields';workflow.style.cssText='display:grid;gap:10px;padding:12px;border:1px solid #dce4d8;background:#f6f8f2;margin:10px 0';const label=document.createElement('label');label.textContent='Software order status';label.append(softwareStatus);workflow.append(label,...softwareFields);card.append(workflow);}if(isSoftware){card.append(type,heading,meta,body,reply,save,archive);}else{card.append(type,heading,meta,body,reply,statusSelect,save,archive);}list.append(card);
      });
      updateAdminFolderBadges();
    }catch(error){adminRequestRows=[];list.replaceChildren();const empty=document.createElement('p');empty.className='admin-message admin-error';empty.textContent='Customer requests could not load. Apply the forum live desk migration after reviewing it, then refresh.';list.append(empty);status.textContent=error.message||'Request inbox unavailable.';status.classList.add('admin-error');updateAdminFolderBadges();}
  }

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
    setupAdminFolders();
    await loadPricing();
    await loadOrders();
    await loadAdvertisingInquiries();
    await loadAdvertisingQuotes();
    await loadSiteContent();
    await loadSoftwareProducts();
    await loadAdminCustomerRequests();
    await loadPublicContactSettings();
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
