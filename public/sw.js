/* =========================================================
   Service Worker（P2-17 离线可用）
   策略：
   - 静态外壳（index.html / style.css / app.js / 图标）→ stale-while-revalidate
     先给缓存保证秒开，后台拉新版；带 ?v= 的资源版本变化会自然产生新缓存键。
   - /api/* → network only。业务数据不做离线缓存，避免展示过期项目/任务造成误判；
     断网时返回明确的 503 JSON，前端 toast 提示而不是静默失败。
   - 不缓存 /api、/brand-logo.png（会随上传变化）、导出下载类响应。
   ========================================================= */
const CACHE = 'kanban-shell-v1';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/wb-logo.png', '/app.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // 写操作一律直连
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // 只接管同源
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(req).catch(() => new Response(
        JSON.stringify({ error: '当前离线，无法访问服务器数据' }),
        { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      ))
    );
    return;
  }
  if (url.pathname === '/brand-logo.png') return;         // 随上传变化，不缓存

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: false });
    const net = fetch(req).then(r => {
      if (r && r.ok && r.type !== 'opaque') cache.put(req, r.clone()).catch(() => {});
      return r;
    }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }            // 缓存优先，后台更新
    const r = await net;
    if (r) return r;
    const shell = await cache.match('/index.html');       // 离线且无缓存 → 回退外壳
    return shell || new Response('离线且无缓存内容', { status: 504, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});
