// sw.js — Service worker for offline PWA support
const VERSION = 'toolbill-v7';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
const CDN = [
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js',
  'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
];

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Shell is required; CDN is best-effort (offline users might not hit it first time)
    await cache.addAll(APP_SHELL);
    await Promise.allSettled(CDN.map(url =>
      fetch(url, { mode: 'no-cors' }).then(r => cache.put(url, r)).catch(() => null)
    ));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

// Strategy:
//  - Same-origin GET: cache-first, fall back to network, cache new responses
//  - CDN GET: cache-first (updates only when VERSION bumps)
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreVary: true });
    if (cached) {
      // Revalidate in background for same-origin
      if (url.origin === location.origin) {
        fetch(req).then(res => {
          if (res && res.status === 200) cache.put(req, res.clone());
        }).catch(() => {});
      }
      return cached;
    }
    try {
      const res = await fetch(req);
      if (res && (res.status === 200 || res.type === 'opaque')) {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch (e) {
      // Final fallback for navigation requests
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw e;
    }
  })());
});
