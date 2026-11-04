/*
 * GitHub Pages sends a short max-age on everything, so this keeps a second visit
 * off the network. Three rules:
 *
 *   hashed files (_astro/*, hashed pack objects)  cache first, forever. A hash in
 *       the name means the bytes can't change, so a deploy can't mix old and new.
 *   HTML, manifests, the catalogue                network first. A deploy is seen on
 *       the next load, always; the cached copy is only for when the network fails.
 *   everything else (sprites, logo, art)          cached at once, refreshed behind.
 *
 * Nothing here runs before the page has loaded: Shell.astro registers it when idle.
 */
const VERSION = "v1";
const ASSETS = `eclipse-assets-${VERSION}`;
const PACKS = `eclipse-packs-${VERSION}`;
const PAGES = `eclipse-pages-${VERSION}`;
const KEEP = new Set([ASSETS, PACKS, PAGES]);
const LIMITS = { [ASSETS]: 400, [PACKS]: 1500, [PAGES]: 40 };

const SCOPE = new URL(self.registration.scope);
const packParam = new URL(location.href).searchParams.get("packs") || "";
const PACK_ROOT = packParam ? new URL(packParam.replace(/\/?$/, "/"), location.origin).href : "";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    for (const name of await caches.keys()) {
      if (name.startsWith("eclipse-") && !KEEP.has(name)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

/** A pack key that carries a content hash: `clip/3f2a91c4d0.glb`, `tex/ab12…ef.ktx2`. */
const HASHED = /(^|[/._-])[0-9a-f]{8,64}([/._-]|$)/i;

function classify(url, request) {
  if (request.method !== "GET" || request.headers.has("range")) return null;
  if (request.mode === "navigate") return "page";
  if (url.origin === SCOPE.origin && url.pathname.startsWith(`${SCOPE.pathname}_astro/`)) return "asset";
  if (PACK_ROOT && url.href.startsWith(PACK_ROOT)) {
    const key = url.href.slice(PACK_ROOT.length).split("?")[0];
    if (key.startsWith("catalog/") || key.startsWith("reports/") || key.endsWith("manifest.json")) return "fresh";
    if (HASHED.test(key)) return "pack";
    return "soft";
  }
  if (url.origin === SCOPE.origin && url.pathname.startsWith(SCOPE.pathname)) return "soft";
  return null;
}

async function trim(name) {
  const limit = LIMITS[name];
  if (!limit) return;
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - limit; i++) await cache.delete(keys[i]);
}

/**
 * Pack images load in no-cors mode, which would hand back an opaque response whose
 * status can't be read. CORS is set on the pack host, so ask in cors mode and only
 * ever store a response known to be good.
 */
function fetchForCache(request, url) {
  if (url.origin !== SCOPE.origin && request.mode === "no-cors") {
    return fetch(url.href, { mode: "cors", credentials: "omit" }).catch(() => fetch(request));
  }
  return fetch(request);
}

async function cacheFirst(event, name, url) {
  const cache = await caches.open(name);
  const hit = await cache.match(url.href);
  if (hit) return hit;
  const res = await fetchForCache(event.request, url);
  if (res.ok && res.type !== "opaque") {
    const copy = res.clone();
    event.waitUntil(cache.put(url.href, copy).then(() => trim(name)));
  }
  return res;
}

async function networkFirst(event, name) {
  const cache = await caches.open(name);
  const key = event.request.url;
  try {
    const preloaded = event.preloadResponse ? await event.preloadResponse : null;
    const res = preloaded || (await fetch(event.request));
    if (res.ok) {
      const copy = res.clone();
      event.waitUntil(cache.put(key, copy).then(() => trim(name)));
    }
    return res;
  } catch (e) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw e;
  }
}

async function staleWhileRevalidate(event, url) {
  const cache = await caches.open(PACKS);
  const hit = await cache.match(url.href);
  const refresh = fetchForCache(event.request, url).then((res) => {
    if (res.ok && res.type !== "opaque") return cache.put(url.href, res.clone()).then(() => res);
    return res;
  });
  if (hit) {
    event.waitUntil(refresh.catch(() => {}));
    return hit;
  }
  return refresh;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const kind = classify(url, event.request);
  if (!kind) return;
  if (kind === "asset") event.respondWith(cacheFirst(event, ASSETS, url));
  else if (kind === "pack") event.respondWith(cacheFirst(event, PACKS, url));
  else if (kind === "page" || kind === "fresh") event.respondWith(networkFirst(event, PAGES));
  else event.respondWith(staleWhileRevalidate(event, url));
});

/**
 * The first visit's files were fetched before this worker was in control. The page
 * lists them once it is idle; they come from the browser's HTTP cache, not the wire.
 */
self.addEventListener("message", (event) => {
  const list = event.data && event.data.seed;
  if (!Array.isArray(list)) return;
  event.waitUntil((async () => {
    for (const href of list) {
      let url;
      try { url = new URL(href); } catch { continue; }
      const kind = classify(url, new Request(url));
      if (kind !== "asset" && kind !== "pack") continue;
      const name = kind === "asset" ? ASSETS : PACKS;
      const cache = await caches.open(name);
      if (await cache.match(url.href)) continue;
      try {
        const res = await fetch(url.href, { cache: "force-cache", mode: kind === "pack" ? "cors" : "same-origin", credentials: "omit" });
        if (res.ok) await cache.put(url.href, res);
      } catch { /* It will be cached when next asked for. */ }
    }
  })());
});
