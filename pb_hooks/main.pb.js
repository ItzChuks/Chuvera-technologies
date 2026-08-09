/// <reference path="../pb_data/types.d.ts" />

/* ============================================================
   main.pb.js — server-side custom routes, running inside
   PocketBase's own process (the JS VM plugin — no separate Node
   service to deploy or keep alive).

   Replaces Appwrite's two Functions:
     - create-account  -> POST /api/custom/create-account
     - save-scores     -> not needed anymore. Scores can be written
       directly from staff.js, because the "scores" collection's API
       rule (see scripts/setup-pocketbase.js) lets a student read
       their OWN row via `student_auth_id = @request.auth.id`
       directly — no per-document permission grant needed the way
       Appwrite's document security required.

   NOTE ON STRUCTURE: everything each route needs lives INSIDE that
   route's own handler function — no shared top-level functions or
   consts referenced across routerAdd() calls. An earlier version
   split things into shared helper functions and hit
   "ReferenceError: ... is not defined" at request time, which
   means PocketBase's JS VM doesn't reliably share top-level
   bindings across separately-registered route handlers the way a
   normal browser script would. Duplicating the ~10 lines of
   shared logic below is the trade-off for that being reliable.

   If you upgrade PocketBase and this starts throwing
   "... is not a function" instead, check
   https://pocketbase.io/docs/js-routing/ for renamed methods.
   ============================================================ */

routerAdd(
  "POST",
  "/api/custom/create-account",
  (e) => {
    try {
      const SCHOOL_NAME = "Chuvera";
      const STUDENT_EMAIL_DOMAIN = "students.eliasschool.local";
      const STAFF_EMAIL_DOMAIN = "staff.eliasschool.local";
      const STUDENTS_COLLECTION = "students";
      const STAFF_COLLECTION = "staff";
      const ADMINS_COLLECTION = "admins";
      // Keep the two domains + SCHOOL_NAME in sync with js/pocketbase-config.js.

      const isAdmin = !!e.auth && e.auth.collection().name === ADMINS_COLLECTION;
      const isStaff = !!e.auth && e.auth.collection().name === STAFF_COLLECTION;

      if (!isAdmin && !isStaff) {
        return e.json(403, { error: "Only admins and staff can create accounts." });
      }

      const body = e.requestInfo().body || {};

      const role = body.role;
      if (role !== "student" && role !== "staff") {
        return e.json(400, { error: 'role must be "student" or "staff".' });
      }

      if (!isAdmin) {
        // Caller is staff: narrower than admin, same rules the
        // Appwrite Function enforced.
        if (role !== "student") {
          return e.json(403, { error: "Staff can only add student accounts." });
        }
        const className = (body.className || "").trim();
        const arm = (body.arm || "").trim();
        const assigned = e.auth.get("classes") || [];
        const allowed = assigned.includes(className) || (arm && assigned.includes(`${className} (${arm})`));
        if (!allowed) {
          return e.json(403, { error: "You can only add students to a class you're assigned to." });
        }
      }

      const fullName = (body.fullName || "").trim();
      if (!fullName) {
        return e.json(400, { error: "fullName is required." });
      }

      const collectionName = role === "student" ? STUDENTS_COLLECTION : STAFF_COLLECTION;
      const emailDomain = role === "student" ? STUDENT_EMAIL_DOMAIN : STAFF_EMAIL_DOMAIN;
      const prefix = SCHOOL_NAME.slice(0, 3).toUpperCase();

      // Generate a unique school ID server-side.
      let schoolId = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        const digits = String(1000 + Math.floor(Math.random() * 9000));
        const candidate = `${prefix}-${digits}`;
        try {
          e.app.findFirstRecordByFilter(collectionName, "school_id = {:id}", { id: candidate });
          // found -> taken, try again
        } catch (notFound) {
          schoolId = candidate;
          break;
        }
      }
      if (!schoolId) {
        return e.json(500, { error: "Could not generate a unique ID after several attempts. Try again." });
      }

      const email = `${schoolId.toLowerCase()}@${emailDomain}`;

      const collection = e.app.findCollectionByNameOrId(collectionName);
      const record = new Record(collection);
      record.set("email", email);
      record.set("emailVisibility", false);
      record.set("verified", true);
      record.setPassword(schoolId);
      record.set("full_name", fullName);
      record.set("school_id", schoolId);

      if (role === "student") {
        record.set("class_id", body.classId || "");
        record.set("class_name", body.className || "");
        record.set("arm", body.arm || "");
        record.set("department", body.department || "");
        record.set("subjects", body.subjects || []);
        record.set("guardian_name", body.guardianName || "");
        record.set("guardian_phone", body.guardianPhone || "");
        record.set("guardian_email", body.guardianEmail || "");
      } else {
        record.set("position", body.position || "");
        record.set("classes", body.classes || []);
        record.set("subjects", body.subjects || []);
      }

      try {
        e.app.save(record);
      } catch (err) {
        return e.json(500, { error: "Could not create the account: " + err });
      }

      return e.json(200, { schoolId, userId: record.id });
    } catch (err) {
      // Catches literally anything unexpected (a typo, a renamed
      // JSVM method after a PocketBase upgrade, etc.) and puts the
      // REAL error message in the response instead of letting it
      // fall through to PocketBase's generic "Something went
      // wrong..." text, which gives you nothing to debug from.
      return e.json(500, { error: "create-account crashed: " + err });
    }
  },
  $apis.requireAuth()
);

routerAdd(
  "POST",
  "/api/custom/delete-account",
  (e) => {
    try {
      const STUDENTS_COLLECTION = "students";
      const STAFF_COLLECTION = "staff";
      const ADMINS_COLLECTION = "admins";

      const isAdmin = !!e.auth && e.auth.collection().name === ADMINS_COLLECTION;
      if (!isAdmin) {
        return e.json(403, { error: "Only admins can delete accounts." });
      }

      const body = e.requestInfo().body || {};

      const role = body.role;
      if (role !== "student" && role !== "staff") {
        return e.json(400, { error: 'role must be "student" or "staff".' });
      }
      const userId = (body.userId || "").trim();
      if (!userId) {
        return e.json(400, { error: "userId is required." });
      }

      const collectionName = role === "student" ? STUDENTS_COLLECTION : STAFF_COLLECTION;

      let record;
      try {
        record = e.app.findRecordById(collectionName, userId);
      } catch (notFound) {
        // Already gone — treat as success (the admin might be
        // retrying after a partial earlier failure), same as the
        // Appwrite version.
        return e.json(200, { success: true });
      }

      try {
        e.app.delete(record);
      } catch (err) {
        return e.json(500, { error: "Deleting the account failed: " + err });
      }

      return e.json(200, { success: true });
    } catch (err) {
      return e.json(500, { error: "delete-account crashed: " + err });
    }
  },
  $apis.requireAuth()
);
