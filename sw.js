const CACHE_NAME = 'denik-udrzbare-v6.83';
const CORE_ASSETS = [
  './',
  './index.html',
  './app.jsx',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];
// Pre-fetched on install so icons/fonts work offline from the very first launch,
// not just after the first successful online request.
const CDN_ASSETS = [
  'https://unpkg.com/@phosphor-icons/web@2.1.2/src/regular/style.css',
  'https://unpkg.com/@phosphor-icons/web@2.1.2/src/regular/Phosphor.woff2',
  'https://unpkg.com/@phosphor-icons/web@2.1.2/src/bold/style.css',
  'https://unpkg.com/@phosphor-icons/web@2.1.2/src/bold/Phosphor-Bold.woff2',
  'https://unpkg.com/@phosphor-icons/web@2.1.2/src/fill/style.css',
  'https://unpkg.com/@phosphor-icons/web@2.1.2/src/fill/Phosphor-Fill.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(CORE_ASSETS)
        .then(() => Promise.allSettled(CDN_ASSETS.map((url) => cache.add(url))))
    ).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Network-first for external CDN assets (React/Babel/fonts/icons) so updates
  // land when online, falling back to cache when offline.
  const cdnHosts = ['https://unpkg.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net', 'https://www.gstatic.com'];
  if (cdnHosts.includes(url.origin)) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Stale-while-revalidate pro lokální app shell (index.html, app.jsx,
  // manifest...) — appka okamžitě odpoví z cache, ať appka naskočí bez
  // čekání na síť, a zároveň na pozadí stáhne čerstvou verzi pro příště.
  // Appka's "probliknutí staré verze" tu nehrozí: index.html už má vlastní
  // mechanismus (registration.update() + controllerchange → reload()),
  // který appku sám obnoví, jakmile se nová verze aktivuje — takže appka
  // nemusí čekat na síť už při prvním vykreslení, jen při zjištění, že je
  // dostupná novější verze.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(event.request).then((cached) => {
          const network = fetch(event.request).then((res) => {
            cache.put(event.request, res.clone());
            return res;
          }).catch(() => cached);
          return cached || network;
        })
      )
    );
  }
});
