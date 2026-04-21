const CACHE_NAME = 'wms-cache-v20';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './version.json'
];

// Handle version update messages from client
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// 1. Install event - cache assets
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache v16');
        return cache.addAll(urlsToCache);
      })
  );
});

// 2. Hapus cache versi lama agar tidak nyangkut
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('Menghapus cache lama:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim(); // Ambil alih kontrol browser secepatnya
});

// 3. Intercept request internet
self.addEventListener('fetch', event => {
  // PENGECUALIAN 1: Jangan pernah sentuh URL API Google!
  if (event.request.url.includes('script.google.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // PENGECUALIAN 2: Service Worker (Cache) HANYA mendukung metode GET. 
  // Biarkan POST (Kirim Data) lewat begitu saja.
  if (event.request.method !== 'GET') {
    event.respondWith(fetch(event.request));
    return;
  }

  // Special handling: version.json always checks network first
  if (event.request.url.endsWith('version.json')) {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok) {
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, response.clone());
          });
        }
        return response;
      }).catch(() => {
        return caches.match(event.request);
      })
    );
    return;
  }

  // STRATEGI UTAMA: Network-First untuk HTML/CSS/JS
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Kalau berhasil ditarik dari internet, update cachenya
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseClone);
        });
        return response;
      })
      .catch(() => {
        // Kalau offline (tidak ada internet), pakai file dari cache
        return caches.match(event.request);
      })
  );
});
