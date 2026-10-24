self.addEventListener('install', e => {
  e.waitUntil(caches.open('daftari-v1').then(c => c.addAll(['/'])));
});
self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
