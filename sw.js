/* ============================================================
   sw.js — caches the app shell (own-origin HTML/JS) so the site
   still loads with no connection at all.

   Deliberately does NOT touch Appwrite API calls or third-party
   CDN scripts (Tailwind, Chart.js) — those always go straight to
   the network. Caching an API response here would risk serving one
   student's data to whoever's using the browser next, which the
   app-level localStorage caching in js/offline.js avoids by keying
   per data type and always going through the normal auth check
   first. Bump CACHE_NAME whenever a shell file changes so old
   clients pick up the new version instead of a stale cached copy.
   ============================================================ */

const CACHE_NAME = "chuvera-shell-v3";

const SHELL_FILES = [
  "index.html",
  "auth.html",
  "admin-auth.html",
  "student.html",
  "staff.html",
  "admin.html",
  "js/pocketbase-config.js",
  "js/offline.js",
  "js/utils.js",
  "js/pdf-utils.js",
  "js/auth.js",
  "js/admin-auth.js",
  "js/student.js",
  "js/staff.js",
  "js/admin.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin GET requests for our own files. Appwrite
  // API calls and CDN scripts pass straight through to the network
  // untouched — this service worker never sees or caches live data.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Network-first: always try to fetch the latest version of the file
  // first, so a fix you just deployed reaches visitors immediately.
  // Only fall back to the cached copy if there's genuinely no
  // connection (true offline use), and always keep the cache updated
  // with whatever the network just returned.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
