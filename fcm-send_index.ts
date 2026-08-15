// supabase/functions/fcm-send/index.ts — v87.13
//
// v87.13 CHANGES:
//   Added `webpush` block to the Firebase HTTP v1 message payload.
//
//   ROOT CAUSE of no visible notification on Chrome desktop + PWA:
//   The previous version sent only `android` + `apns` platform blocks.
//   Chrome Web Push (desktop Chrome, Android Chrome, installed PWA) reads
//   the `webpush` block — not `android` or `apns`. Without a `webpush`
//   block, Chrome receives the push at the OS level but has no
//   notification content to display, so it falls back to a generic
//   "This site has been updated in the background" message or nothing.
//
//   The `webpush.notification` sub-object is what Chrome uses to render
//   the notification (title, body, icon, badge, tag).
//   The `webpush.fcm_options.link` is what Chrome uses when the user
//   clicks the notification (open/focus this URL).
//
//   No change to token lookup, JWT signing, OAuth2 exchange, or
//   per-token send logic. Only the message object shape changed.
//
// Deploy: supabase functions deploy fcm-send
// Required secrets (unchanged): FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── PEM normalisation ──────────────────────────────────────────────────────
// v87.11: handles double-escaped \n from Supabase Secrets CLI, PKCS#8 + PKCS#1,
// and adds padding-safe base64 decode with character validation.
function normalisePem(raw: string): string {
  // Four-stage newline normalisation (v87.11)
  let pem = raw
    .replace(/\\\\n/g, "\n")   // double-escaped → single-escaped
    .replace(/\\n/g, "\n")     // single-escaped → real newline
    .replace(/\r\n/g, "\n")    // CRLF → LF
    .replace(/\r/g, "\n");     // CR → LF
  return pem;
}

function base64Decode(b64: string): Uint8Array {
  // Add padding if needed
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importPrivateKey(pemRaw: string): Promise<CryptoKey> {
  const pem = normalisePem(pemRaw);
  console.log("[FCM] PEM length:", pem.length, "| first 40:", pem.slice(0, 40), "| last 40:", pem.slice(-40));

  const stripHeaders = (p: string) =>
    p.replace(/-----BEGIN [A-Z ]+-----/g, "")
     .replace(/-----END [A-Z ]+-----/g, "")
     .replace(/\s+/g, "");

  const b64 = stripHeaders(pem);

  // Validate base64 characters
  const invalid = b64.match(/[^A-Za-z0-9+/=]/);
  if (invalid) {
    const code = invalid[0].charCodeAt(0);
    throw new Error(`Invalid base64 char U+${code.toString(16).padStart(4,"0")} in private key after strip. Key length: ${b64.length}`);
  }

  const der = base64Decode(b64);

  try {
    // PKCS#8 (BEGIN PRIVATE KEY) — standard Firebase service account format
    return await crypto.subtle.importKey(
      "pkcs8", der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false, ["sign"]
    );
  } catch (_) {
    // PKCS#1 fallback — wrap in PKCS#8 container and retry
    const pkcs8Header = new Uint8Array([
      0x30, 0x82, 0x00, 0x00, 0x02, 0x01, 0x00, 0x30, 0x0d,
      0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01,
      0x01, 0x01, 0x05, 0x00, 0x04, 0x82, 0x00, 0x00
    ]);
    const wrapped = new Uint8Array(pkcs8Header.length + der.length);
    wrapped.set(pkcs8Header);
    wrapped.set(der, pkcs8Header.length);
    return await crypto.subtle.importKey(
      "pkcs8", wrapped,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false, ["sign"]
    );
  }
}

// ── JWT + OAuth2 ────────────────────────────────────────────────────────────
async function getAccessToken(clientEmail: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim  = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const encode = (obj: object) =>
    btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const sigInput = encode(header) + "." + encode(claim);
  const key = await importPrivateKey(privateKeyPem);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key,
    new TextEncoder().encode(sigInput)
  );
  const jwt = sigInput + "." +
    btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error("OAuth2 token exchange failed: " + JSON.stringify(tokenData));
  return tokenData.access_token;
}

// ── Send one FCM message ────────────────────────────────────────────────────
async function sendToToken(
  token: string,
  title: string,
  body: string,
  projectId: string,
  accessToken: string,
  appUrl: string
): Promise<{ ok: boolean; token: string; messageId?: string; error?: string }> {
  const message = {
    token,
    // `notification` key — Firebase SDK uses this for automatic display
    // on platforms that support it. Also lets onMessage/onBackgroundMessage
    // read payload.notification.title / .body.
    notification: {
      title,
      body,
    },
    // `data` key — always readable by onMessage and onBackgroundMessage
    // regardless of platform, including when app is open in foreground.
    data: {
      title,
      body,
      type: "booking",
    },
    // Android — high priority delivery
    android: {
      priority: "high",
      notification: {
        sound: "default",
        icon: "ic_notification",
      },
    },
    // iOS — high priority delivery
    apns: {
      headers: { "apns-priority": "10" },
      payload: { aps: { sound: "default", "content-available": 1 } },
    },
    // v87.13 NEW: Chrome Web Push block — THIS is what Chrome desktop,
    // Android Chrome, and installed PWA actually read to display the
    // notification. Without this block, Chrome receives the push but has
    // no content to render, producing no visible notification.
    webpush: {
      headers: {
        Urgency: "high",
      },
      notification: {
        title,
        body,
        icon:               "/icon-192.png",
        badge:              "/icon-72.png",
        tag:                "jsjc-push",
        requireInteraction: false,
      },
      fcm_options: {
        link: appUrl,  // URL to open/focus when notification is clicked
      },
    },
  };

  const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  const res = await fetch(fcmUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message }),
  });

  const data = await res.json();
  if (res.ok) {
    return { ok: true, token, messageId: data.name };
  } else {
    const errCode = data?.error?.details?.[0]?.errorCode || data?.error?.message || JSON.stringify(data);
    return { ok: false, token, error: errCode };
  }
}

// ── Main handler ────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const { title, body, tokens } = await req.json();

    if (!tokens || !tokens.length) {
      return new Response(JSON.stringify({ error: "No tokens provided" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const projectId    = Deno.env.get("FCM_PROJECT_ID")    || "";
    const clientEmail  = Deno.env.get("FCM_CLIENT_EMAIL")  || "";
    const privateKey   = Deno.env.get("FCM_PRIVATE_KEY")   || "";
    const appUrl       = Deno.env.get("APP_URL")           || "https://jsjc-booking-app.netlify.app/";

    if (!projectId || !clientEmail || !privateKey) {
      return new Response(JSON.stringify({ error: "Missing FCM secrets" }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const accessToken = await getAccessToken(clientEmail, privateKey);

    const results = await Promise.all(
      tokens.map((t: string) => sendToToken(t, title, body, projectId, accessToken, appUrl))
    );

    const sent   = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    console.log(`[FCM] Sent: ${sent} | Failed: ${failed}`);

    return new Response(JSON.stringify({ sent, failed, results }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[FCM] Edge function error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
