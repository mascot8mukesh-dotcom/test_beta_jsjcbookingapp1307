/**
 * firebase-messaging-sw.js  —  JSJC Smart Booking App
 *
 * FCM background message handler. Must live at the deployment root.
 * For GitHub Pages at /repo/, deploy to /repo/firebase-messaging-sw.js.
 *
 * This file is registered by initFCM() in the app with:
 *   navigator.serviceWorker.register(swBase + 'firebase-messaging-sw.js', { scope: swBase })
 *
 * It handles push messages when the app tab is closed or in the background.
 * When the app tab is open, onMessage() in initFCM() handles foreground messages
 * instead — this file is NOT called for foreground pushes.
 */

'use strict';

importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

// ── Firebase config — must match FIREBASE_CONFIG in the app exactly ──────────
firebase.initializeApp({
  apiKey:            "AIzaSyC8csUtOBd8GY6vK3QmZXB1kjY46ijj8yw",
  authDomain:        "jsjc-booking-app.firebaseapp.com",
  projectId:         "jsjc-booking-app",
  storageBucket:     "jsjc-booking-app.firebasestorage.app",
  messagingSenderId: "92282421131",
  appId:             "1:92282421131:web:f08880ca301ef1afbcf98e"
});

const messaging = firebase.messaging();

// ── Background message handler ────────────────────────────────────────────────
// FCM calls this when a push arrives and the app tab is not in focus.
// If the FCM payload contains a `notification` block, FCM displays it
// automatically and this handler is NOT called — the notification block
// in the Edge Function payload controls that path.
// This handler is called when the payload contains only a `data` block
// (data-only push), which is what the JSJC fcm-send Edge Function sends.

messaging.onBackgroundMessage(function (payload) {
  console.log('[firebase-messaging-sw] Background message received:', payload);

  // Extract from data payload (fcm-send sends title/body in the data block)
  var data  = payload.data || {};
  var notif = payload.notification || {};

  var title = notif.title || data.title || 'JSJC Booking';
  var body  = notif.body  || data.body  || 'You have a new notification.';
  var type  = data.type   || 'booking';
  var bookingId = data.bookingId || data.booking_id || null;

  // Tag collapses duplicate notifications of the same type on the device
  var tag = 'jsjc-' + type + (bookingId ? '-' + bookingId : '');

  var options = {
    body:               body,
    icon:               '/icon-192.png',
    badge:              '/icon-72.png',
    tag:                tag,
    renotify:           true,
    requireInteraction: false,
    silent:             false,
    vibrate:            [200, 100, 200],
    data: {
      type:      type,
      bookingId: bookingId,
      url:       self.registration.scope
    }
  };

  return self.registration.showNotification(title, options);
});

// ── Notification click handler ────────────────────────────────────────────────
// Tapping the notification focuses an existing app tab or opens a new one.

self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  var targetUrl = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : self.registration.scope;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (clientList) {
        for (var i = 0; i < clientList.length; i++) {
          var client = clientList[i];
          if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
            // Tell the open tab which booking to highlight
            client.postMessage({
              type:      'NOTIFICATION_CLICK',
              bookingId: event.notification.data && event.notification.data.bookingId,
              notifType: event.notification.data && event.notification.data.type
            });
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      })
  );
});
