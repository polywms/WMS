const CACHE_NAME = 'wms-v6-cache-v9';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './icon.png'
];

// Install Service Worker dan simpan file ke cache
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
});

// Intercept request internet, gunakan Network-First strategy
self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Kalau berhasil ditarik dari file asli/internet, update cachenya
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseClone);
        });
        return response;
      })
      .catch(() => {
        // Kalau offline atau gagal fetch, baru panggil file lama dari cache
        return caches.match(event.request);
      })
  );
});
