/* ============================================================
   POCKETBASE CONFIGURATION + COMPATIBILITY SHIM
   ------------------------------------------------------------
   This is the ONLY file you should need to edit to point the site
   at your own PocketBase instance.

   Why a "shim": the rest of the app (admin.js, staff.js, student.js,
   utils.js) was written against Appwrite's SDK shapes — `databases`,
   `account`, `Query`, `ID`, `Permission`/`Role`, `$id`/`$createdAt`
   on records, `client.subscribe()`. Rather than rewrite ~3,000 lines
   of DOM/business logic, this file re-implements that same surface
   on top of the PocketBase SDK, so most of the app's code is
   untouched. The few places that genuinely work differently in
   PocketBase (login, file uploads, saving scores, account creation)
   are edited directly in their own files — see README-POCKETBASE.md.
   ============================================================ */

const POCKETBASE_CONFIG = {
  // Your PocketBase server's URL (self-hosted VPS, PocketHost, etc.)
  url: "https://pocketbase-production-d273.up.railway.app",

  // Unused — PocketBase has no separate "database" concept, only
  // collections. Kept only because a few call sites (ported as-is
  // from the Appwrite version) still pass POCKETBASE_CONFIG.databaseId
  // as the first argument to databases.*() below; the shim ignores it.
  databaseId: undefined,

  // These names must match the collections created by
  // scripts/setup-pocketbase.js (see README-POCKETBASE.md).
  collections: {
    classes: "classes",
    students: "students",
    staff: "staff",
    admins: "admins",
    scores: "scores",
    messages: "messages",
    materials: "materials",
    cbtTests: "cbt_tests",
    cbtAttempts: "cbt_attempts",
  },

  // The school this site is built for. Used to build the ID prefix
  // (first 3 letters, uppercase) e.g. "Chuvera" -> "CHU". Keep this
  // in sync with SCHOOL_NAME in pb_hooks/main.pb.js.
  schoolName: "Chuvera",

  // Synthetic, non-deliverable email domains used to turn "ID +
  // password" into a PocketBase auth record under the hood. Never
  // shown to users. Must match pb_hooks/main.pb.js.
  studentEmailDomain: "students.eliasschool.local",
  staffEmailDomain: "staff.eliasschool.local",
};

/** Build the synthetic auth email for a given school ID + role. */
function idToEmail(schoolId, role) {
  const id = schoolId.trim().toLowerCase();
  const domain = role === "staff" ? POCKETBASE_CONFIG.staffEmailDomain : POCKETBASE_CONFIG.studentEmailDomain;
  return `${id}@${domain}`;
}

// The PocketBase Web SDK CDN build exposes the constructor as
// window.PocketBase.
const pb = new PocketBase(POCKETBASE_CONFIG.url);

/** Normalizes a PocketBase record to also carry Appwrite-style
 * $id / $createdAt / $updatedAt aliases, since admin.js/staff.js/
 * student.js read those everywhere (e.g. `s.$id`, `m.$createdAt`).
 * PocketBase's native `id` / `created` / `updated` stay too, so
 * nothing is lost either way. */
function normalizeRecord(rec) {
  if (!rec || typeof rec !== "object") return rec;
  if (!("$id" in rec)) rec.$id = rec.id;
  if (!("$createdAt" in rec)) rec.$createdAt = rec.created;
  if (!("$updatedAt" in rec)) rec.$updatedAt = rec.updated;
  return rec;
}

/** Normalizes a caught PocketBase ClientResponseError so
 * isNetworkError() (js/offline.js) keeps working unchanged: it
 * checks `err.code === undefined`, which was true for Appwrite's
 * plain-Error-on-network-failure case. PocketBase sets `status: 0`
 * for that same case, so we translate 0 -> undefined here. */
function normalizeError(err) {
  if (err && typeof err === "object") {
    err.code = err.status === 0 || err.status === undefined ? undefined : err.status;
    err.type = err.data?.code || err.type;
  }
  return err;
}

/* ============================================================
   Query — mirrors Appwrite's Query.* builder just enough for how
   this app uses it (equal/contains/limit/orderAsc/orderDesc).
   Each call returns a small descriptor; databases.listDocuments()
   below turns the array of descriptors into a PocketBase filter
   string + sort + page size.
   ============================================================ */
const Query = {
  equal: (field, value) => ({ kind: "equal", field, value }),
  contains: (field, value) => ({ kind: "contains", field, value }),
  limit: (n) => ({ kind: "limit", value: n }),
  orderAsc: (field) => ({ kind: "sort", value: field === "$createdAt" ? "+created" : `+${field}` }),
  orderDesc: (field) => ({ kind: "sort", value: field === "$createdAt" ? "-created" : `-${field}` }),
};

/** Escapes a value for safe interpolation into a PocketBase filter
 * string (PocketBase filters are a small expression language, not
 * parameterized like SQL — string values need their own quoting). */
function pbFilterValue(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildFilterAndOptions(queries = []) {
  const clauses = [];
  let perPage = 50;
  let sort = "";
  for (const q of queries) {
    if (q.kind === "equal") clauses.push(`${q.field} = ${pbFilterValue(q.value)}`);
    else if (q.kind === "contains") clauses.push(`${q.field} ~ ${pbFilterValue(q.value)}`);
    else if (q.kind === "limit") perPage = q.value;
    else if (q.kind === "sort") sort = q.value;
  }
  const options = { perPage };
  // Only include filter/sort when actually set — PocketBase's SDK is
  // pickier about an explicitly-empty filter string than Appwrite's
  // Query builder was, so omitting the key entirely (rather than
  // sending "") is the safe way to say "no filter"/"default sort".
  if (clauses.length) options.filter = clauses.join(" && ");
  if (sort) options.sort = sort;
  return options;
}

/* ============================================================
   databases — mirrors Appwrite's Databases class (listDocuments,
   getDocument, createDocument, updateDocument, deleteDocument).
   The first argument (databaseId) is accepted for call-site
   compatibility but ignored — PocketBase has no separate database
   concept, just collections.
   ============================================================ */
const databases = {
  async listDocuments(_databaseId, collectionId, queries = []) {
    try {
      // requestKey: null disables PocketBase's automatic request
      // cancellation. By default, the SDK cancels an in-flight
      // request if another one to the SAME collection starts before
      // it finishes — fine for a search-as-you-type box, but this
      // app fires several independent queries to the same collection
      // at once on page load (e.g. a full student list AND a
      // students-count-only query for the stats cards), and Appwrite
      // never had this behavior, so silently losing one of them isn't
      // something any call site here is written to expect or retry.
      const options = { ...buildFilterAndOptions(queries), requestKey: null };
      const result = await pb.collection(collectionId).getList(1, options.perPage || 50, options);
      result.items.forEach(normalizeRecord);
      return { documents: result.items, total: result.totalItems };
    } catch (err) {
      throw normalizeError(err);
    }
  },

  async getDocument(_databaseId, collectionId, documentId) {
    try {
      const rec = await pb.collection(collectionId).getOne(documentId, { requestKey: null });
      return normalizeRecord(rec);
    } catch (err) {
      throw normalizeError(err);
    }
  },

  async createDocument(_databaseId, collectionId, _documentId, data /*, _permissions */) {
    try {
      const rec = await pb.collection(collectionId).create(data, { requestKey: null });
      return normalizeRecord(rec);
    } catch (err) {
      throw normalizeError(err);
    }
  },

  async updateDocument(_databaseId, collectionId, documentId, data /*, _permissions */) {
    try {
      const rec = await pb.collection(collectionId).update(documentId, data, { requestKey: null });
      return normalizeRecord(rec);
    } catch (err) {
      throw normalizeError(err);
    }
  },

  async deleteDocument(_databaseId, collectionId, documentId) {
    try {
      await pb.collection(collectionId).delete(documentId, { requestKey: null });
    } catch (err) {
      throw normalizeError(err);
    }
  },
};

/* ============================================================
   ID — Appwrite's ID.unique() is called at call sites just to get
   a placeholder document ID; PocketBase auto-generates its own ID
   when you don't pass one, so this is a harmless no-op kept only
   so those call sites don't need editing.
   ============================================================ */
const ID = { unique: () => undefined };

/* ============================================================
   Permission / Role — Appwrite's per-document permission grants
   (e.g. "let this one student read this one score"). PocketBase
   does the equivalent with API rules that reference the record's
   own fields directly (e.g. `student_auth_id = @request.auth.id`,
   set up by scripts/setup-pocketbase.js), so no per-document grant
   is needed at write time. These are no-ops kept for call-site
   compatibility — see README-POCKETBASE.md for why this is actually
   a simplification, not a workaround.
   ============================================================ */
const Permission = { read: () => undefined, write: () => undefined, update: () => undefined, delete: () => undefined };
const Role = { user: (id) => id };

/* ============================================================
   account — mirrors the handful of Appwrite Account methods this
   app calls generically (get / deleteSession). Login itself
   (createEmailPasswordSession) is intentionally NOT shimmed here:
   PocketBase auth is per-collection (you authenticate against
   "students", "staff", or "admins" directly, since each of those
   IS the auth collection now — see auth.js / admin-auth.js, which
   call pb.collection(...).authWithPassword() directly).
   ============================================================ */
const account = {
  async get() {
    if (!pb.authStore.isValid || !pb.authStore.record) {
      const err = new Error("Not authenticated");
      err.code = 401;
      throw err;
    }
    return normalizeRecord({ ...pb.authStore.record });
  },
  async deleteSession(_which) {
    pb.authStore.clear();
  },
};

/* ============================================================
   Realtime — PocketBase's native per-collection subscribe/
   unsubscribe replaces Appwrite's client.subscribe(channel).
   ============================================================ */
function subscribeToDocument(collectionId, documentId, onChange) {
  pb.collection(collectionId).subscribe(documentId, onChange);
  return () => pb.collection(collectionId).unsubscribe(documentId);
}

function subscribeToCollection(collectionId, onChange) {
  pb.collection(collectionId).subscribe("*", onChange);
  return () => pb.collection(collectionId).unsubscribe("*");
}
