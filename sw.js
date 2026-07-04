const CACHE='ichtus-v2';
const OFFLINE_URLS=['/','index.html'];

self.addEventListener('install',e=>{
  e.waitUntil(
    caches.open(CACHE).then(c=>c.addAll(OFFLINE_URLS).catch(()=>{}))
  );
  self.skipWaiting();
});

self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(
      keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const url=e.request.url;
  if(url.includes('firestore.googleapis.com')||url.includes('googleapis.com')||url.includes('firebase'))return;
  e.respondWith(
    fetch(e.request).then(r=>{
      const clone=r.clone();
      caches.open(CACHE).then(c=>c.put(e.request,clone)).catch(()=>{});
      return r;
    }).catch(()=>
      caches.match(e.request).then(r=>r||new Response('Application hors-ligne',{status:503,headers:{'Content-Type':'text/plain;charset=utf-8'}}))
    )
  );
});

self.addEventListener('push',e=>{
  const data=e.data?.json()||{title:'ICHTUS ERP',body:'Notification'};
  e.waitUntil(
    self.registration.showNotification(data.title||'ICHTUS ERP',{
      body:data.body||'',
      tag:data.tag||'ichtus',
    })
  );
});
