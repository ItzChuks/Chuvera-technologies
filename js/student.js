/* ============================================================
   student.html — student dashboard logic (Appwrite)
   ============================================================ */

let PROFILE = null;
let CURRENT_REPORT_SCORES = [];
let MESSAGES_CACHE = [];
let SCHOOL_MATERIALS_CACHE = [];
let LIBRARY_SCOPE = "all"; // "all" | "school" | "digital"
let LIBRARY_LOADED = false;
let LIBRARY_SESSION = null; // { query, results, googleStart, olPage, hasMoreGoogle, hasMoreOpenLibrary, loadingMore } — current digital-library search + pagination state
let LIBRARY_BOOK_MAP = new Map(); // book-key -> book object, for the currently rendered grid (used by the reader modal)

// Optional: create a free key at https://console.cloud.google.com/apis/credentials
// (enable "Books API" on the project first) and paste it here to raise the
// Google Books rate limit — the unauthenticated quota is shared across every
// visitor on the same network and runs out fast on a school connection.
const GOOGLE_BOOKS_API_KEY = "AIzaSyCkWcE4qdTXhhOX_eLOI8sasBAuixiAvno";
const LIBRARY_PAGE_SIZE = 20;
const DIGITAL_LIBRARY_CACHE = new Map(); // query -> full LIBRARY_SESSION snapshot, so returning to a repeat search this session resumes instantly instead of re-fetching from page 1

/* ---------- Small motion helpers ---------- */

/** Animates a number counting up from its current displayed value to
 * `target`, then gives it a little "pop" once it lands. Falls back to
 * an instant set for anyone with prefers-reduced-motion on. */
function animateCount(el, target, duration = 700) {
  if (!el) return;
  const prefersReduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target = Number(target) || 0;
  if (prefersReduced || target === 0) {
    el.textContent = target;
    return;
  }
  const start = Number(el.textContent) || 0;
  if (start === target) return;
  const startTime = performance.now();
  function tick(now) {
    const progress = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out-cubic
    el.textContent = Math.round(start + (target - start) * eased);
    if (progress < 1) {
      requestAnimationFrame(tick);
    } else {
      el.textContent = target;
      el.classList.remove("count-pop");
      // Force reflow so the pop animation can replay on repeat calls.
      void el.offsetWidth;
      el.classList.add("count-pop");
    }
  }
  requestAnimationFrame(tick);
}

/** A short, cheerful confetti burst for CBT results worth celebrating. */
function launchConfetti() {
  const prefersReduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReduced) return;
  const layer = document.getElementById("confetti-layer");
  if (!layer) return;
  const colors = ["#3c7360", "#8fab9c", "#c9a227", "#5c8f79", "#ffffff"];
  const pieceCount = 60;
  for (let i = 0; i < pieceCount; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    piece.style.left = Math.random() * 100 + "vw";
    piece.style.background = colors[i % colors.length];
    piece.style.animationDuration = 2.2 + Math.random() * 1.4 + "s";
    piece.style.animationDelay = Math.random() * 0.4 + "s";
    piece.style.transform = `rotate(${Math.random() * 360}deg)`;
    layer.appendChild(piece);
    setTimeout(() => piece.remove(), 4200);
  }
}

/* ---------- Tabs ---------- */
function setActiveTab(tab) {
  document.querySelectorAll(".tab-section").forEach((el) => el.classList.add("hidden"));
  document.getElementById(`tab-${tab}`).classList.remove("hidden");

  document.querySelectorAll(".nav-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));

  const titles = {
    overview: ["Overview", "Your ID card, at a glance"],
    subjects: ["My Subjects", "What you're offsetting this session"],
    "report-card": ["Report Card", "Scores by term and session"],
    analytics: ["My Progress", "How you're trending across the session"],
    cbt: ["Tests", "Take a published test for your class"],
    library: ["Library", "School materials and the free digital library"],
    messages: ["Messages", "Notices from school, your class and your teachers"],
  };
  document.getElementById("page-title").textContent = titles[tab][0];
  document.getElementById("page-subtitle").textContent = titles[tab][1];

  if (tab === "report-card") loadScores();
  if (tab === "analytics") loadMyProgress();
  if (tab === "cbt") { showCbtListView(); loadCbtList(); }
  if (tab === "messages") loadMessages();
  if (tab === "library" && !LIBRARY_LOADED) {
    LIBRARY_LOADED = true;
    loadSchoolMaterials();
    searchDigitalLibrary("education");
  }

  requestAnimationFrame(refreshNavIndicators);
}

document.querySelectorAll("#sidebar-nav .nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => navigateToTab(btn.dataset.tab));
});

document.getElementById("logout-btn").addEventListener("click", () => logout("index.html"));
document.getElementById("logout-btn-mobile").addEventListener("click", () => logout("index.html"));

function renderProfile(profile) {
  document.getElementById("p-name").textContent = profile.full_name;
  document.getElementById("p-meta").textContent = `${profile.class_name || ""}${profile.arm ? " · Arm " + profile.arm : ""}${profile.department ? " · " + profile.department : ""}`;
  document.getElementById("p-id").textContent = profile.school_id;
  document.getElementById("p-initials").textContent = initials(profile.full_name);
  document.getElementById("p-guardian").textContent = profile.guardian_name || "—";
  animateCount(document.getElementById("p-subject-count"), (profile.subjects || []).length);

  const subjects = profile.subjects || [];
  const subjectsEl = document.getElementById("p-subjects");
  subjectsEl.innerHTML = subjects.length
    ? subjects.map((s, i) => `
        <div class="subject-row" style="--i:${i}">
          <span class="subject-num">${String(i + 1).padStart(2, "0")}</span>
          <span class="subject-name">${escapeHtml(s)}</span>
          <span class="subject-arrow" aria-hidden="true">→</span>
        </div>
      `).join("")
    : `<p class="text-sm text-ink/40">No subjects assigned yet.</p>`;
}

async function loadScores() {
  const term = document.getElementById("term-select").value;
  const table = document.getElementById("scores-table");
  const cacheKey = `scores_${term}`;
  table.innerHTML = `<tr><td colspan="7" class="py-4"><div class="skeleton h-6 rounded-lg"></div></td></tr>`;

  let data;
  try {
    const res = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.scores, [
      Query.equal("student_auth_id", PROFILE.$id),
      Query.equal("term", term),
      Query.limit(50),
    ]);
    data = res.documents;
    cacheSet(cacheKey, data);
  } catch (err) {
    console.error(err);
    if (isNetworkError(err)) {
      const cached = cacheGet(cacheKey);
      if (cached) {
        showOfflineBanner(true);
        renderScoresTable(cached.data, cached.cachedAt);
        return;
      }
    }
    CURRENT_REPORT_SCORES = [];
    table.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-red-600 text-sm">Couldn't load scores.</td></tr>`;
    return;
  }

  renderScoresTable(data, null);
}

function renderScoresTable(data, cachedAt) {
  const term = document.getElementById("term-select").value;
  const table = document.getElementById("scores-table");
  CURRENT_REPORT_SCORES = data;

  if (data.length === 0) {
    table.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-ink/40 text-sm">No scores published for ${term} yet.</td></tr>`;
    document.getElementById("report-remarks").classList.add("hidden");
    return;
  }

  const cacheNote = cachedAt ? `<tr><td colspan="7" class="pb-2 text-xs text-amber-700">Showing scores saved ${cacheAgeLabel(cachedAt)} — reconnect to refresh.</td></tr>` : "";

  table.innerHTML = cacheNote + data.map((r) => `
      <tr class="border-b border-ink/5">
        <td class="py-2.5 pr-3 font-medium">${r.subject}</td>
        <td class="py-2.5 pr-3">${r.ca1 ?? "—"}</td>
        <td class="py-2.5 pr-3">${r.ca2 ?? "—"}</td>
        <td class="py-2.5 pr-3">${r.exam ?? "—"}</td>
        <td class="py-2.5 pr-3 font-semibold">${r.total ?? "—"}</td>
        <td class="py-2.5 pr-3"><span class="pill pill-green">${r.grade ?? "—"}</span></td>
        <td class="py-2.5 pr-3">${r.position ?? "—"}</td>
      </tr>
    `).join("");

  const remarkDoc = data.find((r) => r.teacher_remark || r.admin_remark);
  const remarksEl = document.getElementById("report-remarks");
  if (remarkDoc) {
    remarksEl.classList.remove("hidden");
    remarksEl.innerHTML = `
        <div><p class="text-ink/50 mb-1">Teacher's remark</p><p class="font-medium">${remarkDoc.teacher_remark || "—"}</p></div>
        <div><p class="text-ink/50 mb-1">Admin's remark</p><p class="font-medium">${remarkDoc.admin_remark || "—"}</p></div>
      `;
  } else {
    remarksEl.classList.add("hidden");
  }
}

document.getElementById("term-select").addEventListener("change", loadScores);
document.getElementById("session-input").addEventListener("change", loadScores);

/* ---------- My Progress (analytics) ---------- */
const TERM_ORDER = ["First Term", "Second Term", "Third Term"];
let myTrendChart = null;

/** Every score this student has across all terms, charted as one
 * line per subject — lets them see if a subject is improving or slipping. */
async function loadMyProgress() {
  const emptyEl = document.getElementById("progress-empty");
  const contentEl = document.getElementById("progress-content");
  const cacheKey = "progress_all";

  let data;
  let cachedAt = null;
  try {
    const res = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.scores, [
      Query.equal("student_auth_id", PROFILE.$id),
      Query.limit(200),
    ]);
    data = res.documents;
    cacheSet(cacheKey, data);
  } catch (err) {
    console.error(err);
    if (isNetworkError(err)) {
      const cached = cacheGet(cacheKey);
      if (cached) {
        showOfflineBanner(true);
        data = cached.data;
        cachedAt = cached.cachedAt;
      }
    }
    if (!data) return;
  }

  if (data.length === 0) {
    emptyEl.classList.remove("hidden");
    contentEl.classList.add("hidden");
    return;
  }
  emptyEl.classList.add("hidden");
  contentEl.classList.remove("hidden");

  const subjects = [...new Set(data.map((r) => r.subject))].sort();
  const palette = ["#3c7360", "#c9a227", "#d97a3c", "#5c8f79", "#8fab9c", "#b3392c"];
  const datasets = subjects.map((subject, i) => ({
    label: subject,
    data: TERM_ORDER.map((term) => {
      const row = data.find((r) => r.subject === subject && r.term === term);
      return row ? Number(row.total) || 0 : null;
    }),
    borderColor: palette[i % palette.length],
    backgroundColor: palette[i % palette.length],
    spanGaps: true,
    tension: 0.3,
  }));

  const canvas = document.getElementById("chart-my-trend");
  if (myTrendChart) myTrendChart.destroy();
  myTrendChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels: TERM_ORDER, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, max: 100 } },
    },
  });

  // Compare the latest term the student has scores for against the one before it
  const termsWithData = TERM_ORDER.filter((t) => data.some((r) => r.term === t));
  const latestTerm = termsWithData[termsWithData.length - 1];
  const latestAvgRows = data.filter((r) => r.term === latestTerm);
  const latestAvg = (latestAvgRows.reduce((sum, r) => sum + (Number(r.total) || 0), 0) / latestAvgRows.length).toFixed(1);

  let trendLabel = "First term on record";
  if (termsWithData.length > 1) {
    const prevTerm = termsWithData[termsWithData.length - 2];
    const prevRows = data.filter((r) => r.term === prevTerm);
    const prevAvg = prevRows.reduce((sum, r) => sum + (Number(r.total) || 0), 0) / prevRows.length;
    const diff = latestAvg - prevAvg;
    trendLabel = diff > 0.5 ? `Up ${diff.toFixed(1)} pts vs ${prevTerm}` : diff < -0.5 ? `Down ${Math.abs(diff).toFixed(1)} pts vs ${prevTerm}` : `Steady vs ${prevTerm}`;
  }

  const bestSubjectRow = data.reduce((best, r) => ((Number(r.total) || 0) > (Number(best?.total) || -1) ? r : best), null);

  document.getElementById("progress-stats").innerHTML = `
    <div><p class="text-ink/50 mb-1">${latestTerm} average</p><p class="font-display font-bold text-lg">${latestAvg}</p></div>
    <div><p class="text-ink/50 mb-1">Trend</p><p class="font-display font-bold text-lg">${trendLabel}</p></div>
    <div><p class="text-ink/50 mb-1">Best subject</p><p class="font-display font-bold text-lg">${bestSubjectRow ? bestSubjectRow.subject : "—"}</p></div>
    ${cachedAt ? `<div class="sm:col-span-3 text-xs text-amber-700">Showing progress saved ${cacheAgeLabel(cachedAt)} — reconnect to refresh.</div>` : ""}
  `;
}

document.getElementById("report-pdf-btn")?.addEventListener("click", () => {
  const term = document.getElementById("term-select").value;
  const session = document.getElementById("session-input").value.trim();
  downloadReportCardPdf(PROFILE, CURRENT_REPORT_SCORES, { term, session });
});

const MESSAGE_TRUNCATE_LENGTH = 140;

function truncateMessage(content) {
  if (content.length <= MESSAGE_TRUNCATE_LENGTH) return content;
  return content.slice(0, MESSAGE_TRUNCATE_LENGTH).trimEnd() + "…";
}

async function loadMessages() {
  const list = document.getElementById("messages-list");
  try {
    const col = POCKETBASE_CONFIG.collections.messages;
    const [schoolWide, classWide, personal] = await Promise.all([
      databases.listDocuments(POCKETBASE_CONFIG.databaseId, col, [Query.equal("scope", "school"), Query.orderDesc("$createdAt"), Query.limit(20)]),
      databases.listDocuments(POCKETBASE_CONFIG.databaseId, col, [Query.equal("scope", "class"), Query.equal("target", PROFILE.class_name || ""), Query.orderDesc("$createdAt"), Query.limit(20)]),
      databases.listDocuments(POCKETBASE_CONFIG.databaseId, col, [Query.equal("scope", "student"), Query.equal("target", PROFILE.school_id), Query.orderDesc("$createdAt"), Query.limit(20)]),
    ]);

    const all = [
      ...schoolWide.documents,
      ...classWide.documents,
      ...personal.documents,
    ].sort((a, b) => new Date(b.$createdAt) - new Date(a.$createdAt));

    MESSAGES_CACHE = all;
    animateCount(document.getElementById("p-message-count"), all.length);

    list.innerHTML = all.map((m, i) => {
      const isLong = m.content.length > MESSAGE_TRUNCATE_LENGTH;
      return `
        <div class="border border-ink/10 rounded-xl p-4 stagger-item${isLong ? " lift cursor-pointer" : ""}" style="--i:${i}" data-msg-index="${i}" data-expanded="false">
          <div class="flex items-center justify-between mb-1">
            <span class="pill ${m.scope === "student" ? "pill-green" : "pill-gray"}">${m.scope === "school" ? "School-wide" : m.scope === "class" ? "Class" : "For you"}</span>
            <span class="text-xs text-ink/40">${new Date(m.$createdAt).toLocaleDateString()}</span>
          </div>
          <p class="text-sm text-ink/80 message-text">${truncateMessage(m.content)}</p>
          ${isLong ? `<button type="button" class="message-toggle text-xs font-semibold text-forest-700 mt-2">Read more</button>` : ""}
        </div>
      `;
    }).join("") || `<p class="text-sm text-ink/40">No messages yet.</p>`;
  } catch (err) {
    console.error(err);
    list.innerHTML = `<p class="text-sm text-red-600">Couldn't load messages.</p>`;
  }
}

document.getElementById("messages-list").addEventListener("click", (e) => {
  const card = e.target.closest("[data-msg-index]");
  if (!card) return;

  const toggleBtn = card.querySelector(".message-toggle");
  if (!toggleBtn) return; // short messages aren't truncated, nothing to expand

  const msg = MESSAGES_CACHE[Number(card.dataset.msgIndex)];
  if (!msg) return;

  const textEl = card.querySelector(".message-text");
  const expanded = card.dataset.expanded === "true";

  textEl.textContent = expanded ? truncateMessage(msg.content) : msg.content;
  toggleBtn.textContent = expanded ? "Read more" : "Show less";
  card.dataset.expanded = expanded ? "false" : "true";
});

/* ---------- Library ---------- */

/** Toggles which section(s) are visible based on the chosen scope. */
function applyLibraryScope() {
  document.getElementById("lib-school-section").classList.toggle("hidden", LIBRARY_SCOPE === "digital");
  document.getElementById("lib-digital-section").classList.toggle("hidden", LIBRARY_SCOPE === "school");
}

document.querySelectorAll(".lib-scope-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    LIBRARY_SCOPE = btn.dataset.scope;
    document.querySelectorAll(".lib-scope-btn").forEach((b) => b.classList.toggle("active", b === btn));
    applyLibraryScope();
  });
});

/** School-uploaded materials (from the admin's Library tab). Only
 * shows materials that are either open to every class, or match this
 * student's own class — mirrors how class-scoped messages work. */
async function loadSchoolMaterials(searchTerm = "") {
  const list = document.getElementById("lib-school-list");
  const cacheKey = "materials";
  list.innerHTML = `<div class="skeleton h-20 rounded-xl sm:col-span-2"></div>`;

  try {
    const { documents } = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.materials, [Query.orderDesc("$createdAt"), Query.limit(100)]);
    SCHOOL_MATERIALS_CACHE = documents.filter((m) => !m.class_name || m.class_name === PROFILE.class_name);
    cacheSet(cacheKey, SCHOOL_MATERIALS_CACHE);
    renderSchoolMaterials(searchTerm);
  } catch (err) {
    console.error(err);
    if (isNetworkError(err)) {
      const cached = cacheGet(cacheKey);
      if (cached) {
        showOfflineBanner(true);
        SCHOOL_MATERIALS_CACHE = cached.data;
        renderSchoolMaterials(searchTerm, cached.cachedAt);
        return;
      }
    }
    list.innerHTML = `<p class="text-sm text-red-600 sm:col-span-2">Couldn't load school materials.</p>`;
  }
}

function renderSchoolMaterials(searchTerm = "", cachedAt = null) {
  const list = document.getElementById("lib-school-list");
  let rows = SCHOOL_MATERIALS_CACHE;
  if (searchTerm) {
    const t = searchTerm.toLowerCase();
    rows = rows.filter((m) =>
      m.title.toLowerCase().includes(t) ||
      (m.subject || "").toLowerCase().includes(t) ||
      (m.description || "").toLowerCase().includes(t)
    );
  }

  const cacheNote = cachedAt ? `<p class="text-xs text-amber-700 sm:col-span-2 mb-1">Showing materials saved ${cacheAgeLabel(cachedAt)} — opening a file still needs a connection.</p>` : "";

  list.innerHTML = cacheNote + (rows.map((m) => `
    <a href="${materialFileUrl(m)}" target="_blank" rel="noopener" class="lift border border-ink/10 rounded-xl p-4 block hover:border-forest-600">
      <div class="flex items-center justify-between mb-1">
        <span class="pill pill-green">${escapeHtml(m.subject || "General")}</span>
        <span class="text-xs text-ink/40">${escapeHtml(m.class_name || "All classes")}</span>
      </div>
      <p class="font-display font-semibold mt-1">${escapeHtml(m.title)}</p>
      ${m.description ? `<p class="text-sm text-ink/60 mt-1 line-clamp-2">${escapeHtml(m.description)}</p>` : ""}
      <p class="text-xs text-forest-700 font-medium mt-2">Open →</p>
    </a>
  `).join("") || `<p class="text-sm text-ink/40 sm:col-span-2">${searchTerm ? "No school materials match your search." : "No school materials uploaded yet."}</p>`);
}

/** Free educational-books search via the Google Books API — no key
 * required for public searches (just a lower daily quota), and it
 * reliably supports CORS for client-side fetch() calls. Each result
 * also carries a Google Books volume id so it can be opened with the
 * Embedded Viewer instead of leaving the site. Paginated with
 * startIndex so the caller can keep asking for the next page as the
 * student scrolls. https://developers.google.com/books/docs/v1/using */
async function fetchGoogleBooksPage(query, startIndex) {
  const keyParam = GOOGLE_BOOKS_API_KEY ? `&key=${GOOGLE_BOOKS_API_KEY}` : "";
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&startIndex=${startIndex}&maxResults=${LIBRARY_PAGE_SIZE}&printType=books${keyParam}`;

  const retryableStatuses = new Set([429, 500, 502, 503, 504]);
  let res = await fetch(url);
  let attempt = 0;
  while (retryableStatuses.has(res.status) && attempt < 2) {
    attempt++;
    // Backs off a bit longer each retry (1.2s, then 2.4s) — covers both
    // a bursty rate limit (429) and Google's backend having a brief
    // hiccup (5xx), without making students wait too long.
    await new Promise((r) => setTimeout(r, 1200 * attempt));
    res = await fetch(url);
  }
  if (!res.ok) throw new Error(`Google Books returned ${res.status}`);
  const data = await res.json();
  const items = data.items || [];
  const totalItems = data.totalItems || 0;

  const books = items.map((b) => {
    const info = b.volumeInfo || {};
    const rawCover = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || "";
    // Google sometimes returns http:// cover URLs, which get silently
    // blocked as mixed content on an https:// site — force https.
    const cover = rawCover ? rawCover.replace(/^http:\/\//, "https://") : null;
    const author = (info.authors || []).slice(0, 2).join(", ") || "Unknown author";
    const link = info.infoLink || info.previewLink || `https://books.google.com/books?id=${b.id}`;
    const year = info.publishedDate ? info.publishedDate.slice(0, 4) : "";
    return {
      source: "Google Books",
      sourcePill: "pill-gray",
      title: info.title || "Untitled",
      author, year, cover, link,
      readerType: "google",
      googleVolumeId: b.id,
    };
  });

  return { books, hasMore: startIndex + items.length < totalItems && items.length > 0 };
}

/** Educational books via the Open Library Search API — a free,
 * keyless catalog of 40M+ books maintained by the Internet Archive.
 * When a result has a scanned full text on archive.org (its "ia" id),
 * that text can be read right inside the reader modal below instead
 * of sending the student to another site. Paginated with `page` so
 * the caller can keep asking for more as the student scrolls.
 * https://openlibrary.org/dev/docs/api/search */
async function fetchOpenLibraryPage(query, page) {
  const fields = "key,title,author_name,first_publish_year,cover_i,ia";
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${LIBRARY_PAGE_SIZE}&page=${page}&fields=${fields}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open Library returned ${res.status}`);
  const data = await res.json();
  const docs = data.docs || [];
  const numFound = data.numFound || 0;

  const books = docs.map((d) => {
    const author = (d.author_name || []).slice(0, 2).join(", ") || "Unknown author";
    const iaId = Array.isArray(d.ia) && d.ia.length ? d.ia[0] : null;
    return {
      source: "Open Library",
      sourcePill: "pill-purple",
      title: d.title || "Untitled",
      author,
      year: d.first_publish_year || "",
      cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
      link: d.key ? `https://openlibrary.org${d.key}` : "https://openlibrary.org",
      readerType: iaId ? "archive" : "external",
      iaId,
    };
  });

  return { books, hasMore: page * LIBRARY_PAGE_SIZE < numFound && docs.length > 0 };
}

/** Starts a fresh digital-library search: resets pagination, shows a
 * skeleton grid, and loads the first page from both sources. Repeat
 * searches this session resume from the cached, already-loaded pages
 * instead of re-fetching from the start. */
async function searchDigitalLibrary(query) {
  const list = document.getElementById("lib-digital-list");
  const cacheKey = query.toLowerCase().trim();

  document.getElementById("lib-digital-end").classList.add("hidden");

  if (DIGITAL_LIBRARY_CACHE.has(cacheKey)) {
    LIBRARY_SESSION = DIGITAL_LIBRARY_CACHE.get(cacheKey);
    LIBRARY_BOOK_MAP.clear();
    renderDigitalLibraryFull();
    return;
  }

  list.innerHTML = Array.from({ length: 6 }).map(() => `
    <div class="book-skeleton">
      <div class="skeleton sk-cover"></div>
      <div class="flex-1">
        <div class="skeleton sk-line w-1/3"></div>
        <div class="skeleton sk-line w-full"></div>
        <div class="skeleton sk-line w-2/3"></div>
      </div>
    </div>
  `).join("");
  document.getElementById("lib-digital-count").textContent = "";

  LIBRARY_SESSION = {
    query: cacheKey,
    results: [],
    googleStart: 0,
    olPage: 1,
    hasMoreGoogle: true,
    hasMoreOpenLibrary: true,
    loadingMore: false,
  };
  LIBRARY_BOOK_MAP.clear();

  await loadMoreDigitalLibrary({ isFirstLoad: true });
  DIGITAL_LIBRARY_CACHE.set(cacheKey, LIBRARY_SESSION);
}

/** Fetches the next page from whichever source(s) still have more
 * results, appends them to the grid, and updates the pagination
 * cursors. Called on first load and again every time the scroll
 * sentinel comes into view. */
async function loadMoreDigitalLibrary({ isFirstLoad = false } = {}) {
  const session = LIBRARY_SESSION;
  if (!session || session.loadingMore) return;
  if (!session.hasMoreGoogle && !session.hasMoreOpenLibrary) return;

  const list = document.getElementById("lib-digital-list");
  const searchBtn = document.getElementById("lib-search-btn");
  const loadMoreEl = document.getElementById("lib-digital-loadmore");

  session.loadingMore = true;
  if (isFirstLoad) searchBtn.classList.add("lib-searching");
  else { loadMoreEl.classList.remove("hidden"); loadMoreEl.classList.add("flex"); }

  const [googleRes, olRes] = await Promise.all([
    session.hasMoreGoogle
      ? fetchGoogleBooksPage(session.query, session.googleStart).catch((err) => ({ error: err }))
      : Promise.resolve({ books: [], hasMore: false }),
    session.hasMoreOpenLibrary
      ? fetchOpenLibraryPage(session.query, session.olPage).catch((err) => ({ error: err }))
      : Promise.resolve({ books: [], hasMore: false }),
  ]);

  if (googleRes.error) { session.hasMoreGoogle = false; console.error("Google Books search failed:", googleRes.error); }
  else { session.hasMoreGoogle = googleRes.hasMore; session.googleStart += LIBRARY_PAGE_SIZE; }

  if (olRes.error) { session.hasMoreOpenLibrary = false; console.error("Open Library search failed:", olRes.error); }
  else { session.hasMoreOpenLibrary = olRes.hasMore; session.olPage += 1; }

  session.loadingMore = false;
  if (isFirstLoad) searchBtn.classList.remove("lib-searching");
  loadMoreEl.classList.remove("flex");
  loadMoreEl.classList.add("hidden");

  if (googleRes.error && olRes.error) {
    if (isFirstLoad) list.innerHTML = `<p class="text-sm text-red-600 sm:col-span-2">Couldn't reach the digital library right now. Try again in a moment.</p>`;
    return;
  }

  // Interleave so the grid mixes sources instead of showing all of one
  // provider's results before the other's.
  const googleBooks = googleRes.books || [];
  const olBooks = olRes.books || [];
  const merged = [];
  const max = Math.max(googleBooks.length, olBooks.length);
  for (let i = 0; i < max; i++) {
    if (googleBooks[i]) merged.push(googleBooks[i]);
    if (olBooks[i]) merged.push(olBooks[i]);
  }

  const startIndex = session.results.length;
  session.results.push(...merged);

  if (isFirstLoad && !session.results.length) {
    list.innerHTML = `<p class="text-sm text-ink/40 sm:col-span-2">No results for "${escapeHtml(session.query)}".</p>`;
  } else {
    if (isFirstLoad) list.innerHTML = "";
    appendBooksToGrid(merged, startIndex);
  }

  document.getElementById("lib-digital-count").textContent =
    `${session.results.length} result${session.results.length === 1 ? "" : "s"}`;
  document.getElementById("lib-digital-end").classList.toggle(
    "hidden",
    !(session.results.length && !session.hasMoreGoogle && !session.hasMoreOpenLibrary)
  );
}

/** Builds a book card. Cards are buttons (not links) — clicking one
 * opens the in-site reader modal instead of navigating away. */
function bookCardHtml(b, key, i) {
  return `
    <button type="button" data-book-key="${key}" class="lift book-card stagger-item border border-ink/10 rounded-xl p-4 flex gap-3 text-left w-full bg-white" style="--i:${i % 8}">
      <div class="book-cover-wrap w-14 h-20 shrink-0">
        ${b.cover
          ? `<img src="${b.cover}" alt="" class="book-cover w-14 h-20 object-cover rounded-md border border-ink/10" loading="lazy" onerror="this.closest('.book-cover-wrap').innerHTML='<div class=&quot;w-14 h-20 rounded-md bg-mint-100 grid place-items-center text-forest-700 text-xs font-semibold&quot;>No cover</div>'" />`
          : `<div class="w-14 h-20 rounded-md bg-mint-100 grid place-items-center text-forest-700 text-xs font-semibold">No cover</div>`}
      </div>
      <div class="min-w-0">
        <span class="pill ${b.sourcePill}">${escapeHtml(b.source)}</span>
        <p class="font-display font-semibold mt-1 truncate">${escapeHtml(b.title)}</p>
        <p class="text-sm text-ink/60">${escapeHtml(b.author)}${b.year ? " · " + escapeHtml(String(b.year)) : ""}</p>
        <p class="text-xs text-forest-700 font-medium mt-2">${b.readerType === "external" ? "Details →" : "Read now →"}</p>
      </div>
    </button>
  `;
}

/** Appends newly-fetched books to the end of the grid (used by
 * infinite scroll) without touching what's already rendered. */
function appendBooksToGrid(books, startIndex) {
  const list = document.getElementById("lib-digital-list");
  const html = books.map((b, i) => {
    const key = `b${startIndex + i}`;
    LIBRARY_BOOK_MAP.set(key, b);
    return bookCardHtml(b, key, startIndex + i);
  }).join("");
  list.insertAdjacentHTML("beforeend", html);
}

/** Re-renders the entire grid from LIBRARY_SESSION.results — used
 * when restoring a cached search from earlier this session. */
function renderDigitalLibraryFull() {
  const list = document.getElementById("lib-digital-list");
  const session = LIBRARY_SESSION;
  if (!session.results.length) {
    list.innerHTML = `<p class="text-sm text-ink/40 sm:col-span-2">No results for "${escapeHtml(session.query)}".</p>`;
  } else {
    list.innerHTML = session.results.map((b, i) => {
      const key = `b${i}`;
      LIBRARY_BOOK_MAP.set(key, b);
      return bookCardHtml(b, key, i);
    }).join("");
  }
  document.getElementById("lib-digital-count").textContent =
    session.results.length ? `${session.results.length} result${session.results.length === 1 ? "" : "s"}` : "";
  document.getElementById("lib-digital-end").classList.toggle(
    "hidden",
    !(session.results.length && !session.hasMoreGoogle && !session.hasMoreOpenLibrary)
  );
}

document.getElementById("lib-digital-list").addEventListener("click", (e) => {
  const card = e.target.closest("[data-book-key]");
  if (!card) return;
  const book = LIBRARY_BOOK_MAP.get(card.dataset.bookKey);
  if (book) openBookReader(book);
});

// Infinite scroll: fetch the next page once the sentinel below the
// grid comes near the viewport. Works whether the whole page scrolls
// or the tab content scrolls — root: null tracks the viewport.
const libraryScrollObserver = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting) loadMoreDigitalLibrary({ isFirstLoad: false });
}, { rootMargin: "600px" });
libraryScrollObserver.observe(document.getElementById("lib-digital-sentinel"));


/* ---------- In-site book reader ---------- */

let GOOGLE_VIEWER_SCRIPT_LOADING = null; // Promise, shared across calls so the script tag is only injected once

function loadGoogleBooksScript() {
  if (window.google?.books) return Promise.resolve();
  if (GOOGLE_VIEWER_SCRIPT_LOADING) return GOOGLE_VIEWER_SCRIPT_LOADING;
  GOOGLE_VIEWER_SCRIPT_LOADING = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://www.google.com/books/jsapi.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google Books viewer script failed to load"));
    document.body.appendChild(script);
  });
  return GOOGLE_VIEWER_SCRIPT_LOADING;
}

/** Renders the Google Books Embedded Viewer (a preview, not always
 * the full book) directly inside our own reader modal — the official
 * embed API, so nothing leaves Chuvera. */
async function renderGoogleViewer(volumeId, bodyEl) {
  try {
    await loadGoogleBooksScript();
    google.books.load();
    google.books.setOnLoadCallback(() => {
      if (!document.body.contains(bodyEl)) return; // modal was closed before this fired
      bodyEl.innerHTML = `<div id="google-viewer-canvas" class="w-full h-full"></div>`;
      const viewer = new google.books.DefaultViewer(document.getElementById("google-viewer-canvas"));
      viewer.load(
        volumeId,
        () => { bodyEl.innerHTML = readerFallbackHtml("Google Books", `https://books.google.com/books?id=${volumeId}`, "No preview is available for this book."); }
      );
    });
  } catch (err) {
    console.error(err);
    bodyEl.innerHTML = readerFallbackHtml("Google Books", `https://books.google.com/books?id=${volumeId}`, "Couldn't load the preview right now.");
  }
}

function readerFallbackHtml(sourceName, link, message) {
  return `
    <div class="h-full grid place-items-center text-center p-6">
      <div>
        <p class="text-sm text-ink/60 mb-3">${escapeHtml(message)}</p>
        <a href="${link}" target="_blank" rel="noopener" class="text-forest-700 font-semibold text-sm">Open on ${escapeHtml(sourceName)} →</a>
      </div>
    </div>`;
}

function openBookReader(book) {
  const modal = document.getElementById("book-reader-modal");
  const body = document.getElementById("reader-body");

  document.getElementById("reader-title").textContent = book.title;
  document.getElementById("reader-meta").textContent = `${book.author}${book.year ? " · " + book.year : ""} · ${book.source}`;

  modal.classList.remove("hidden");
  modal.classList.add("flex");
  document.body.style.overflow = "hidden";

  if (book.readerType === "archive" && book.iaId) {
    body.innerHTML = `
      <div class="absolute inset-0 grid place-items-center"><div class="reader-loading-spin"></div></div>
      <iframe src="https://archive.org/embed/${encodeURIComponent(book.iaId)}" title="${escapeHtml(book.title)}" class="w-full h-full border-0 relative" allowfullscreen onload="this.previousElementSibling.remove()"></iframe>
    `;
  } else if (book.readerType === "google" && book.googleVolumeId) {
    body.innerHTML = `<div class="absolute inset-0 grid place-items-center"><div class="reader-loading-spin"></div></div>`;
    renderGoogleViewer(book.googleVolumeId, body);
  } else {
    body.innerHTML = readerFallbackHtml(book.source, book.link, `A reader isn't available inside Chuvera for this one — it opens on ${book.source} instead.`);
  }
}

function closeBookReader() {
  const modal = document.getElementById("book-reader-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  document.getElementById("reader-body").innerHTML = "";
  document.body.style.overflow = "";
}

document.getElementById("reader-close").addEventListener("click", closeBookReader);
document.getElementById("book-reader-modal").addEventListener("click", (e) => {
  if (e.target.id === "book-reader-modal") closeBookReader();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("book-reader-modal").classList.contains("hidden")) closeBookReader();
});

function runLibrarySearch() {
  const q = document.getElementById("lib-search-input").value.trim();
  if (LIBRARY_SCOPE !== "digital") renderSchoolMaterials(q);
  if (LIBRARY_SCOPE !== "school") searchDigitalLibrary(q || "education");
}

document.getElementById("lib-search-btn").addEventListener("click", runLibrarySearch);
document.getElementById("lib-search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runLibrarySearch();
  }
});
document.getElementById("lib-search-input").addEventListener("input", debounce(() => {
  if (LIBRARY_SCOPE !== "digital") renderSchoolMaterials(document.getElementById("lib-search-input").value.trim());
}, 300));

/* ---------- CBT tests ---------- */
let CBT_ATTEMPTS_CACHE = [];
let CBT_CURRENT_TEST = null;
let cbtTimerInterval = null;
let cbtSecondsLeft = 0;

function showCbtListView() {
  clearInterval(cbtTimerInterval);
  document.getElementById("cbt-list-view").classList.remove("hidden");
  document.getElementById("cbt-take-view").classList.add("hidden");
  document.getElementById("cbt-result-view").classList.add("hidden");
}

async function loadCbtList() {
  const availableEl = document.getElementById("cbt-available-list");
  const completedEl = document.getElementById("cbt-completed-list");
  const cacheKey = "cbt_list";
  availableEl.innerHTML = `<div class="skeleton h-10 rounded-lg"></div>`;
  completedEl.innerHTML = "";

  let tests, attempts, cachedAt = null;
  try {
    const [testsRes, attemptsRes] = await Promise.all([
      databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.cbtTests, [
        Query.equal("class_name", PROFILE.class_name || ""),
        Query.equal("published", true),
        Query.limit(100),
      ]),
      databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.cbtAttempts, [
        Query.equal("student_auth_id", PROFILE.$id),
        Query.limit(200),
      ]),
    ]);
    // A test with no arm set targets the whole class (visible to
    // everyone in it); a test with an arm set only reaches students
    // in that specific arm. Filtered here rather than in the query
    // since it's an OR condition (no arm OR matches mine).
    tests = testsRes.documents.filter((t) => !t.arm || t.arm === PROFILE.arm);
    attempts = attemptsRes.documents;
    cacheSet(cacheKey, { tests, attempts });
  } catch (err) {
    console.error(err);
    if (isNetworkError(err)) {
      const cached = cacheGet(cacheKey);
      if (cached) {
        showOfflineBanner(true);
        tests = cached.data.tests;
        attempts = cached.data.attempts;
        cachedAt = cached.cachedAt;
      }
    }
    if (!tests) {
      availableEl.innerHTML = `<p class="text-sm text-red-600">Couldn't load tests.</p>`;
      return;
    }
  }

  CBT_ATTEMPTS_CACHE = attempts;
  const attemptedTestIds = new Set(CBT_ATTEMPTS_CACHE.map((a) => a.test_id));
  const mySubjects = PROFILE.subjects || [];

  const eligibleTests = tests.filter((t) => mySubjects.includes(t.subject));
  const availableTests = eligibleTests.filter((t) => !attemptedTestIds.has(t.$id));

  // Starting a test needs to reach the server both to fetch the
  // questions fresh and to save the graded attempt afterward — so
  // while offline (or showing a stale cached list), the button is
  // disabled rather than letting someone start a test they can't submit.
  const offline = cachedAt !== null || !navigator.onLine;
  const cacheNote = cachedAt ? `<p class="text-xs text-amber-700 mb-1">Showing tests saved ${cacheAgeLabel(cachedAt)} — reconnect to start one.</p>` : "";

  availableEl.innerHTML = cacheNote + (availableTests.map((t, i) => {
    const qCount = (() => { try { return JSON.parse(t.questions).length; } catch { return 0; } })();
    return `
      <div class="border border-ink/10 rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap stagger-item" style="--i:${i}">
        <div>
          <p class="font-display font-semibold">${escapeHtml(t.title)}</p>
          <p class="text-xs text-ink/50 mt-1">${escapeHtml(t.subject)} · ${escapeHtml(t.term)} · ${qCount} question${qCount === 1 ? "" : "s"} · ${t.duration_minutes} min</p>
        </div>
        <button type="button" ${offline ? "disabled" : ""} class="bg-forest-800 text-white text-sm font-medium px-4 py-2 rounded-lg lift disabled:opacity-40 disabled:cursor-not-allowed" onclick="startCbtTest('${t.$id}')">Start</button>
      </div>
    `;
  }).join("") || `<p class="text-sm text-ink/40">No tests available right now.</p>`);

  const completedRows = CBT_ATTEMPTS_CACHE
    .map((a) => ({ attempt: a, test: eligibleTests.find((t) => t.$id === a.test_id) }))
    .filter((r) => r.test);

  completedEl.innerHTML = completedRows.map(({ attempt, test }, i) => `
    <div class="border border-ink/10 rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap stagger-item" style="--i:${i}">
      <div>
        <p class="font-display font-semibold">${escapeHtml(test.title)}</p>
        <p class="text-xs text-ink/50 mt-1">${escapeHtml(test.subject)} · ${escapeHtml(test.term)} · submitted ${new Date(attempt.$createdAt).toLocaleDateString()}</p>
      </div>
      <span class="pill pill-green">${attempt.score}/${attempt.total_questions}</span>
    </div>
  `).join("") || `<p class="text-sm text-ink/40">You haven't completed any tests yet.</p>`;
}

async function startCbtTest(testId) {
  let test;
  try {
    test = await databases.getDocument(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.cbtTests, testId);
  } catch (err) {
    console.error(err);
    toast("Couldn't load this test.", "error");
    return;
  }

  let questions;
  try {
    questions = JSON.parse(test.questions);
  } catch {
    toast("This test's questions couldn't be read.", "error");
    return;
  }

  CBT_CURRENT_TEST = { ...test, parsedQuestions: questions };

  document.getElementById("cbt-list-view").classList.add("hidden");
  document.getElementById("cbt-result-view").classList.add("hidden");
  document.getElementById("cbt-take-view").classList.remove("hidden");
  document.getElementById("cbt-take-title").textContent = test.title;

  document.getElementById("cbt-take-questions").innerHTML = questions.map((q, qi) => `
    <div class="cbt-take-question">
      <p class="font-medium mb-2">${qi + 1}. ${escapeHtml(q.q)}</p>
      <div class="space-y-1.5">
        ${q.options.map((opt, oi) => `
          <label class="flex items-center gap-2 text-sm px-3 py-2 rounded-lg border border-ink/10 hover:border-forest-600/40 cursor-pointer">
            <input type="radio" name="cbt-answer-${qi}" value="${oi}" />
            ${escapeHtml(opt)}
          </label>
        `).join("")}
      </div>
    </div>
  `).join("");

  cbtSecondsLeft = (test.duration_minutes || 20) * 60;
  updateCbtTimerDisplay();
  clearInterval(cbtTimerInterval);
  cbtTimerInterval = setInterval(() => {
    cbtSecondsLeft--;
    updateCbtTimerDisplay();
    if (cbtSecondsLeft <= 0) {
      clearInterval(cbtTimerInterval);
      toast("Time's up — submitting your answers.", "info");
      submitCbtTest();
    }
  }, 1000);
}

function updateCbtTimerDisplay() {
  const m = Math.max(0, Math.floor(cbtSecondsLeft / 60));
  const s = Math.max(0, cbtSecondsLeft % 60);
  document.getElementById("cbt-timer").textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

async function submitCbtTest() {
  if (!CBT_CURRENT_TEST) return;
  clearInterval(cbtTimerInterval);

  const btn = document.getElementById("cbt-submit-btn");
  btn.disabled = true;
  btn.textContent = "Submitting...";

  const questions = CBT_CURRENT_TEST.parsedQuestions;
  const answers = questions.map((_, qi) => {
    const checked = document.querySelector(`input[name="cbt-answer-${qi}"]:checked`);
    return checked ? Number(checked.value) : null;
  });
  const score = answers.reduce((sum, a, i) => sum + (a === questions[i].correct ? 1 : 0), 0);

  try {
    await databases.createDocument(
      POCKETBASE_CONFIG.databaseId,
      POCKETBASE_CONFIG.collections.cbtAttempts,
      ID.unique(),
      {
        test_id: CBT_CURRENT_TEST.$id,
        student_auth_id: PROFILE.$id,
        student_name: PROFILE.full_name,
        class_name: PROFILE.class_name || "",
        subject: CBT_CURRENT_TEST.subject,
        term: CBT_CURRENT_TEST.term,
        answers: JSON.stringify(answers),
        score,
        total_questions: questions.length,
      },
      [Permission.read(Role.user(PROFILE.$id))]
    );

    const pct = Math.round((score / questions.length) * 100);
    document.getElementById("cbt-take-view").classList.add("hidden");
    document.getElementById("cbt-result-view").classList.remove("hidden");
    document.getElementById("cbt-result-score").textContent = `${score}/${questions.length}`;
    document.getElementById("cbt-result-pct").textContent = `${pct}%`;
    if (pct >= 70) launchConfetti();
  } catch (err) {
    console.error(err);
    toast(err.message || "Couldn't submit the test. You can try again.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Submit test";
  }
}

document.getElementById("cbt-submit-btn").addEventListener("click", () => {
  if (confirm("Submit your answers? You can't retake this test afterward.")) submitCbtTest();
});

document.getElementById("cbt-result-back").addEventListener("click", () => {
  CBT_CURRENT_TEST = null;
  showCbtListView();
  loadCbtList();
});

/** Gentle 3D tilt on the ID badge as the pointer moves over it — a
 * small tactile touch that makes the "physical card" feel handled. */
function enableBadgeTilt() {
  const badge = document.querySelector("#tab-overview .id-badge");
  if (!badge || window.matchMedia("(prefers-reduced-motion: reduce)").matches || !window.matchMedia("(hover: hover)").matches) return;
  badge.addEventListener("mousemove", (e) => {
    const rect = badge.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    badge.style.transform = `perspective(800px) rotateX(${(-y * 8).toFixed(2)}deg) rotateY(${(x * 8).toFixed(2)}deg)`;
  });
  badge.addEventListener("mouseleave", () => {
    badge.style.transform = "perspective(800px) rotateX(0deg) rotateY(0deg)";
  });
}

(async function init() {
  const session = await requireSession("student");
  if (!session) return;
  // Merge the Appwrite user id onto the profile so downstream code
  // (loadScores, message filters) can use PROFILE.$id as the
  // student's identity — the profile document's own $id is already
  // the same value (see functions/create-account), but this keeps
  // the field name explicit at call sites.
  PROFILE = { ...session.profile, $id: session.profile.$id };
  renderProfile(PROFILE);
  initTabRouter("overview");
  enableBadgeTilt();
  await Promise.all([loadScores(), loadMessages()]);

  // Live updates: if an admin edits this student's class, arm,
  // department, or subjects (or a class-wide edit cascades a subject
  // onto them) while this dashboard is open, reflect it immediately
  // instead of waiting for the next login/refresh.
  subscribeToDocument(POCKETBASE_CONFIG.collections.students, PROFILE.$id, (event) => {
    if (event.events.some((e) => e.endsWith(".delete"))) {
      toast("Your account was removed by the school.", "error");
      setTimeout(() => logout("index.html"), 1500);
      return;
    }
    PROFILE = { ...PROFILE, ...event.payload };
    renderProfile(PROFILE);
    const activeMessagesTab = !document.getElementById("tab-messages").classList.contains("hidden");
    if (activeMessagesTab) loadMessages(); // class-scoped messages depend on class_name
    toast("Your class/subject info was just updated.", "info");
  });
})();