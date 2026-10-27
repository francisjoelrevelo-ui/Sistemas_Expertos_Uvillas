/* =====================================================================
 * UvillaDx - Service Worker
 * Estrategias:
 *  - App shell (HTML, JS, JSON, íconos): precache + "stale-while-revalidate".
 *  - Librerías CDN (Tailwind, TensorFlow.js): cache-first con actualización.
 *  - Modelos de Teachable Machine (model.json, *.bin, metadata.json):
 *    cache-first, para poder inferir sin conexión una vez descargados.
 *  - Navegación sin red: se responde con index.html desde la caché.
 *  - Background Sync: avisa a la app para vaciar la cola de sincronización.
 * ===================================================================== */

const VERSION = 'uvilladx-v1.0.0';
const CACHE_SHELL = `${VERSION}-shell`;
const CACHE_CDN = `${VERSION}-cdn`;
const CACHE_MODELOS = 'uvilladx-modelos'; // sin versión: los modelos sobreviven a actualizaciones

// Recursos propios que componen la aplicación
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './knowledgeBase.json',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Librerías externas (versiones fijas para que la caché sea estable)
const CDN_ASSETS = [
  'https://cdn.tailwindcss.com/3.4.16',
  'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js'
];

/* ---------- Instalación: precache del shell y de las librerías ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(CACHE_SHELL);
    await shell.addAll(APP_SHELL);

    // Las librerías CDN se cachean una a una: si alguna falla no se aborta la instalación
    const cdn = await caches.open(CACHE_CDN);
    await Promise.all(CDN_ASSETS.map(async (url) => {
      try {
        const resp = await fetch(url, { mode: 'cors' });
        if (resp.ok) await cdn.put(url, resp);
      } catch (e) {
        console.warn('[SW] No se pudo precachear', url, e);
      }
    }));

    await self.skipWaiting();
  })());
});

/* ---------- Activación: limpieza de cachés antiguas ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k !== CACHE_SHELL && k !== CACHE_CDN && k !== CACHE_MODELOS)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* ---------- Utilidades de estrategia ---------- */
function esModelo(url) {
  return /model\.json$|metadata\.json$|\.bin$/i.test(url.pathname) ||
         url.hostname.includes('teachablemachine.withgoogle.com') ||
         url.hostname.includes('storage.googleapis.com');
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const resp = await fetch(request);
  if (resp && (resp.ok || resp.type === 'opaque')) cache.put(request, resp.clone());
  return resp;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((resp) => {
      if (resp && resp.ok) cache.put(request, resp.clone());
      return resp;
    })
    .catch(() => null);
  return cached || (await network) || new Response('Sin conexión', { status: 503 });
}

/* ---------- Intercepción de peticiones ---------- */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // POST de sincronización pasa directo a la red

  const url = new URL(request.url);

  // 1) Navegación: red primero, si falla se sirve index.html cacheado
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const resp = await fetch(request);
        const cache = await caches.open(CACHE_SHELL);
        cache.put('./index.html', resp.clone());
        return resp;
      } catch {
        return (await caches.match('./index.html')) || new Response('Sin conexión', { status: 503 });
      }
    })());
    return;
  }

  // 2) Modelos de Teachable Machine: cache-first (permite inferencia offline)
  if (esModelo(url)) {
    event.respondWith(cacheFirst(request, CACHE_MODELOS));
    return;
  }

  // 3) Librerías CDN: cache-first
  if (url.origin !== self.location.origin) {
    event.respondWith(cacheFirst(request, CACHE_CDN).catch(() => new Response('', { status: 503 })));
    return;
  }

  // 4) Recursos propios: stale-while-revalidate
  event.respondWith(staleWhileRevalidate(request, CACHE_SHELL));
});

/* ---------- Background Sync: pide a la app que sincronice la cola ---------- */
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-diagnosticos') {
    event.waitUntil((async () => {
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      clients.forEach((c) => c.postMessage({ tipo: 'SYNC_SOLICITADA' }));
    })());
  }
});

/* ---------- Mensajes desde la app ---------- */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.tipo === 'SKIP_WAITING') self.skipWaiting();
  if (data.tipo === 'CACHEAR_MODELO' && Array.isArray(data.urls)) {
    // Permite a la app forzar el cacheo de un modelo remoto para uso offline
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE_MODELOS);
      for (const u of data.urls) {
        try { await cache.add(u); } catch (e) { console.warn('[SW] Modelo no cacheado', u, e); }
      }
    })());
  }
});
