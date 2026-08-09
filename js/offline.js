/* ============================================================
   offline.js — lightweight offline support, shared by every page.

   What this gives the app:
   1. A cache-first Service Worker for the app shell (the HTML/JS
      files themselves), so the page still loads with no connection
      at all — without this, "offline mode" is meaningless because
      the browser can't even run the fallback logic below.
   2. requireSession() (in utils.js) falls back to the last-known
      login instead of bouncing the user to the login screen when
      the network — not the session — is what's actually broken.
   3. Small cacheGet/cacheSet helpers any page can use to keep the
      last-fetched copy of read-only data (report card, materials,
      CBT list) around for offline viewing, plus a banner so it's
      obvious when someone's looking at cached data.

   This is intentionally READ-ONLY offline support. Nothing here
   queues writes made while offline (entering scores, submitting a
   test) — those still just fail with a normal error until the
   connection is back. See README-APPWRITE.md for why that's a
   deliberate scope cut, not an oversight.
   ============================================================ */

const OFFLINE_PREFIX = "chuvera_offline_";

/** Appwrite's SDK throws a plain Error (no numeric `code`) when the
 * fetch itself never reached the server — that's how we tell "you're
 * offline" apart from a real 401/404 the server sent back on purpose. */
function isNetworkError(err) {
  return !navigator.onLine || err?.code === undefined || err?.code === null;
}

function cacheSet(key, data) {
  try {
    localStorage.setItem(OFFLINE_PREFIX + key, JSON.stringify({ data, cachedAt: Date.now() }));
  } catch (e) {
    // Storage full, disabled, or private-browsing — offline caching
    // just silently won't work. Not fatal to the rest of the app.
  }
}

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(OFFLINE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function cacheAgeLabel(cachedAt) {
  const mins = Math.round((Date.now() - cachedAt) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/* ---------- Offline banner ---------- */
function showOfflineBanner(show) {
  let banner = document.getElementById("offline-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "offline-banner";
    banner.className = "hidden fixed top-0 inset-x-0 z-[100] bg-amber-500 text-white text-xs sm:text-sm text-center py-1.5 font-medium";
    banner.textContent = "You're offline — showing your last saved data.";
    document.body.prepend(banner);
  }
  banner.classList.toggle("hidden", !show);
}

window.addEventListener("offline", () => showOfflineBanner(true));
window.addEventListener("online", () => {
  showOfflineBanner(false);
  if (typeof toast === "function") toast("Back online.", "info");
});
if (!navigator.onLine) document.addEventListener("DOMContentLoaded", () => showOfflineBanner(true));

/* ---------- Service worker (app shell caching) ----------
   Disabled on localhost: dev static servers (npx serve, live-server,
   etc.) sometimes respond to requests with a redirect, which trips
   a known service-worker limitation ("a redirected response was
   used for a request whose redirect mode is not 'follow'") and
   breaks page loads. Once this is deployed to a real domain over
   HTTPS, flip ENABLE_SERVICE_WORKER back to true — that's also
   the only context offline support is actually useful in. */
const ENABLE_SERVICE_WORKER = false;

if (ENABLE_SERVICE_WORKER && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service worker registration failed:", err));
  });
}
