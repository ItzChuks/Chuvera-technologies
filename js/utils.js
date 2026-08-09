/* ============================================================
   SHARED UTILITIES
   Loaded on every page, after pocketbase-config.js
   ============================================================ */

/** Toast notification (top-right), Tailwind-styled, no dependency. */
function toast(message, type = "success") {
  const colors = {
    success: "bg-forest-700 text-white",
    error: "bg-red-600 text-white",
    info: "bg-ink text-white",
  };
  const el = document.createElement("div");
  el.className = `fixed top-5 right-5 z-[999] px-4 py-3 rounded-xl shadow-lg text-sm font-medium ${colors[type] || colors.info} transition-all duration-300 translate-y-[-10px] opacity-0`;
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    el.classList.remove("translate-y-[-10px]", "opacity-0");
  });
  setTimeout(() => {
    el.classList.add("opacity-0");
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

/**
 * Redirect to the correct login page if there's no active session,
 * or if the session doesn't belong to the expected role.
 *
 * In the PocketBase version, "admin" / "student" / "staff" are each
 * their own auth collection, so the logged-in record already IS the
 * profile — there's no separate profile lookup by a shared user ID
 * the way Appwrite needed. We still call databases.getDocument()
 * (which does a real getOne() against that collection) purely as
 * the "does this session actually belong to this role" check: if
 * you're authenticated as a student and this page expects "staff",
 * the ID won't exist in the staff collection and this 404s, which
 * correctly bounces you to login.
 *
 * Returns { user, profile } on success (profile === user here, kept
 * as two keys only so call sites written for the Appwrite version
 * don't need touching).
 */
async function requireSession(expectedLabel) {
  const loginPage = expectedLabel === "admin" ? "admin-auth.html" : "auth.html";
  const sessionCacheKey = `session_${expectedLabel}`;

  let user;
  try {
    user = await account.get();
  } catch (err) {
    if (isNetworkError(err)) {
      const cached = cacheGet(sessionCacheKey);
      if (cached) {
        showOfflineBanner(true);
        return cached.data;
      }
    }
    window.location.href = loginPage;
    return null;
  }

  const collectionId =
    expectedLabel === "admin"
      ? POCKETBASE_CONFIG.collections.admins
      : expectedLabel === "student"
        ? POCKETBASE_CONFIG.collections.students
        : POCKETBASE_CONFIG.collections.staff;

  try {
    const profile = await databases.getDocument(POCKETBASE_CONFIG.url, collectionId, user.$id);
    const session = { user, profile };
    cacheSet(sessionCacheKey, session);
    return session;
  } catch (err) {
    if (isNetworkError(err)) {
      const cached = cacheGet(sessionCacheKey);
      if (cached) {
        showOfflineBanner(true);
        return cached.data;
      }
    }
    window.location.href = loginPage;
    return null;
  }
}

async function logout(redirectTo = "index.html") {
  try {
    await account.deleteSession("current");
  } catch (err) {
    console.error(err);
  } finally {
    window.location.href = redirectTo;
  }
}

/** Simple grade calculator — schools can tweak the bands + weighting. */
function computeGrade(total) {
  if (total >= 75) return "A1";
  if (total >= 70) return "B2";
  if (total >= 65) return "B3";
  if (total >= 60) return "C4";
  if (total >= 55) return "C5";
  if (total >= 50) return "C6";
  if (total >= 45) return "D7";
  if (total >= 40) return "E8";
  return "F9";
}

function initials(name) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0].toUpperCase())
    .join("");
}

/** True if an error looks like a rate limit / abuse-protection hit
 * (either from PocketBase itself, or from our own client-side
 * cooldown in createAccount() below). */
function isRateLimitError(error) {
  return Boolean(error && error.code === 429);
}

/* ============================================================
   Account creation/deletion — shared by admin.js (students +
   staff) and staff.js (students only; the custom route itself
   enforces that restriction server-side, see pb_hooks/main.pb.js).

   This can't be done straight from the browser: it needs to (1)
   create the PocketBase auth record in the students/staff
   collection with a generated unique school ID, and (2), for
   deletion, actually revoke the login rather than just editing
   profile fields. Both need "check every existing school_id" /
   "act on someone else's account" privileges the caller's own
   session shouldn't hold — so both go through a custom PocketBase
   route (pb_hooks/main.pb.js) that runs with superuser access,
   the same role Appwrite's create-account Function played.
   ============================================================ */

let authAccountCreationInProgress = false;
let authAccountCreationCooldownUntil = Number(localStorage.getItem("authAccountCreationCooldownUntil")) || 0;

function getAuthAccountCreationCooldownUntil() {
  const stored = Number(localStorage.getItem("authAccountCreationCooldownUntil")) || 0;
  authAccountCreationCooldownUntil = Math.max(authAccountCreationCooldownUntil, stored);
  return authAccountCreationCooldownUntil;
}

function setAuthAccountCreationCooldownUntil(timestamp) {
  authAccountCreationCooldownUntil = timestamp;
  localStorage.setItem("authAccountCreationCooldownUntil", String(timestamp));
}

function getAuthAccountCreationCooldownMs() {
  const until = getAuthAccountCreationCooldownUntil();
  return Math.max(0, until - Date.now());
}

function formatSeconds(ms) {
  return Math.ceil(ms / 1000);
}

/** Create a new student/staff login account via the custom
 * create-account route. Returns { schoolId, userId }. */
async function createAccount(role, payload) {
  const cooldownMs = getAuthAccountCreationCooldownMs();
  if (cooldownMs > 0) {
    const err = new Error(`Rate limit active. Wait ${formatSeconds(cooldownMs)} seconds before creating another account.`);
    err.code = 429;
    throw err;
  }
  if (authAccountCreationInProgress) {
    throw new Error("Another account creation is already in progress. Wait for it to finish.");
  }

  authAccountCreationInProgress = true;
  try {
    let result;
    try {
      result = await pb.send("/api/custom/create-account", {
        method: "POST",
        body: { action: "create", role, ...payload },
      });
    } catch (err) {
      console.error("create-account raw error:", err); // full detail, always logged
      const detail = err?.response?.error || err?.data?.message || err?.message || "Account creation failed.";
      const e = new Error(detail);
      if (err?.status === 429) e.code = 429;
      throw e;
    }

    if (result?.error) {
      throw new Error(result.error);
    }

    return result; // { schoolId, userId }
  } finally {
    authAccountCreationInProgress = false;
  }
}

/** Fully deletes a student/staff account via the custom
 * delete-account route: profile record AND the underlying login,
 * so the school ID + name stop working as credentials entirely.
 * Only admins can do this (enforced server-side). */
async function deleteAccount(role, userId) {
  let result;
  try {
    result = await pb.send("/api/custom/delete-account", {
      method: "POST",
      body: { action: "delete", role, userId },
    });
  } catch (err) {
    throw new Error(err?.response?.error || err?.message || "Account deletion failed.");
  }

  if (result?.error) {
    throw new Error(result.error);
  }

  return result;
}

/**
 * Staff "classes" assignments are stored as strings like "JSS1 (A)" when
 * a class has arms, or plain "JSS1" when it doesn't. These two helpers
 * build/parse that format consistently everywhere it's used (the Add
 * Staff checkboxes, score entry filtering, and class-wide messaging) so
 * a staff member assigned to specific arms only sees/affects students in
 * those arms, not the whole class.
 */
function formatClassAssignment(className, arm) {
  return arm ? `${className} (${arm})` : className;
}

function parseClassAssignment(value) {
  const match = /^(.*) \(([^)]+)\)$/.exec(value || "");
  return match ? { className: match[1], arm: match[2] } : { className: value || "", arm: null };
}

/** Escapes text before it's dropped into innerHTML/attribute strings,
 * so names, class names, subjects etc. containing &, <, >, quotes,
 * etc. can never break markup or inject scripts. Use this any time
 * user-entered data is interpolated into a template string. */
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

/** Builds a public "view" URL for a material's uploaded file.
 * Unlike Appwrite (separate Storage bucket + file_id), PocketBase
 * stores the file directly on the record via a "file" field, so the
 * URL only needs the record's collection, id, and stored filename —
 * pb.files.getURL() builds that for us. Takes the whole material
 * record (needs both its id and its file field). */
function materialFileUrl(material) {
  return pb.files.getURL(material, material.file);
}

/** Collapses rapid-fire calls (e.g. several Realtime events firing in
 * quick succession during a cascade update) into one trailing call. */
function debounce(fn, wait = 400) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/* ============================================================
   Section "page" router — shared by admin.html, staff.html and
   student.html. Each dashboard defines its own setActiveTab(tab)
   that shows/hides the right .tab-section; this layer pushes every
   tab switch onto browser history as its own entry (?tab=name), so
   the browser's back/forward arrows step through sections the same
   way they'd step through separate pages.
   ============================================================ */

/** Switches to `tab` (via the page's own setActiveTab) and records
 * it in history. Pass replace=true for the very first load, so
 * arriving on the dashboard doesn't add an extra history entry. */
function navigateToTab(tab, replace = false) {
  const url = new URL(window.location.href);
  url.searchParams.set("tab", tab);
  const state = { tab };
  if (replace) window.history.replaceState(state, "", url);
  else window.history.pushState(state, "", url);
  setActiveTab(tab);
}

/** Call once on page load. Wires up back/forward navigation and
 * opens whichever tab the URL (or a fresh load) points to. */
function initTabRouter(defaultTab) {
  window.addEventListener("popstate", (e) => {
    const tab = (e.state && e.state.tab) || new URL(window.location.href).searchParams.get("tab") || defaultTab;
    setActiveTab(tab);
  });
  const startTab = new URL(window.location.href).searchParams.get("tab") || defaultTab;
  navigateToTab(startTab, true);
}

/* ---------- Sliding nav indicator ----------
   A pill that glides behind whichever nav-btn is currently
   .active, instead of the active state just jumping between items. */
function updateNavIndicator(navId, indicatorId) {
  const nav = document.getElementById(navId);
  const indicator = document.getElementById(indicatorId);
  if (!nav || !indicator) return;
  const activeBtn = nav.querySelector(".active");
  if (!activeBtn) {
    indicator.style.opacity = "0";
    return;
  }
  const navRect = nav.getBoundingClientRect();
  const btnRect = activeBtn.getBoundingClientRect();
  indicator.style.opacity = "1";
  indicator.style.width = `${btnRect.width}px`;
  indicator.style.height = `${btnRect.height}px`;
  indicator.style.transform = `translate(${btnRect.left - navRect.left + nav.scrollLeft}px, ${btnRect.top - navRect.top}px)`;
}

function refreshNavIndicators() {
  updateNavIndicator("sidebar-nav", "sidebar-indicator");
}

window.addEventListener("resize", debounce(refreshNavIndicators, 120));

/* ---------- Mobile sidebar drawer (hamburger nav) ----------
   On small screens the sidebar itself becomes a slide-in drawer,
   toggled by the hamburger button in the topbar. Desktop keeps the
   sidebar as a static column (see the lg: classes on #app-sidebar),
   so this only ever runs its course below the lg breakpoint. */
function setSidebarOpen(open) {
  const sidebar = document.getElementById("app-sidebar");
  const backdrop = document.getElementById("sidebar-backdrop");
  const openBtn = document.getElementById("sidebar-open-btn");
  if (!sidebar) return;
  sidebar.classList.toggle("-translate-x-full", !open);
  if (backdrop) {
    backdrop.classList.toggle("opacity-0", !open);
    backdrop.classList.toggle("pointer-events-none", !open);
  }
  if (openBtn) openBtn.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("overflow-hidden", open);
}

function initSidebarDrawer() {
  document.getElementById("sidebar-open-btn")?.addEventListener("click", () => setSidebarOpen(true));
  document.getElementById("sidebar-close-btn")?.addEventListener("click", () => setSidebarOpen(false));
  document.getElementById("sidebar-backdrop")?.addEventListener("click", () => setSidebarOpen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setSidebarOpen(false);
  });
  // Choosing a section on mobile should close the drawer, the same
  // way tapping a link closes a mobile nav on a "real" multi-page site
  document.querySelectorAll("#sidebar-nav .nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (window.innerWidth < 1024) setSidebarOpen(false);
    });
  });
  window.addEventListener(
    "resize",
    debounce(() => {
      if (window.innerWidth >= 1024) setSidebarOpen(false);
    }, 150)
  );
}

document.addEventListener("DOMContentLoaded", initSidebarDrawer);
