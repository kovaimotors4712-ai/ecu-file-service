(function(){
  'use strict';
  const backend=window.EfsiSupabase;
  if(!backend)return;
  const login=document.querySelector('#moderator-login');
  const denied=document.querySelector('#moderator-denied');
  const dashboard=document.querySelector('#moderator-dashboard');
  const message=document.querySelector('#moderator-auth-message');
  const list=document.querySelector('#moderation-list');
  const status=document.querySelector('#moderation-message');
  const audit=document.querySelector('#moderation-audit-list');
  const filter=document.querySelector('#moderation-filter');
  const search=document.querySelector('#moderation-search');
  const signout=document.querySelector('#moderator-signout');
  let items=[];
  function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  async function request(method='GET',body=null){
    const token=await backend.getAccessToken();
    if(!token)throw new Error('Your session has expired. Please sign in again.');
    const url='/api/admin/moderation'+(method==='GET'?'?type='+encodeURIComponent(filter.value||'all')+'&limit=60':'');
    const response=await fetch(url,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const raw=await response.text();let result={};try{result=raw?JSON.parse(raw):{};}catch{}
    if(!response.ok)throw new Error(result.error||'Moderation request failed.');
    return result;
  }
  function enterDenied(text){login.hidden=true;dashboard.hidden=true;denied.hidden=false;document.querySelector('#moderator-denied-message').textContent=text;signout.hidden=false;}
  async function enter(){
    const session=backend.getSession();
    if(!session?.user){login.hidden=false;dashboard.hidden=true;denied.hidden=true;signout.hidden=true;return;}
    const role=session.user.app_metadata?.role;
    if(!['admin','moderator'].includes(role)){enterDenied('Your account does not have an authorized moderation role.');return;}
    login.hidden=true;denied.hidden=true;dashboard.hidden=false;signout.hidden=false;
    await load();
  }
  function preview(item){return [item.title,item.name,item.body,item.description,item.reason,item.admin_note,item.city,item.state].filter(Boolean).join(' — ').slice(0,500);}
  function render(){
    const q=(search.value||'').trim().toLowerCase();
    const filtered=items.filter(item=>!q||[item.title,item.name,item.body,item.description,item.reason,item.admin_note,item.city,item.state,item.id].some(v=>String(v||'').toLowerCase().includes(q)));
    if(!filtered.length){list.textContent='No matching moderation records found.';return;}
    list.innerHTML=filtered.map(item=>{
      const type=String(item.content_type||'');
      const id=esc(item.id);
      const hidden=item.is_hidden===true||item.status==='hidden'||(type==='forum_categories'&&item.is_active===false)||(type==='workshops'&&['suspended','rejected'].includes(item.status));
      const resolved=['resolved','dismissed'].includes(item.status);
      const label=esc(type.replaceAll('_',' '));
      const state=type==='forum_categories'?(item.is_active===false?'Inactive':'Active'):item.is_hidden?'Hidden':esc(item.status||'Visible');
      const canHide=['forum_categories','forum_topics','forum_replies','forum_chat_messages','workshop_reviews','workshops'].includes(type);
      const canEdit=['forum_categories','forum_topics','forum_replies','workshop_reviews'].includes(type);
      const action=type==='workshops'?(item.status==='approved'?'hide':hidden?'restore':'publish'):type==='workshop_reviews'&&item.status==='pending'?'publish':hidden?'restore':'hide';
      const actionLabel=action==='restore'?'Restore':action==='publish'?(type==='workshops'?'Approve':'Publish'):type==='workshops'?'Suspend':'Hide';
      let buttons='';
      if(canHide)buttons+='<button type="button" class="button button-ghost" data-action="'+action+'" data-type="'+esc(type)+'" data-id="'+id+'">'+actionLabel+'</button>';
      if(canEdit)buttons+='<button type="button" class="button button-ghost" data-action="edit" data-type="'+esc(type)+'" data-id="'+id+'">Edit</button>';
      if(type==='forum_reports'||type==='workshop_reports'){
        if(!resolved){if(type==='workshop_reports')buttons+='<button type="button" class="button button-ghost" data-action="investigate" data-type="'+esc(type)+'" data-id="'+id+'">Investigate</button>';buttons+='<button type="button" class="button button-ghost" data-action="resolve" data-type="'+esc(type)+'" data-id="'+id+'">Resolve</button><button type="button" class="button button-ghost" data-action="dismiss" data-type="'+esc(type)+'" data-id="'+id+'">Dismiss</button>';}
      }
      if(!['workshops','forum_categories'].includes(type))buttons+='<button type="button" class="button button-ghost" style="border-color:#b91c1c;color:#b91c1c" data-action="delete" data-type="'+esc(type)+'" data-id="'+id+'">Delete</button>';
      return '<article data-id="'+id+'" data-title="'+esc(item.title||'')+'" data-body="'+esc(item.body||item.description||'')+'" style="border:1px solid #dce3df;border-radius:10px;padding:14px;margin:10px 0;display:grid;gap:8px"><div style="display:flex;gap:10px;justify-content:space-between;flex-wrap:wrap"><strong>'+label+'</strong><span>'+esc(state)+'</span></div><p style="margin:0;white-space:pre-wrap;overflow-wrap:anywhere">'+esc(preview(item))+'</p><small>'+esc(item.created_at?new Date(item.created_at).toLocaleString():'')+' · ID: '+id+'</small><div style="display:flex;gap:8px;flex-wrap:wrap">'+buttons+'</div></article>';
    }).join('');
  }
  function renderAudit(rows){
    if(!rows?.length){audit.textContent='No recorded admin activity yet.';return;}
    audit.innerHTML=rows.map(item=>'<article style="border-bottom:1px solid #e2e8e4;padding:10px 4px;display:grid;gap:4px"><strong>'+esc(String(item.action||'Action').replaceAll('_',' '))+' · '+esc(String(item.target_type||'content').replaceAll('_',' '))+'</strong><small>'+esc(item.created_at?new Date(item.created_at).toLocaleString():'')+' · Staff ID: '+esc(item.actor_id||'')+'</small><small style="overflow-wrap:anywhere">'+esc(JSON.stringify(item.details||{}).slice(0,300))+'</small></article>').join('');
  }
  async function load(){
    list.textContent='Loading moderation records…';status.textContent='';
    try{const data=await request('GET');items=Array.isArray(data.items)?data.items:[];render();renderAudit(data.audit||[]);status.textContent='Loaded '+items.length+' records. Hidden content is retained for review and restoration.';}
    catch(error){list.textContent='Moderation records could not be loaded.';status.textContent=error.message;status.classList.add('admin-error');}
  }
  async function act(type,id,action,card){
    const body={type,id,action};
    if(action==='delete'){if(!confirm('Permanently delete this content? Related replies or reports may also be removed. This cannot be undone.'))return;body.confirmPermanentDelete=true;}
    if(action==='hide'&&!confirm('Hide this content from public visitors?'))return;
    if(action==='restore'&&!confirm('Restore this content to public view?'))return;
    if(action==='edit'){
      const next=prompt('Edit the content:',card?.dataset.body||'');if(next===null)return;
      if(['forum_categories','forum_topics','workshop_reviews'].includes(type)){const title=prompt('Edit the title:',card?.dataset.title||'');if(title===null)return;body.title=title;}
      body.body=next;
    }
    if(type==='workshop_reports'&&['resolve','dismiss','investigate'].includes(action)){const note=prompt('Optional moderation note:','');if(note===null)return;body.admin_note=note;}
    try{const result=await request('POST',body);status.textContent=action+' completed.'+(result.auditLogged===false?' Activity log could not be saved.':'');await load();}
    catch(error){status.textContent=error.message;status.classList.add('admin-error');}
  }
  list.addEventListener('click',event=>{
    const button=event.target.closest('button[data-action]');if(!button)return;
    const card=button.closest('article');button.disabled=true;
    act(button.dataset.type,button.dataset.id,button.dataset.action,card).finally(()=>{button.disabled=false;});
  });
  document.querySelector('#moderator-refresh').addEventListener('click',load);
  filter.addEventListener('change',load);
  search.addEventListener('input',render);
  document.querySelector('#moderator-auth').addEventListener('submit',async event=>{
    event.preventDefault();message.classList.remove('admin-error');message.textContent='Signing in…';
    try{await backend.signIn(document.querySelector('#moderator-email').value.trim(),document.querySelector('#moderator-password').value);document.querySelector('#moderator-password').value='';await enter();}
    catch(error){message.textContent=error.message||'Sign-in failed.';message.classList.add('admin-error');}
  });
  signout.addEventListener('click',async()=>{await backend.signOut();await enter();});
  enter().catch(error=>enterDenied(error.message||'Could not verify account access.'));
})();