// オフライン対応用 Service Worker。ファイルを更新したら VERSION を上げる。
const VERSION = 'fm-v4';
const CORE = ['./', 'index.html', 'style.css', 'app.css', 'app.js', 'geometry.js', 'imageinfo.js', 'integrity.js', 'guard.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const HEAVY = ['face-api.js', 'ssd_mobilenetv1_model-weights_manifest.json', 'ssd_mobilenetv1_model.bin'];
const isHeavy = (url) => HEAVY.some((f) => url.endsWith('/' + f));

self.addEventListener('install', (e) => {
  // skipWaiting は使わない：開いているタブが新旧のファイルを混在して読むのを避ける（次回起動時に切り替わる）
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(CORE);
    await Promise.allSettled(HEAVY.map((u) => c.add(u)));   // 失敗しても導入は継続（初回利用時にキャッシュされる）
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const bypass = req.cache === 'reload' || req.cache === 'no-store';   // アプリ側が「取り直し」を求めたとき
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit && isHeavy(req.url) && !bypass) return hit;                // 重い資源はキャッシュ優先
    const net = fetch(req).then((res) => {
      if (res.ok && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());   // 正常な同一オリジン応答のみ保存
      return res;
    });
    if (hit && !bypass) { net.catch(() => {}); return hit; }           // その他は即表示しつつ裏で更新
    try { return await net; }
    catch {
      if (hit) return hit;
      if (req.mode === 'navigate') return (await cache.match('index.html')) || Response.error();   // 画面遷移のみ index に退避
      return Response.error();                                         // JS/CSS 等に HTML を返して壊さない
    }
  })());
});
