// HCPI PWA service worker
// 策略:HTML / API 走網路優先(確保拿到最新版,斷線時退回快取);圖示、字型、CDN 程式庫走快取優先。
const VERSION = 'hcpi-v1';
const SHELL = ['/app.html', '/inspection.html', '/operator-report.html', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Firebase / Google / Anthropic API 一律不快取
  if (/firestore|googleapis|firebaseapp|gstatic\.com\/firebasejs|accounts\.google|identitytoolkit|api\.qrserver/.test(url.host + url.pathname) || url.pathname.startsWith('/api/')) return;
  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return r; })
      .catch(() => caches.match(req).then(r => r || caches.match('/app.html'))));
    return;
  }
  // 其他靜態資源:快取優先,背景更新
  e.respondWith(caches.match(req).then(cached => {
    const net = fetch(req).then(r => { if (r && r.status === 200 && (url.origin === location.origin || /cdn\.jsdelivr|fonts\.gstatic|fonts\.googleapis|raw\.githubusercontent/.test(url.host))) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return r; }).catch(() => cached);
    return cached || net;
  }));
});
