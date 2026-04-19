// ════════════════════════════════════════════════════════
// sw.js — Service Worker
// Cache-shell strategi: cacher app-skallet (HTML, CSS, JS)
// for rask oppstart. Firebase/Firestore-kall går alltid
// direkte til nett — aldri fra cache.
// ════════════════════════════════════════════════════════

const CACHE_NAVN = 'pb-jaeren-v1';

const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './state.js',
  './firebase.js',
  './rotasjon.js',
  './rating.js',
  './ui.js',
  './admin.js',
  './logo.svg',
  './icon-192.png',
  './icon-512.png',
];

// ── INSTALL — cach app-skallet ──────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAVN).then(cache => cache.addAll(SHELL))
  );
  // Ikke skipWaiting() automatisk — vent til brukeren godkjenner
  // via oppdateringsbannneret i index.html
});

// ── MESSAGE — brukeren trykket "Last på nytt" ───────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── ACTIVATE — rydd opp gamle cacher ───────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAVN)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── FETCH — cache-first for shell, nett-first for alt annet ──
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // La Firebase, Firestore og Google Fonts alltid gå til nett
  const erEkstern =
    url.hostname.includes('firebase') ||
    url.hostname.includes('firestore') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('gstatic') ||
    url.hostname.includes('fonts.g');

  if (erEkstern) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Cache-first for lokale filer
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        // Cache kun gyldige GET-svar
        if (
          e.request.method === 'GET' &&
          response.status === 200
        ) {
          const kopi = response.clone();
          caches.open(CACHE_NAVN).then(cache =>
            cache.put(e.request, kopi)
          );
        }
        return response;
      });
    })
  );
});
