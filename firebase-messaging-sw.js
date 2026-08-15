// firebase-messaging-sw.js — v87.13
// Deploy this file to the ROOT of your Netlify site (same level as index.html).
// It must be reachable at: https://your-site.netlify.app/firebase-messaging-sw.js
//
// v87.13 CHANGES:
//   1. Added messaging.onBackgroundMessage() — without this, background pushes
//      produce no visible notification in Chrome desktop or installed PWA.
//      The Firebase SDK auto-displays when a `notification` key is present in
//      the FCM message, but without onBackgroundMessage defined, the icon,
//      badge, tag, and click-action all fall back to Chrome defaults (which
//      on desktop Chrome often means nothing visible at all).
//   2. Added `notificationclick` event handler — without this, tapping/clicking
//      a notification does nothing. Handler focuses an existing app window or
//      opens a new one.
//
// IMPORTANT: if the fcm-send edge function sends data-only payloads
// (no `notification` key at the top of the FCM message object), then
// onBackgroundMessage MUST call self.registration.showNotification() —
// the SDK does NOT auto-display data-only messages. The handler below
// always calls showNotification() explicitly to cover both cases.

importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            "AIzaSyC8csUtOBd8GY6vK3QmZXB1kjY46ijj8yw",
  authDomain:        "jsjc-booking-app.firebaseapp.com",
  projectId:         "jsjc-booking-app",
  storageBucket:     "jsjc-booking-app.firebasestorage.app",
  messagingSenderId: "92282421131",
  appId:             "1:92282421131:web:f08880ca301ef1afbcf98e"
});

const messaging = firebase.messaging();

// ── Background message handler ─────────────────────────────────────────────
// Fires when a push arrives while the app is closed, backgrounded, or the
// browser tab is not focused. For notification-type messages (with a
// `notification` key), the Firebase SDK would auto-display — but we define
// this handler anyway so we control the icon, badge, tag, and click data.
// For data-only messages (no `notification` key), this is the ONLY place a
// notification can be shown for background delivery.
messaging.onBackgroundMessage(function(payload) {
  console.log('[SW] Background message received:', payload);

  const title = (payload.notification && payload.notification.title)
             || (payload.data        && payload.data.title)
             || 'JSJC Booking Update';

  const body  = (payload.notification && payload.notification.body)
             || (payload.data        && payload.data.body)
             || '';

  const appUrl = self.location.origin;

  return self.registration.showNotification(title, {
    body:               body,
    icon:               '/icon-192.png',
    badge:              '/icon-72.png',
    tag:                'jsjc-bg',          // collapses duplicate pushes
    requireInteraction: false,
    data: {
      url:  appUrl,
      type: (payload.data && payload.data.type) || 'booking'
    }
  });
});

// ── Notification click handler ─────────────────────────────────────────────
// Fires when the user taps/clicks a notification shown by this SW.
// Closes the notification, then either focuses an existing open app window
// or opens a new one.
self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  var target = (event.notification.data && event.notification.data.url)
             || self.location.origin;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      // Focus an existing window if one is open at the target URL
      for (var i = 0; i < list.length; i++) {
        var client = list[i];
        if (client.url === target && 'focus' in client) {
          return client.focus();
        }
      }
      // No existing window — open a new one
      if (clients.openWindow) {
        return clients.openWindow(target);
      }
    })
  );
});
