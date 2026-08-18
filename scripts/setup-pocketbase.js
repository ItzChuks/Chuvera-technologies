/* ============================================================
   setup-pocketbase.js — one-time schema setup.

   Creates all 9 collections (students/staff/admins as PocketBase
   AUTH collections — this is the one deliberate schema change from
   the Appwrite version; see README-POCKETBASE.md for why), their
   fields, indexes, and API rules, then optionally creates your
   first admin login.

   Usage:
     cd scripts && npm install
     POCKETBASE_URL=http://127.0.0.1:8090 \
     SUPERUSER_EMAIL=you@example.com \
     SUPERUSER_PASSWORD=your-superuser-password \
     ADMIN_EMAIL=admin@yourschool.com \
     ADMIN_PASSWORD=choose-a-strong-password \
     ADMIN_NAME="Your Name" \
     node setup-pocketbase.js

   SUPERUSER_EMAIL/PASSWORD is the PocketBase superuser account you
   created when you first opened http://127.0.0.1:8090/_/ — NOT the
   school-admin login the site itself uses. ADMIN_* creates that
   second one, for admin-auth.html.

   Safe to re-run: collections that already exist are skipped, not
   recreated (PocketBase's create API errors on a duplicate name —
   this script catches that per-collection and moves on).
   ============================================================ */

import PocketBase from "pocketbase";

const PB_URL = process.env.POCKETBASE_URL || "http://127.0.0.1:8090";
const SUPERUSER_EMAIL = process.env.SUPERUSER_EMAIL;
const SUPERUSER_PASSWORD = process.env.SUPERUSER_PASSWORD;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_NAME = process.env.ADMIN_NAME || "Admin";

if (!SUPERUSER_EMAIL || !SUPERUSER_PASSWORD) {
  console.error("Set SUPERUSER_EMAIL and SUPERUSER_PASSWORD (your PocketBase superuser login) and re-run.");
  process.exit(1);
}

const pb = new PocketBase(PB_URL);

const ADMIN = "@request.auth.collectionName = 'admins'";
const STAFF = "@request.auth.collectionName = 'staff'";
const STUDENT = "@request.auth.collectionName = 'students'";
const ANY_AUTH = "@request.auth.id != ''";

const collections = [
  {
    name: "classes",
    type: "base",
    listRule: ANY_AUTH,
    viewRule: ANY_AUTH,
    createRule: ADMIN,
    updateRule: ADMIN,
    deleteRule: ADMIN,
    fields: [
      { name: "name", type: "text", required: true },
      { name: "arms", type: "json" },
      { name: "departments", type: "json" },
      { name: "subjects", type: "json" },
    ],
  },
  {
    name: "students",
    type: "auth",
    listRule: `${ADMIN} || ${STAFF} || id = @request.auth.id`,
    viewRule: `${ADMIN} || ${STAFF} || id = @request.auth.id`,
    createRule: null, // account creation goes through pb_hooks/main.pb.js only
    updateRule: ADMIN,
    deleteRule: null, // deletion goes through pb_hooks/main.pb.js only
    passwordAuth: { enabled: true, identityFields: ["email"] },
    fields: [
      { name: "full_name", type: "text", required: true },
      { name: "school_id", type: "text", required: true },
      { name: "class_id", type: "text" },
      { name: "class_name", type: "text" },
      { name: "arm", type: "text" },
      { name: "department", type: "text" },
      { name: "subjects", type: "json" },
      { name: "guardian_name", type: "text" },
      { name: "guardian_phone", type: "text" },
      { name: "guardian_email", type: "text" },
      { name: "photo", type: "file", maxSelect: 1, maxSize: 5242880, mimeTypes: ["image/jpeg", "image/png", "image/webp"], thumbs: ["100x100"] },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_students_school_id ON students (school_id)"],
  },
  {
    name: "staff",
    type: "auth",
    listRule: `${ADMIN} || id = @request.auth.id`,
    viewRule: `${ADMIN} || id = @request.auth.id`,
    createRule: null,
    updateRule: ADMIN,
    deleteRule: null,
    passwordAuth: { enabled: true, identityFields: ["email"] },
    fields: [
      { name: "full_name", type: "text", required: true },
      { name: "school_id", type: "text", required: true },
      { name: "position", type: "text" },
      { name: "classes", type: "json" },
      { name: "subjects", type: "json" },
      { name: "photo", type: "file", maxSelect: 1, maxSize: 5242880, mimeTypes: ["image/jpeg", "image/png", "image/webp"], thumbs: ["100x100"] },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_staff_school_id ON staff (school_id)"],
  },
  {
    name: "admins",
    type: "auth",
    listRule: `${ADMIN} && id = @request.auth.id`,
    viewRule: `${ADMIN} && id = @request.auth.id`,
    createRule: null, // create your admin login via this script's ADMIN_* env vars, or the Admin UI
    updateRule: null,
    deleteRule: null,
    passwordAuth: { enabled: true, identityFields: ["email"] },
    fields: [{ name: "full_name", type: "text" }],
  },
  {
    name: "scores",
    type: "base",
    // The key simplification vs. Appwrite: a student can read their
    // OWN score directly via this rule — no per-document permission
    // grant, no server-side save-scores function needed.
    listRule: `${ADMIN} || ${STAFF} || student_auth_id = @request.auth.id`,
    viewRule: `${ADMIN} || ${STAFF} || student_auth_id = @request.auth.id`,
    createRule: `${ADMIN} || ${STAFF}`,
    updateRule: `${ADMIN} || ${STAFF}`,
    deleteRule: ADMIN,
    fields: [
      { name: "student_auth_id", type: "text", required: true },
      { name: "student_id", type: "text" },
      { name: "student_name", type: "text" },
      { name: "class_name", type: "text" },
      { name: "subject", type: "text", required: true },
      { name: "term", type: "text", required: true },
      { name: "ca1", type: "number" },
      { name: "ca2", type: "number" },
      { name: "exam", type: "number" },
      { name: "total", type: "number" },
      { name: "grade", type: "text" },
      { name: "position", type: "number" },
      { name: "teacher_remark", type: "text" },
      { name: "admin_remark", type: "text" },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_scores_unique ON scores (student_auth_id, subject, term)",
      "CREATE INDEX idx_scores_class_subject_term ON scores (class_name, subject, term)",
    ],
  },
  {
    name: "messages",
    type: "base",
    listRule: ANY_AUTH,
    viewRule: ANY_AUTH,
    createRule: `${ADMIN} || ${STAFF}`,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "scope", type: "text", required: true },
      { name: "target", type: "text" },
      { name: "content", type: "text", required: true },
      { name: "from_name", type: "text" },
    ],
    indexes: ["CREATE INDEX idx_messages_scope_target ON messages (scope, target)"],
  },
  {
    name: "materials",
    type: "base",
    listRule: ANY_AUTH,
    viewRule: ANY_AUTH,
    createRule: ADMIN,
    updateRule: ADMIN,
    deleteRule: ADMIN,
    fields: [
      { name: "title", type: "text", required: true },
      { name: "description", type: "text" },
      { name: "subject", type: "text" },
      { name: "class_name", type: "text" },
      {
        name: "file",
        type: "file",
        maxSelect: 1,
        maxSize: 31457280, // 30MB, matches the original bucket setting
        mimeTypes: [
          "application/pdf",
          "application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "application/vnd.ms-powerpoint",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "application/vnd.ms-excel",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "text/plain",
        ],
      },
      { name: "file_name", type: "text" },
      { name: "uploaded_by", type: "text" },
    ],
    indexes: ["CREATE INDEX idx_materials_subject ON materials (subject)", "CREATE INDEX idx_materials_class_name ON materials (class_name)"],
  },
  {
    name: "cbt_tests",
    type: "base",
    listRule: ANY_AUTH,
    viewRule: ANY_AUTH,
    createRule: `${STAFF} || ${ADMIN}`,
    updateRule: `${STAFF} || ${ADMIN}`,
    deleteRule: `${STAFF} || ${ADMIN}`,
    fields: [
      { name: "title", type: "text", required: true },
      { name: "class_name", type: "text", required: true },
      { name: "arm", type: "text" }, // blank = whole class, matching the original class/arm convention used elsewhere
      { name: "subject", type: "text", required: true },
      { name: "term", type: "text", required: true },
      { name: "duration_minutes", type: "number" },
      { name: "questions", type: "text" }, // stored as an already-JSON.stringify()'d string, matching what admin.js/staff.js write and what admin.js/staff.js/student.js JSON.parse() back — a native PocketBase "json" field would auto-parse it and break that existing code
      { name: "published", type: "bool" },
      { name: "created_by", type: "text" },
    ],
    indexes: ["CREATE INDEX idx_cbt_tests_class_subject_term ON cbt_tests (class_name, subject, term)"],
  },
  {
    name: "cbt_attempts",
    type: "base",
    listRule: `${ADMIN} || ${STAFF} || student_auth_id = @request.auth.id`,
    viewRule: `${ADMIN} || ${STAFF} || student_auth_id = @request.auth.id`,
    // A student may only ever create their OWN attempt record —
    // this is the PocketBase-native version of the self-granted
    // per-document permission Appwrite's client SDK allowed.
    createRule: `${STUDENT} && student_auth_id = @request.auth.id`,
    updateRule: null,
    deleteRule: ADMIN,
    fields: [
      { name: "test_id", type: "text", required: true },
      { name: "student_auth_id", type: "text", required: true },
      { name: "student_name", type: "text" },
      { name: "class_name", type: "text" },
      { name: "subject", type: "text" },
      { name: "term", type: "text" },
      { name: "answers", type: "text" }, // same reasoning as cbt_tests.questions above — written as a JSON.stringify()'d string
      { name: "score", type: "number" },
      { name: "total_questions", type: "number" },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_cbt_attempts_unique ON cbt_attempts (test_id, student_auth_id)",
      "CREATE INDEX idx_cbt_attempts_class ON cbt_attempts (class_name)",
    ],
  },
];

async function main() {
  await pb.collection("_superusers").authWithPassword(SUPERUSER_EMAIL, SUPERUSER_PASSWORD);
  console.log("Authenticated as superuser.");

  for (const def of collections) {
    try {
      await pb.collections.create(def);
      console.log(`Created collection: ${def.name}`);
    } catch (err) {
      const msg = err?.response?.message || err?.message || String(err);
      if (String(msg).toLowerCase().includes("already") || err?.status === 400) {
        console.log(`Skipped "${def.name}" (already exists, or check the error below if this looks wrong):`);
        if (!String(msg).toLowerCase().includes("already")) console.log("  ", JSON.stringify(err?.response || msg));
      } else {
        console.error(`Failed to create "${def.name}":`, msg);
      }
    }
  }

  // Since PocketBase 0.23, "created"/"updated" are optional autodate
  // fields, not something every collection gets automatically. This
  // project's frontend sorts by them everywhere (newest-first lists),
  // so make sure every collection actually has them — including ones
  // that already existed from an earlier run of this script, before
  // this fix was added.
  console.log("\nChecking created/updated timestamp fields...");
  for (const def of collections) {
    try {
      const existing = await pb.collections.getOne(def.name);
      const fieldNames = existing.fields.map((f) => f.name);
      const toAdd = [];
      if (!fieldNames.includes("created")) toAdd.push({ name: "created", type: "autodate", onCreate: true });
      if (!fieldNames.includes("updated")) toAdd.push({ name: "updated", type: "autodate", onCreate: true, onUpdate: true });
      if (def.name === "cbt_tests" && !fieldNames.includes("arm")) toAdd.push({ name: "arm", type: "text" });
      if ((def.name === "students" || def.name === "staff") && !fieldNames.includes("photo")) {
        toAdd.push({ name: "photo", type: "file", maxSelect: 1, maxSize: 5242880, mimeTypes: ["image/jpeg", "image/png", "image/webp"], thumbs: ["100x100"] });
      }

      // Fix questions/answers being set up as native "json" fields,
      // which auto-parse on read and break the app code's own
      // manual JSON.stringify()/JSON.parse() calls — see the
      // comments on these fields above. Rebuilt as a fresh minimal
      // text field (same id + name, so PocketBase treats it as the
      // same field rather than a new one) rather than just changing
      // .type on the existing field object, since the old json
      // field's other properties (e.g. maxSize) aren't valid on a
      // text field and were causing the update itself to be rejected.
      let fields = existing.fields;
      const textFieldsToFix = def.name === "cbt_tests" ? ["questions"] : def.name === "cbt_attempts" ? ["answers"] : [];
      for (const fname of textFieldsToFix) {
        const f = fields.find((x) => x.name === fname);
        if (f && f.type !== "text") {
          fields = fields.map((x) => (x.name === fname ? { id: x.id, name: x.name, type: "text", required: x.required || false } : x));
          console.log(`  Fixed "${fname}" field type on "${def.name}" (was "${f.type}", now "text")`);
        }
      }

      if (toAdd.length || fields !== existing.fields) {
        try {
          await pb.collections.update(existing.id, { fields: [...fields, ...toAdd] });
          if (toAdd.length) console.log(`  Added ${toAdd.map((f) => f.name).join(" + ")} to "${def.name}"`);
        } catch (updateErr) {
          console.error(`  Could not patch "${def.name}":`, JSON.stringify(updateErr?.response || updateErr?.message || updateErr, null, 2));
        }
      }
    } catch (err) {
      console.error(`  Could not check/patch "${def.name}":`, err?.response || err?.message || err);
    }
  }

  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    try {
      await pb.collection("admins").create({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        passwordConfirm: ADMIN_PASSWORD,
        emailVisibility: false,
        verified: true,
        full_name: ADMIN_NAME,
      });
      console.log(`Created admin login: ${ADMIN_EMAIL}`);
    } catch (err) {
      console.error("Could not create the admin login (it may already exist):", err?.response || err?.message || err);
    }
  } else {
    console.log("No ADMIN_EMAIL/ADMIN_PASSWORD set — skipped creating a school-admin login. Run again with those set, or create one from the Admin UI's \"admins\" collection.");
  }

  console.log("\nDone. Point js/pocketbase-config.js's `url` at " + PB_URL + " and you're set.");
}

main().catch((err) => {
  console.error("Setup failed:", err?.response || err?.message || err);
  process.exit(1);
});
