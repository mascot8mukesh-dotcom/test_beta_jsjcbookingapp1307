/**
 * service-worker.js  —  JSJC Smart Booking App
 *
 * Handles ONLY offline caching / PWA installability.
 * Push notifications are handled by firebase-messaging-sw.js.
 *
 * Registered by the script at the bottom of index.html:
 *   navigator.serviceWorker.register('service-worker.js')
 *
 * Must live at the deployment root alongside index.html.
 */

'use strict';

var CACHE_NAME   = 'jsjc-shell-v87-11';
var OFFLINE_PAGE = './';

var PRECACHE_URLS = [
  './',
  './icon-192.png',
  './icon-512.png',
  './favicon.ico'
];

// ── Install — pre-cache app shell ─────────────────────────────────────────────

self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.allSettled(
        PRECACHE_URLS.map(function (url) {
          return cache.add(url).catch(function (err) {
            console.warn('[SW] Pre-cache skipped for', url, ':', err.message);
          });
        })
      );
    })
  );
});

// ── Activate — remove old caches ─────────────────────────────────────────────

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (k) { return k !== CACHE_NAME; })
          .map(function (k)   { return caches.delete(k); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// ── Fetch — network-first for navigation, cache-first for assets ──────────────

self.addEventListener('fetch', function (event) {
  var req = event.request;

  // Only handle GET requests from the same origin
  if (req.method !== 'GET') return;
  try {
    var url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
  } catch (_) { return; }

  // Navigation (main HTML): network first, fall back to cached shell
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(req, clone); });
          return res;
        })
        .catch(function () {
          return caches.match(OFFLINE_PAGE).then(function (cached) {
            return cached || new Response(
              '<h2 style="font-family:sans-serif;padding:2rem">JSJC Booking — Offline</h2>' +
              '<p style="font-family:sans-serif;padding:0 2rem">Please reconnect and reload.</p>',
              { headers: { 'Content-Type': 'text/html' } }
            );
          });
        })
    );
    return;
  }

  // Static assets: cache first, then network
  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        var clone = res.clone();
        caches.open(CACHE_NAME).then(function (c) { c.put(req, clone); });
        return res;
      });
    })
  );
});
