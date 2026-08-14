/**
 * EduHub — Service Worker (v1.5 · author-studio install hotfix)
 *
 * Strategy router:
 *   • /api/*        → NETWORK ONLY (never cached, bypasses SW)
 *   • /manifest*.json / *.webmanifest → SW BYPASS (network direct, never cached)
 *   • HTML docs     → NETWORK FIRST (fresh shell, cache fallback, then offline.html)
 *   • Same-origin static (.js/.css/.woff2/icons/etc) → CACHE FIRST (precached on first load)
 *   • Cross-origin (Drive/Dropbox/YouTube/Google Fonts) → STALE-WHILE-REVALIDATE
 *
 * Update flow:
 *   • install   → precache shell, skipWaiting()
 *   • activate  → delete old caches, clients.claim()
 *   • message   → 'UNREGISTER' (kill switch), 'SKIP_WAITING' (apply update)
 *
 * IMPORTANT: bump SW_VERSION whenever you change THIS file or want all
 * clients to evict their static caches. The page's update toast will
 * appear automatically after deploy.
 *
 * v1.5 additions (surgical · install hotfix only):
 *   • Manifest files are now exempted from the SW cache. Previously a
 *     `.json` request was classified as "same-origin static → CACHE
 *     FIRST", which meant /manifest.json was served from cache during
 *     iOS Safari's "Add to Home Screen" install-time manifest fetch —
 *     so /studio installs resolved to the cached EduHub manifest
 *     (id: "/", start_url: "/?source=pwa") and landed on the MAIN PWA.
 *     The new branch lets the browser fetch manifest files directly
 *     from the network on every install attempt. Push, notifications,
 *     auth, OAuth, routing, and all other behaviors are unchanged.
 *   • /manifest-studio.json added to SHELL_URLS as a redundancy only
 *     (consulted exclusively by the offline.html fallback path).
 *
 * v1.4 behaviors (preserved verbatim):
 *   • Push handler broadcasts EDUHUB_PUSH_SYNC to every window so the
 *     RealtimeSyncBridge wakes pollers the instant a notification fires.
 *   • notificationclick appends ?syncKind=…&syncTs=… to the target URL
 *     and posts EDUHUB_PUSH_SYNC after focusing/opening the client.
 *   • Both side-effects remain wrapped in try/catch — push delivery is
 *     unaffected if the postMessage fan-out fails for any reason.
 */

// v1.9.0 — BUILD_ID is stamped by scripts/stamp-sw.js during `yarn build`.
// It changes on EVERY build whose assets or SW source differ, so cache
// names are always unique per release and `activate` deletes every
// previous release's caches. The literal below is a dev-only fallback.
const BUILD_ID = "__SW_BUILD_ID__";
const SW_VERSION = BUILD_ID.indexOf("__") === 0 ? "v1.9.0-dev" : BUILD_ID;
const APP_SHELL_CACHE = `eduhub-shell-${SW_VERSION}`;
const STATIC_CACHE    = `eduhub-static-${SW_VERSION}`;
const RUNTIME_CACHE   = `eduhub-runtime-${SW_VERSION}`;
const ALL_CACHES = [APP_SHELL_CACHE, STATIC_CACHE, RUNTIME_CACHE];

// Tiny shell — the routes that must work offline on first launch.
const SHELL_URLS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/manifest-studio.json",
  "/offline.html",
];

// Cap the runtime cache so a long session can't grow it indefinitely.
const RUNTIME_MAX_ENTRIES = 80;

/* ─────────────────── v1.1 · Media MIME rewrite ─────────────────── */
const MEDIA_HOSTS = /(^|\.)dropboxusercontent\.com$|(^|\.)dl\.dropbox\.com$|(^|\.)googleusercontent\.com$/i;
// v9.6 — Match by extension regardless of host so backend-served and
// arbitrary CDN media (e.g. ElevenLabs / R2 / signed proxy URLs) ALSO
// bypass the cache. The cache-bound staleWhileRevalidate strategy was
// the smoking gun for "audio stops after 1–2 minutes": it called
// `cache.put` on Range / 206 partial responses (which the Cache API
// rejects) and buffered `response.clone()` in service-worker memory.
// Under iOS PWA memory pressure that caused the SW to terminate
// mid-fetch, cutting the audio stream. The browser's native media
// pipeline already handles Range requests + progressive download
// correctly — let it do its job uninterrupted.
const MEDIA_EXT_RE = /\.(mp3|m4a|aac|wav|ogg|oga|flac|webm|mp4|m4v|mov|ogv)(\?|$)/i;
const MEDIA_EXT_TO_MIME = {
  mp3:  "audio/mpeg",
  m4a:  "audio/mp4",
  aac:  "audio/aac",
  wav:  "audio/wav",
  ogg:  "audio/ogg",
  oga:  "audio/ogg",
  flac: "audio/flac",
  webm: "audio/webm",
  mp4:  "video/mp4",
  m4v:  "video/mp4",
  mov:  "video/quicktime",
  ogv:  "video/ogg",
  webmv:"video/webm",
};

function extractFilename(req, response) {
  const cd = response.headers.get("content-disposition") || "";
  const m1 = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (m1) {
    try { return decodeURIComponent(m1[1].trim().replace(/^"|"$/g, "")); }
    catch { /* fall through */ }
  }
  const m2 = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  if (m2) return m2[1].trim();
  try {
    return new URL(req.url).pathname.split("/").pop() || "";
  } catch { return ""; }
}

function mimeForFilename(name) {
  if (!name) return null;
  const ext = name.split(".").pop().toLowerCase();
  return MEDIA_EXT_TO_MIME[ext] || null;
}

function isLikelyMediaRequest(url) {
  // v9.6 — match by extension only; host-agnostic. See MEDIA_EXT_RE
  // comment above for the long-playback-stops-at-1-2min context.
  return MEDIA_EXT_RE.test(url.pathname + (url.search || ""));
}

// v9.6 — true if the request needs a Range / partial response. We never
// cache these. Even non-Range media requests are passed through without
// caching to keep behaviour predictable.
function isRangeRequest(req) {
  try { return !!req.headers.get("range"); } catch { return false; }
}


/* ───────────────────── lifecycle ─────────────────────────────── */

// TEMPORARY diagnostic relay — installed-PWA stale-version investigation.
// Posts SW-side lifecycle/fetch decisions to every open client so they land
// in the same localStorage timeline __pwaDiag.js keeps on the page side
// (the SW's own console is a separate devtools context most phones can't
// reach). Remove this function and every broadcastDiag(...) call once the
// root cause is confirmed and the real fix has shipped.
async function broadcastDiag(eventName, extra) {
  try {
    const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const msg = { type: "SW_DIAG", event: eventName, swVersion: SW_VERSION, ...extra };
    for (const c of clientsList) {
      try { c.postMessage(msg); } catch { /* ignore single-client failure */ }
    }
  } catch { /* never break the SW over a diagnostic */ }
}

self.addEventListener("install", (event) => {
  broadcastDiag("install_start");
  event.waitUntil(
    caches
      .open(APP_SHELL_CACHE)
      .then((cache) =>
        Promise.all(
          SHELL_URLS.map((url) =>
            // v1.9.0 — cache:"reload" bypasses the HTTP cache so the shell
            // precached at install time is ALWAYS the currently-deployed one,
            // never a stale browser-cache copy.
            fetch(url, { credentials: "same-origin", cache: "reload" })
              .then((res) => res && res.ok && cache.put(url, res.clone()))
              .catch(() => {})
          )
        )
      )
      .then(() => { broadcastDiag("install_shell_cached"); return self.skipWaiting(); })
      .then(() => broadcastDiag("install_skip_waiting_done"))
  );
});

self.addEventListener("activate", (event) => {
  broadcastDiag("activate_start");
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        const stale = keys.filter((k) => k.startsWith("eduhub-") && !ALL_CACHES.includes(k));
        broadcastDiag("activate_deleting_stale_caches", { staleCaches: stale });
        return Promise.all(stale.map((k) => caches.delete(k)));
      })
      .then(() => { broadcastDiag("activate_claim_start"); return self.clients.claim(); })
      .then(() => broadcastDiag("activate_claim_done"))
  );
});

self.addEventListener("message", (event) => {
  if (!event.data) return;
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
  if (event.data === "UNREGISTER") {
    self.registration.unregister().then(() =>
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    );
  }
  // TEMPORARY diagnostic — lets the page ask "which version are you?"
  // without needing devtools access to the SW's own console.
  if (event.data === "REPORT_VERSION") {
    if (event.source) {
      try { event.source.postMessage({ type: "SW_DIAG", event: "version_report", swVersion: SW_VERSION }); } catch { /* ignore */ }
    }
  }
});

/* ───────────────────── strategy router ───────────────────────── */

self.addEventListener("fetch", (event) => {
  const req = event.request;

  if (req.method !== "GET") return;

  const url = new URL(req.url);

  if (url.pathname.startsWith("/api/")) return;

  // v1.9.0 — the SW script itself must NEVER be answered from the SW's own
  // caches; let the browser/network own it (update checks depend on it).
  if (url.pathname === "/sw.js") return;

  /* v11.0 — Cloudflare Turnstile loader & widget iframe MUST bypass the SW.
     The widget script (/turnstile/v0/api.js) and its associated iframe
     traffic on challenges.cloudflare.com are short-lived, signed, and
     security-critical. Serving anything from cache here will give a stale
     "Could not find widget" state on every subsequent SPA navigation
     between login gates (/library, /portal/me, /game/play, /assistant,
     /systemtest). Returning without respondWith lets the browser hit the
     network directly. */
  if (url.hostname === "challenges.cloudflare.com") {
    return;
  }

  /* v1.5 · Author-Studio install hotfix.
     ----------------------------------------------------------------
     Manifest files MUST bypass the SW. Previously the generic
     same-origin .json branch below served /manifest.json from
     CACHE FIRST, which meant iOS Safari's install-time manifest
     fetch was answered from cache with the stale EduHub identity
     (id: "/", start_url: "/?source=pwa"). That made every "Add to
     Home Screen" from /studio land on the MAIN PWA.
     Returning here (without respondWith) lets the browser go to the
     network directly so the correct per-shell manifest is always
     materialised at install time.  Push, notifications, auth,
     routing, and every other SW behavior remain untouched. */
  if (
    url.pathname === "/manifest.json" ||
    url.pathname === "/manifest-studio.json" ||
    /^\/manifest[^/]*\.json$/i.test(url.pathname) ||
    /\.webmanifest$/i.test(url.pathname)
  ) {
    return;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  if (isLikelyMediaRequest(url)) {
    event.respondWith(mediaMimeFix(req));
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const acceptsHTML = (req.headers.get("accept") || "").includes("text/html");
  const isStatic = /\.(?:js|mjs|css|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|ico|map|json)$/i.test(
    url.pathname
  );

  if (acceptsHTML && sameOrigin) {
    // TEMPORARY diagnostic — records every HTML/navigation request this
    // worker serves, and (inside networkFirst) whether it ended up
    // network-fresh or cache-fallback. See broadcastDiag() above.
    broadcastDiag("fetch_html", { url: url.pathname + url.search });
    event.respondWith(htmlNetworkFirst(req));
    return;
  }
  if (sameOrigin && isStatic) {
    broadcastDiag("fetch_static", { url: url.pathname, cacheName: STATIC_CACHE });
    event.respondWith(cacheFirst(req, STATIC_CACHE, /*diagLabel*/ url.pathname));
    return;
  }
  // v1.8.1 - API / GAS / Render bypass (never cache live data hosts).
  //
  // staleWhileRevalidate below caches cross-origin responses. For the
  // backend API and Google Sheets/Apps Script hosts this is harmful: a
  // 503 HTML page returned during a Render cold start gets cached as an
  // opaque response and then served to students on the next load, blanking
  // the library and feeding HTML to JSON parsers. These hosts must always
  // hit the network directly so the app's own retry / last-known-good
  // logic can handle any failure.
  //
  // Returning WITHOUT event.respondWith() lets the browser fetch directly:
  // no cache, no clone, no stale fallback for these hosts.
  const API_BYPASS_HOSTS = [
    "eduhub-backend-td3a.onrender.com",
    "onrender.com",
    "script.google.com",
    "script.googleusercontent.com",
    "docs.google.com",
    "sheets.googleapis.com",
  ];
  const isApiBypass =
    !sameOrigin &&
    API_BYPASS_HOSTS.some(
      (h) => url.hostname === h || url.hostname.endsWith("." + h)
    );
  // Also never cache same-origin /api/ paths (defensive - these proxy to
  // the backend and must stay live).
  const isApiPath = url.pathname.startsWith("/api/");

  if (isApiBypass || isApiPath) {
    return; // browser handles directly - no SW caching
  }

  if (!sameOrigin) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    return;
  }
  event.respondWith(networkFirst(req, RUNTIME_CACHE, false));
});

/* ───────────────── v1.1 · Media MIME-fix strategy ──────────────── */
/* v9.6 — Hardened against long-playback failures.
 *
 *   • NEVER cache media responses (Range / 206 partials are not cacheable
 *     by spec, and full 200 audio responses can be hundreds of MB; the
 *     SW does NOT need to hold those in memory).
 *   • NEVER clone the response body for caching. `response.clone()`
 *     buffers the body until both consumers drain it; on iOS PWA that
 *     pinned memory and could terminate the SW mid-stream.
 *   • Still apply the MIME-fix to Dropbox / Drive responses (these hosts
 *     mis-label audio as application/octet-stream and the <audio>
 *     element refuses to play them without a real audio/* content-type).
 *   • For every other host (incl. backend ElevenLabs/R2 endpoints), pass
 *     the network response through 1:1, preserving status code (200/206),
 *     Content-Range, Accept-Ranges, ETag, Last-Modified, Content-Length.
 */
async function mediaMimeFix(req) {
  // Range requests: forward straight to the network. Mutating headers on
  // a 206 response can confuse some browser media pipelines; the
  // Dropbox/Drive MIME-mislabel issue manifests on the *initial* full
  // request, not on byte-range follow-ups, so this is safe.
  if (isRangeRequest(req)) {
    try { return await fetch(req); }
    catch { return new Response("Offline", { status: 503, statusText: "Offline" }); }
  }

  let res;
  try {
    res = await fetch(req);
  } catch (err) {
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
  if (!res) return res;
  // Only consider MIME-fix when the response is OK (or a 206 partial,
  // although those are short-circuited above).
  if (!res.ok && res.status !== 206) return res;

  // Only attempt MIME-fix on hosts known to mis-label media. Everything
  // else: return the network response as-is so the browser sees the
  // real Content-Type / Accept-Ranges / Content-Length.
  let url;
  try { url = new URL(req.url); } catch { return res; }
  if (!MEDIA_HOSTS.test(url.hostname)) return res;

  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.startsWith("audio/") || ct.startsWith("video/")) return res;

  const filename = extractFilename(req, res);
  const fixedMime = mimeForFilename(filename);
  if (!fixedMime) return res;

  const newHeaders = new Headers(res.headers);
  newHeaders.set("content-type", fixedMime);
  newHeaders.set("x-eduhub-mime-fix", "1");

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: newHeaders,
  });
}

/* ───────────────────── strategies ────────────────────────────── */

/* v1.9.0 — HTML navigations: NETWORK FIRST, HTTP-cache bypass, and NEVER
 * store per-URL HTML. Root cause of the "reverts to old version" incident:
 * networkFirst used to cache.put() every navigation's HTML keyed by full
 * URL (e.g. "/?source=pwa", "/portal/me"); those entries outlived deploys
 * (cache names weren't rebuilt per release) and any fetch hiccup during the
 * post-activate reload served a months-old shell referencing old hashed
 * chunks — which cacheFirst then happily supplied → old Login/My Portal.
 * Now the ONLY HTML fallback is the shell precached at THIS SW's install
 * (guaranteed same release as the SW), then offline.html. */
async function htmlNetworkFirst(req) {
  // Scoped to APP_SHELL_CACHE specifically (not the global CacheStorage.match,
  // which searches every cache in the origin regardless of release). This is
  // what actually guarantees the fallback can only ever be THIS SW's own
  // precached shell — never a same-named entry left behind in an
  // older-release cache during the brief window before activate's cleanup
  // completes.
  async function matchShell(path) {
    try {
      const cache = await caches.open(APP_SHELL_CACHE);
      return await cache.match(path);
    } catch {
      return undefined;
    }
  }
  try {
    // fetch by URL (not the navigation Request — re-dispatching a
    // mode:"navigate" Request with init throws in some browsers) with
    // cache:"no-store" so neither HTTP cache nor CDN staleness applies.
    const fresh = await fetch(req.url, {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "follow",
    });
    if (fresh && (fresh.ok || fresh.type === "opaqueredirect" || fresh.status === 304)) {
      broadcastDiag("network_first_served_fresh", { url: req.url, label: "html" });
      return fresh;
    }
    // Server error (5xx during deploy window) → fall back to current shell.
    const shellOnError = await matchShell("/index.html");
    if (shellOnError) {
      broadcastDiag("network_first_fell_back_to_cache", { url: req.url, label: "html-server-error", fromCache: true });
      return shellOnError;
    }
    return fresh;
  } catch {
    const shell = await matchShell("/index.html");
    if (shell) {
      broadcastDiag("network_first_fell_back_to_cache", { url: req.url, label: "html-offline-shell", fromCache: true });
      return shell;
    }
    const offline = await matchShell("/offline.html");
    if (offline) return offline;
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function networkFirst(req, cacheName, offlineFallback, diagLabel) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    // TEMPORARY diagnostic — this is the network-success path; the request
    // was answered fresh, NOT from cache.
    broadcastDiag("network_first_served_fresh", { url: req.url, label: diagLabel });
    return fresh;
  } catch {
    const cached = await caches.match(req);
    if (cached) {
      // TEMPORARY diagnostic — network failed, this request was answered
      // from a POSSIBLY STALE cached response. If this fires for HTML
      // during the reported "reverts a few seconds later" window, this is
      // the exact mechanism.
      broadcastDiag("network_first_fell_back_to_cache", { url: req.url, label: diagLabel, fromCache: true });
      return cached;
    }
    if (offlineFallback) {
      const offline = await caches.match("/offline.html");
      if (offline) return offline;
    }
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function cacheFirst(req, cacheName, diagLabel) {
  const cached = await caches.match(req);
  if (cached) {
    // TEMPORARY diagnostic — a static asset was served straight from
    // cache without ever touching the network this time.
    broadcastDiag("cache_first_served_from_cache", { url: req.url, label: diagLabel, fromCache: true });
    return cached;
  }
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch {
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cached = await caches.match(req);
  const network = fetch(req)
    .then((fresh) => {
      if (fresh && (fresh.ok || fresh.type === "opaque")) {
        // v1.8.1 fix: clone() synchronously BEFORE returning fresh so the
        // cache write and the caller each get an independent body stream.
        // The original code called fresh.clone() inside the async
        // caches.open().then() callback AFTER fresh had already been
        // returned and consumed, raising:
        //   "Failed to execute 'clone' on 'Response': body already used".
        let toCache = null;
        try { toCache = fresh.clone(); } catch { /* ignore */ }
        if (toCache) {
          caches.open(cacheName).then(async (cache) => {
            try {
              await cache.put(req, toCache);
              trimCache(cache, RUNTIME_MAX_ENTRIES);
            } catch { /* cache write failure is non-fatal */ }
          }).catch(() => {});
        }
      }
      return fresh;
    })
    .catch(() => null);
  return cached || (await network) || new Response("Offline", { status: 503 });
}

async function trimCache(cache, maxEntries) {
  try {
    const keys = await cache.keys();
    if (keys.length <= maxEntries) return;
    const drop = keys.length - maxEntries;
    for (let i = 0; i < drop; i++) await cache.delete(keys[i]);
  } catch {
    /* ignore */
  }
}

/* ───────────────────── Web Push handlers ─────────────────────── */
/* v1.4 — Push handler now ALSO fans out a same-origin postMessage to every
 * client window. The page-side RealtimeSyncBridge listens for it and force-
 * refreshes (a) the points balance and (b) the restriction watchdog so the
 * student's UI updates the same instant the OS notification appears.
 *
 * The original notification-display behaviour is byte-identical: title,
 * body, icon, badge, vibrate, click target are unchanged. The new
 * postMessage is a pure side-effect added INSIDE the existing waitUntil
 * (so it lives within the SW lifecycle promise) and is wrapped in
 * try/catch — push delivery is never affected by any failure here.
 */

function classifyPushKind(data) {
  // Best-effort kind detection from the server-rendered title/body so the
  // bridge can be smart about which slice to refresh first. The server
  // controls copy; we only LOOK at it (read-only).
  const t = (data && data.title ? String(data.title) : "").toLowerCase();
  const b = (data && data.body  ? String(data.body)  : "").toLowerCase();
  const blob = `${t} ${b}`;
  if (blob.includes("restrict")) return "restriction";
  if (blob.includes("points") || blob.includes("credit") || blob.includes("received") || blob.includes("reward")) return "points";
  if (blob.includes("tuition") || blob.includes("payment") || blob.includes("reminder")) return "reminder";
  if (blob.includes("speaking") || blob.includes("results")) return "results";
  return "generic";
}

async function broadcastSync(kind, payload) {
  try {
    const list = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    const msg = {
      type: "EDUHUB_PUSH_SYNC",
      kind,
      ts: Date.now(),
      // Only forward server-rendered copy — never client secrets.
      title: payload && payload.title ? String(payload.title).slice(0, 200) : "",
      body:  payload && payload.body  ? String(payload.body).slice(0, 400)  : "",
      url:   payload && payload.url   ? String(payload.url).slice(0, 400)   : "/",
    };
    for (const c of list) {
      try { c.postMessage(msg); } catch { /* ignore single-client failure */ }
    }
  } catch {
    /* never break push delivery */
  }
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "EduHub", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "EduHub";
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: data.url || "/", kind: classifyPushKind(data) },
    vibrate: [200, 100, 200],
  };

  event.waitUntil(
    Promise.all([
      // 1) Original behaviour — render the OS notification banner.
      self.registration.showNotification(title, options),
      // 2) NEW v1.4 — broadcast a sync ping so the live app refreshes
      //    points/restriction state without waiting for the next poll tick.
      broadcastSync(classifyPushKind(data), {
        title: data.title,
        body: data.body,
        url: data.url,
      }),
    ])
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const baseUrl = (event.notification.data && event.notification.data.url) || "/";
  const kind = (event.notification.data && event.notification.data.kind) || "generic";
  // Append a sync hint so the page can detect a cold-start tap from a push.
  let target = baseUrl;
  try {
    const u = new URL(baseUrl, self.location.origin);
    u.searchParams.set("syncKind", kind);
    u.searchParams.set("syncTs", String(Date.now()));
    target = u.pathname + u.search + (u.hash || "");
  } catch { /* leave baseUrl as-is */ }

  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Re-broadcast a sync ping — covers the case where the app is already
      // open and the user just tapped the banner.
      try {
        await broadcastSync(kind, {
          title: event.notification.title,
          body: event.notification.body,
          url: baseUrl,
        });
      } catch { /* ignore */ }
      for (const client of list) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          try { client.navigate(target); } catch { /* ignore navigate errors */ }
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(target);
    })()
  );
});
