const CACHE_NAME='ecufileservice-pwa-v5';
const APP_SHELL=['/','/index.html','/manifest.json','/app-icon-192.svg','/app-icon-512.svg','/styles.css','/app.js','/auth.js','/supabase.js'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('ecufileservice-pwa-')&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  if(url.pathname==='/auth.js'){
    event.respondWith(fetch(request,{cache:'no-store'}).then(response=>{
      if(response.ok)caches.open(CACHE_NAME).then(cache=>cache.put(request,response.clone()));
      return response;
    }).catch(()=>caches.match(request,{ignoreSearch:true})));
    return;
  }
  if(request.mode==='navigate'){
    event.respondWith(fetch(request).then(response=>{
      if(response.ok&&(url.pathname==='/'||url.pathname==='/index.html'))caches.open(CACHE_NAME).then(cache=>cache.put('/index.html',response.clone()));
      return response;
    }).catch(async()=>{
      if(url.pathname==='/'||url.pathname==='/index.html')return (await caches.match('/index.html'))||Response.error();
      return new Response('You are offline. Reconnect to open this page.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
    }));
    return;
  }
  if(/\.(?:css|js|svg|json)$/.test(url.pathname)){
    event.respondWith(caches.match(request,{ignoreSearch:true}).then(cached=>cached||fetch(request).then(response=>{
      if(response.ok)caches.open(CACHE_NAME).then(cache=>cache.put(request,response.clone()));
      return response;
    })));
  }
});
