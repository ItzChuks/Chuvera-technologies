# Chuvera / Elias School — now on PocketBase

Same pages, same look, same login-with-ID-card flow. The backend
underneath is now a single self-hosted [PocketBase](https://pocketbase.io)
binary instead of Appwrite.

## What changed, and why

PocketBase's permission model is rule-based and can reference a
record's own fields directly (e.g. `student_auth_id = @request.auth.id`).
Appwrite's is a role/permission-list model that can't do that, which is
why the original project needed two server-side Functions
(`create-account`, `save-scores`) just to grant one specific student
read access to one specific document. A few things map over
differently as a result:

| Appwrite | PocketBase | Why |
|---|---|---|
| Auth users + 3 separate profile collections (`students`, `staff`, `admins`), linked by matching document ID | `students`, `staff`, `admins` are themselves **auth collections** | The login record and the profile record are now the same row — no linking step, no second lookup |
| Teams `admins` / `staff` | `@request.auth.collectionName` in API rules | Since login and role are now the same collection, "which team is this user in" is just "which collection did they authenticate against" |
| `save-scores` Function (existed purely to grant one student read access to one score document) | Not needed. `scores`' API rule is `student_auth_id = @request.auth.id` — staff write directly | Rules can check a record's own field against the caller; no per-document grant required |
| `create-account` Function | `pb_hooks/main.pb.js` custom route, running inside PocketBase itself | Still needs to run with elevated privilege (generating a unique ID, creating a login for someone else) — same reason, just no separate service to deploy |
| Storage bucket + `file_id` field | A `file` field directly on the `materials` collection | PocketBase attaches files to records natively; deleting the record removes the file too |
| `databases.createDocument()` etc. | Same call sites, unchanged | `js/pocketbase-config.js` re-implements that API shape on top of PocketBase, so ~90% of admin.js/staff.js/student.js needed zero edits |

**Security note (same trade-off the Appwrite version had):** the
school ID still doubles as the password. Fine for a pilot; add a
real admin-issued password before a wider rollout.

## 1. Get PocketBase running

1. Download the binary for your OS from [pocketbase.io/docs](https://pocketbase.io/docs/) (or use their Docker image).
2. Copy this repo's `pb_hooks/` folder into the same directory as the
   PocketBase executable (next to where `pb_data/` will appear).
3. Run it:
   ```bash
   ./pocketbase serve
   ```
4. Open `http://127.0.0.1:8090/_/` and create your **superuser**
   account (this is PocketBase's own admin login — separate from
   the school-admin login the site itself uses).

For production, run it behind a reverse proxy (Caddy/Nginx) with a
real domain and TLS, and keep `pb_data/` backed up — it's the whole
database plus every uploaded file.

## 2. Create the collections, rules, and your admin login

```bash
cd scripts
npm install
POCKETBASE_URL=http://127.0.0.1:8090 \
SUPERUSER_EMAIL=you@example.com \
SUPERUSER_PASSWORD=your-superuser-password \
ADMIN_EMAIL=admin@yourschool.com \
ADMIN_PASSWORD=choose-a-strong-password \
ADMIN_NAME="Your Name" \
node setup-pocketbase.js
```

This creates all 9 collections (`classes`, `students`, `staff`,
`admins`, `scores`, `messages`, `materials`, `cbt_tests`,
`cbt_attempts`) with their fields, indexes, and API rules, then
creates your admin login in the `admins` collection. Safe to re-run —
it skips collections that already exist.

Prefer doing it by hand instead? Open `http://127.0.0.1:8090/_/`,
create each collection with the fields listed in
`scripts/setup-pocketbase.js` (it's readable as documentation even
if you don't run it), and paste in the same rule strings.

## 3. Point the site at your PocketBase server

Edit `js/pocketbase-config.js`:

```js
const POCKETBASE_CONFIG = {
  url: "http://127.0.0.1:8090",   // your PocketBase server's URL
  ...
};
```

That's the only file you should need to touch, assuming you kept
the default collection names.

## 4. Run it

No build tools needed — same as before:

```
npx serve .
```

or open `index.html` directly (a local static server is more
reliable than `file://` for fetch-heavy pages like this).

## About `pb_hooks/main.pb.js`

This runs inside PocketBase's own process (its JavaScript VM
plugin) — nothing extra to deploy or keep alive, unlike Appwrite's
separate Functions runtime. It handles account creation/deletion,
which needs superuser-level access the browser session shouldn't
hold (generating a unique school ID, creating a login for someone
else). PocketBase's JSVM API has shifted a little across versions
before — if a call in that file throws `... is not a function`
after an upgrade, [pocketbase.io/docs/js-routing](https://pocketbase.io/docs/js-routing/)
is the first place to check for a renamed method.

## Files in this conversion

```
index.html, auth.html, admin-auth.html, student.html, staff.html, admin.html   — unchanged except script tags
js/pocketbase-config.js  — replaces js/appwrite-config.js; also a compatibility
                            shim (databases/account/Query/ID/Permission/Role) so
                            admin.js/staff.js/student.js needed minimal edits
js/utils.js              — session check, createAccount()/deleteAccount() now call
                            pb_hooks custom routes, materialFileUrl() rewritten
js/admin-auth.js         — admin sign-in, now authWithPassword() against "admins"
js/auth.js               — student/staff sign-in, now authWithPassword() per role
js/student.js            — unchanged except the compatibility shim underneath
js/staff.js              — save-scores now writes directly (no function call needed)
js/admin.js              — Library upload/delete now uses a PocketBase file field
js/pdf-utils.js, js/offline.js  — unchanged (no backend calls)
pb_hooks/main.pb.js      — the create-account / delete-account custom routes
scripts/setup-pocketbase.js  — one-time schema + rules + admin-login setup
```

## What's intentionally out of scope (same as before)

- PDF report card export
- Bulk CSV import for students
- SMS/email notifications for messages
- Attendance and fee tracking
