/* 福州带娃指南 · Service Worker —— 让页面可「安装到主屏幕」并支持离线打开首页骨架 */
const CACHE = 'fz-guide-v1';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

// 不缓存、直接放行的请求（实时后端 API / GitHub 源）
function isPassthrough(url){
  return /app\.workbuddy\.host|api\.github\.com|raw\.githubusercontent/.test(url.hostname);
}
// 可走缓存的第三方静态资源（如 unpkg 上的高德/leaflet 库）
function isCacheableCross(url){
  return /unpkg\.com|cdnjs\.cloudflare\.com|jsdelivr\.net/.test(url.hostname);
}

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE).catch(()=>{})).then(()=>self.skipWaiting()));
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch', e=>{
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(isPassthrough(url)) return; // 实时数据/源站，交给网络

  // 页面导航：网络优先，失败回退缓存首页（离线可开）
  if(req.mode === 'navigate'){
    e.respondWith(
      fetch(req).catch(()=>caches.match('./index.html').then(r=>r||caches.match('./')))
    );
    return;
  }

  // 同源与可缓存第三方：先缓存，再后台更新（stale-while-revalidate）
  if(url.origin === self.location.origin || isCacheableCross(url)){
    e.respondWith(
      caches.match(req).then(cached=>{
        const net = fetch(req).then(res=>{
          if(res && res.ok) caches.open(CACHE).then(c=>c.put(req, res.clone()));
          return res;
        }).catch(()=>cached);
        return cached || net;
      })
    );
  }
});
