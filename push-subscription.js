/**
 * push-subscription.js  —  JSJC Smart Booking App  (v87.11)
 *
 * Drop-in replacement for the FCM initialisation block in the app HTML.
 * Keeps the existing FCM architecture (Firebase project, VAPID key, fcm-send
 * Edge Function) but fixes the three most common failure points:
 *
 *   Problem 1 — Stale service worker
 *     The old SW registration used a dynamic swBase path. If firebase-messaging-sw.js
 *     was served from the wrong scope, getToken() silently returned null.
 *     Fix: explicit scope matching, SW update forced on every init, waitUntil active.
 *
 *   Problem 2 — FCM token not being saved
 *     getToken() can return null when the SW registration is not yet active,
 *     or when the VAPID key doesn't match the Web Push certificate in Firebase.
 *     Fix: wait for SW to become active before calling getToken(), validate the
 *     returned token before calling saveFCMToken().
 *
 *   Problem 3 — Wrong Firebase messaging config
 *     The messaging compat SDK requires the SW to be registered before getToken().
 *     Fix: register SW first, pass the registration explicitly to getToken().
 *
 * This file is a reference / audit document.
 * The actual changes are applied to the HTML file by the v87.11 patch.
 *
 * ── How to use ────────────────────────────────────────────────────────────────
 * This module is NOT loaded as a separate script. Its content replaces the
 * existing FCM block (initFCM function) in the HTML file directly.
 * See "Changes needed" section at the bottom of this file.
 */

// ── Configuration — must match FIREBASE_CONFIG in the app ─────────────────────

var FIREBASE_CONFIG = {
  apiKey:            "AIzaSyC8csUtOBd8GY6vK3QmZXB1kjY46ijj8yw",
  authDomain:        "jsjc-booking-app.firebaseapp.com",
  projectId:         "jsjc-booking-app",
  storageBucket:     "jsjc-booking-app.firebasestorage.app",
  messagingSenderId: "92282421131",
  appId:             "1:92282421131:web:f08880ca301ef1afbcf98e"
};

// This is the VAPID public key from Firebase Console →
// Project Settings → Cloud Messaging → Web Push certificates.
// It must match the key used to sign pushes in the Edge Function.
var FCM_VAPID_KEY =
  "BMe3G3BhWVyRE5HfYJO-pf-WhSlgNLqN_PjQpD7dJYiI7zLNh2pP8E1PeDWUQ5zyhxgFjD8nYOLGxAE-jivxhNc";

// ── State ─────────────────────────────────────────────────────────────────────

var _fcmToken     = null;
var _fcmApp       = null;
var _fcmMessaging = null;
var _fcmReady     = false;

// ── SW registration helper ────────────────────────────────────────────────────
// Returns the ServiceWorkerRegistration for firebase-messaging-sw.js,
// waiting until it is in the 'activated' state before resolving.
// This is the fix for "token not saved" — getToken() requires an active SW.

async function _registerFCMServiceWorker() {
  // Derive the deployment base path (handles GitHub Pages subdirectory)
  var swBase = (function () {
    var p    = window.location.pathname;
    var base = p.substring(0, p.lastIndexOf('/') + 1);
    return base || '/';
  })();

  var swURL = swBase + 'firebase-messaging-sw.js';
  console.log('[FCM] Registering SW at', swURL, 'scope:', swBase);

  var reg;
  try {
    reg = await navigator.serviceWorker.register(swURL, { scope: swBase });
  } catch (err1) {
    console.warn('[FCM] SW registration failed at', swURL, '— trying fallback:', err1.message);
    try {
      reg = await navigator.serviceWorker.register('./firebase-messaging-sw.js');
    } catch (err2) {
      console.error('[FCM] SW registration fallback also failed:', err2.message);
      return null;
    }
  }

  // Force the SW to update — clears stale cached versions
  try { await reg.update(); } catch (_) { /* non-fatal */ }

  // Wait until the SW is activated (not just registered)
  // getToken() silently returns null if called against an installing/waiting SW
  if (reg.active) return reg;

  return new Promise(function (resolve) {
    var sw = reg.installing || reg.waiting;
    if (!sw) { resolve(reg); return; }
    sw.addEventListener('statechange', function () {
      if (sw.state === 'activated') resolve(reg);
    });
    // Safety timeout — resolve anyway after 5s so the app isn't blocked
    setTimeout(function () { resolve(reg); }, 5000);
  });
}

// ── Main init function ────────────────────────────────────────────────────────

async function initFCM() {
  try {
    console.log('[FCM] initFCM started | Notification.permission:', Notification.permission);

    // 1. Load Firebase SDK (compat v9 CDN — no bundler needed)
    if (!window.firebase) {
      await _loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
      await _loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');
    }

    // 2. Initialise Firebase app (guard against double-init)
    if (!firebase.apps.length) {
      _fcmApp = firebase.initializeApp(FIREBASE_CONFIG);
    } else {
      _fcmApp = firebase.apps[0];
    }
    _fcmMessaging = firebase.messaging();

    // 3. Register the FCM service worker and wait until it is active
    //    (this was the most common cause of getToken() returning null)
    var swReg = await _registerFCMServiceWorker();
    if (!swReg) {
      console.warn('[FCM] No SW registration — push notifications unavailable.');
      return;
    }
    console.log('[FCM] SW active | state:', swReg.active ? swReg.active.state : 'none');

    // 4. Request notification permission
    var permission = await Notification.requestPermission();
    console.log('[FCM] Notification.requestPermission():', permission);
    if (permission !== 'granted') {
      console.log('[FCM] Permission not granted — push disabled.');
      return;
    }

    // 5. Get FCM registration token
    //    Passing serviceWorkerRegistration explicitly prevents the SDK from
    //    looking for a default SW, which often picks up the wrong registration.
    console.log('[FCM] Calling getToken… VAPID:', FCM_VAPID_KEY.slice(0, 20) + '…');
    var token = await _fcmMessaging.getToken({
      vapidKey:                    FCM_VAPID_KEY,
      serviceWorkerRegistration:   swReg
    });

    if (!token) {
      // Common causes: VAPID key mismatch, SW scope wrong, Firebase project
      // not configured for Web Push, or browser blocked notifications silently.
      console.warn(
        '[FCM] getToken() returned null.\n' +
        'Check:\n' +
        '  1. VAPID key in app matches Firebase Console → Project Settings → Cloud Messaging → Web Push certificates\n' +
        '  2. firebase-messaging-sw.js is deployed at the correct path and scope\n' +
        '  3. Firebase Cloud Messaging API (v1) is enabled in Google Cloud Console\n' +
        '  4. Browser notification permission is "granted" (not "default" or "denied")\n' +
        '  5. Open DevTools → Application → Service Workers → check firebase-messaging-sw.js is "activated"'
      );
      return;
    }

    _fcmToken = token;
    _fcmReady = true;
    console.log('[FCM] Token obtained:', token.slice(0, 20) + '…');

    // 6. Save token to Supabase fcm_tokens table
    await saveFCMToken(_fcmToken);

    // 7. Foreground message handler
    //    Shows toast + system notification when the app tab is visible
    _fcmMessaging.onMessage(function (payload) {
      console.log('[FCM] Foreground message:', payload);
      var title = (payload.notification && payload.notification.title) ||
                  (payload.data && payload.data.title) || 'JSJC';
      var body  = (payload.notification && payload.notification.body)  ||
                  (payload.data && payload.data.body)  || '';
      if (typeof toast === 'function') {
        toast('🔔 ' + title + (body ? ': ' + body : ''));
      }
      // System notification if the tab is hidden
      if (document.hidden && Notification.permission === 'granted') {
        new Notification(title, {
          body:  body,
          icon:  './icon-192.png',
          badge: './icon-72.png',
          tag:   'jsjc-foreground'
        });
      }
      // Also add to the in-app bell
      if (typeof addNotif === 'function') {
        addNotif(title + (body ? ' — ' + body : ''), (payload.data && payload.data.type) || 'booking');
      }
    });

  } catch (err) {
    console.warn('[FCM] Initialisation failed (non-fatal):', err && err.message);
  }
}

// ── Called after login — entry point from the app ─────────────────────────────

function fcmInitAfterLogin() {
  if ('serviceWorker' in navigator && 'Notification' in window) {
    setTimeout(initFCM, 1500);
  }
  setTimeout(loadNotificationsFromSupabase, 2000);
}
window.fcmInitAfterLogin = fcmInitAfterLogin;

/*
═══════════════════════════════════════════════════════════════════════════════
CHANGES NEEDED TO CONNECT THESE FILES TO THE EXISTING PROJECT
═══════════════════════════════════════════════════════════════════════════════

DEPLOY — place these files at the Netlify / GitHub Pages deployment root,
alongside index.html:

  service-worker.js           (offline cache — already registered in index.html)
  firebase-messaging-sw.js    (FCM background push handler — registered by initFCM)
  manifest.json               (already linked at line 103 of index.html)

NO CHANGES TO index.html ARE REQUIRED.
The existing registrations at the bottom of the HTML file are correct:
  - service-worker.js is registered by the <script> block at the bottom
  - firebase-messaging-sw.js is registered inside initFCM()
  - manifest.json is linked in <head>

The push-subscription.js content is a reference only — the initFCM() function
it documents already exists in the HTML. The key structural fixes (SW active
wait, explicit swReg passed to getToken, foreground message also calling addNotif)
should be patched into the HTML's existing initFCM() block if the token
is still returning null after deploying the corrected SW files.

VALIDATION CHECKLIST after deploying:
  □ DevTools → Application → Service Workers → firebase-messaging-sw.js
      Status must show: activated and running
      NOT: installing, waiting, or redundant
  □ DevTools → Application → Service Workers → service-worker.js
      Status must show: activated and running
  □ DevTools → Console → [FCM] Token obtained: xxxxx...
      If this does not appear: check VAPID key match (step 1 below)
  □ Supabase → fcm_tokens table → new row with user_name + user_role
  □ Send a test push from Admin panel → notification appears on device

VAPID KEY VERIFICATION (most common cause of null token):
  Firebase Console → Project Settings → Cloud Messaging tab →
  Web Push certificates section → copy the Key pair value.
  It must match FCM_VAPID_KEY in the app exactly, character for character.
  If it doesn't match: update the key in the app and redeploy.

STALE SW DEBUGGING:
  If firebase-messaging-sw.js shows "waiting" in DevTools:
    DevTools → Application → Service Workers → click "skipWaiting"
    Then reload the page.
  If it shows "redundant": the SW file has a syntax error — check Console.

═══════════════════════════════════════════════════════════════════════════════
*/
