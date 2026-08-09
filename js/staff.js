/* ============================================================
   staff.html — staff dashboard logic (Appwrite)
   ============================================================ */

let PROFILE = null;
let CURRENT_SCORES = {}; // student_auth_id -> score document
let ENTRY_STUDENTS = []; // students currently shown in the entry sheet, for PDF export + report links
let CLASSES_CACHE = []; // class documents matching this staff member's own assignments only

/* ---------- Tabs ---------- */
function setActiveTab(tab) {
  document.querySelectorAll(".tab-section").forEach((el) => el.classList.add("hidden"));
  document.getElementById(`tab-${tab}`).classList.remove("hidden");

  document.querySelectorAll(".nav-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));

  const titles = {
    overview: ["Overview", "Your ID card, at a glance"],
    scores: ["Enter Scores", "Record scores for your assigned classes"],
    students: ["Add Student", "Add students to a class you're assigned to"],
    cbt: ["CBT", "Build tests and review results for your classes"],
    messages: ["Message Class", "Reach a class you're assigned to"],
  };
  document.getElementById("page-title").textContent = titles[tab][0];
  document.getElementById("page-subtitle").textContent = titles[tab][1];

  if (tab === "scores") loadEntrySheet();
  if (tab === "students") loadStudents(document.getElementById("student-search")?.value || "");
  if (tab === "cbt") loadCbtTests();

  requestAnimationFrame(refreshNavIndicators);
}

document.querySelectorAll("#sidebar-nav .nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => navigateToTab(btn.dataset.tab));
});

document.getElementById("logout-btn").addEventListener("click", () => logout("index.html"));
document.getElementById("logout-btn-mobile").addEventListener("click", () => logout("index.html"));

function renderProfile(profile) {
  document.getElementById("p-name").textContent = profile.full_name;
  document.getElementById("p-position").textContent = profile.position || "Staff";
  document.getElementById("p-id").textContent = profile.school_id;
  document.getElementById("p-initials").textContent = initials(profile.full_name);

  document.getElementById("p-classes").innerHTML = (profile.classes || []).map((c) => `<span class="pill pill-green">${c}</span>`).join("") || `<p class="text-sm text-ink/40">None assigned yet.</p>`;
  document.getElementById("p-subjects").innerHTML = (profile.subjects || []).map((s) => `<span class="pill pill-green">${s}</span>`).join("") || `<p class="text-sm text-ink/40">None assigned yet.</p>`;

  const classOpts = (profile.classes || []).map((c) => `<option>${c}</option>`).join("");
  const subjectOpts = (profile.subjects || []).map((s) => `<option>${s}</option>`).join("");
  document.getElementById("e-class").innerHTML = classOpts || `<option value="">No class assigned</option>`;
  document.getElementById("e-subject").innerHTML = subjectOpts || `<option value="">No subject assigned</option>`;

  // Messaging targets a whole class, not a specific arm (the messages
  // collection has no arm field) — so dedupe "JSS1 (A)" / "JSS1 (B)" down
  // to one "JSS1" option. A message to JSS1 reaches all its arms, even if
  // you're only assigned to teach one of them.
  const uniqueClassNames = [...new Set((profile.classes || []).map((c) => parseClassAssignment(c).className))];
  document.getElementById("m-class").innerHTML = uniqueClassNames.map((c) => `<option>${c}</option>`).join("") || `<option value="">No class assigned</option>`;

  // CBT tests are scoped to a whole class by default (not a specific
  // arm) — same reasoning as messaging above — but staff can pick a
  // specific arm on the form itself if they only want one arm to see
  // a given test; see updateCbtArmOptions().
  document.getElementById("cbt-class").innerHTML = uniqueClassNames.map((c) => `<option>${c}</option>`).join("") || `<option value="">No class assigned</option>`;
  document.getElementById("cbt-subject").innerHTML = subjectOpts || `<option value="">No subject assigned</option>`;
  updateCbtArmOptions();
}

/** Refills the Arm dropdown for whichever class is currently picked
 * in the CBT form. "All arms" is always first and targets the whole
 * class, same as before this option existed. If this staff member
 * is assigned to the whole class, every arm the class has is
 * offered; if they're only assigned specific arms, only those show. */
function updateCbtArmOptions() {
  const className = document.getElementById("cbt-class").value;
  const assignments = (PROFILE.classes || []).map((c) => parseClassAssignment(c)).filter((p) => p.className === className);
  const assignedWholeClass = assignments.some((p) => !p.arm);
  const cls = CLASSES_CACHE.find((c) => c.name === className);
  const arms = assignedWholeClass ? cls?.arms || [] : assignments.map((p) => p.arm).filter(Boolean);
  const armSel = document.getElementById("cbt-arm");
  armSel.innerHTML = `<option value="">All arms</option>` + arms.map((a) => `<option>${escapeHtml(a)}</option>`).join("");
}
document.getElementById("cbt-class")?.addEventListener("change", updateCbtArmOptions);

async function loadEntrySheet() {
  const rawClass = document.getElementById("e-class").value;
  const subject = document.getElementById("e-subject").value;
  const term = document.getElementById("e-term").value;
  const table = document.getElementById("entry-table");

  if (!rawClass || !subject) {
    table.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-ink/40 text-sm">Pick a class and subject to begin.</td></tr>`;
    return;
  }

  const { className, arm } = parseClassAssignment(rawClass);

  table.innerHTML = `<tr><td colspan="7" class="py-4"><div class="skeleton h-6 rounded-lg"></div></td></tr>`;

  try {
    // Only students in this class (and this specific arm, if the staff
    // member is assigned to one) who actually offer this subject —
    // Query.contains maps to Appwrite's array "contains" filter.
    const studentFilters = [
      Query.equal("class_name", className),
      Query.contains("subjects", subject),
      Query.orderAsc("full_name"),
      Query.limit(200),
    ];
    if (arm) studentFilters.splice(1, 0, Query.equal("arm", arm));

    const { documents: students } = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.students, studentFilters);

    const { documents: scores } = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.scores, [
      Query.equal("class_name", className),
      Query.equal("subject", subject),
      Query.equal("term", term),
      Query.limit(200),
    ]);

    CURRENT_SCORES = {};
    scores.forEach((s) => (CURRENT_SCORES[s.student_auth_id] = s));

    ENTRY_STUDENTS = students;

    if (!students || students.length === 0) {
      table.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-ink/40 text-sm">No students in this class offer this subject yet.</td></tr>`;
      return;
    }

    table.innerHTML = students.map((st) => {
      // Profile documents use documentId == the student's Appwrite user id.
      const existing = CURRENT_SCORES[st.$id];
      return `
        <tr class="border-b border-ink/5" data-auth-id="${st.$id}" data-student-id="${st.school_id}" data-student-name="${st.full_name}">
          <td class="py-2 pr-3">${st.full_name}</td>
          <td class="py-2 pr-3"><input type="number" min="0" max="100" class="ca1-input w-16 px-2 py-1 rounded-lg border border-ink/10 outline-none focus:border-forest-600" value="${existing?.ca1 ?? ""}" /></td>
          <td class="py-2 pr-3"><input type="number" min="0" max="100" class="ca2-input w-16 px-2 py-1 rounded-lg border border-ink/10 outline-none focus:border-forest-600" value="${existing?.ca2 ?? ""}" /></td>
          <td class="py-2 pr-3"><input type="number" min="0" max="100" class="exam-input w-16 px-2 py-1 rounded-lg border border-ink/10 outline-none focus:border-forest-600" value="${existing?.exam ?? ""}" /></td>
          <td class="py-2 pr-3 total-cell font-semibold">${existing?.total ?? "—"}</td>
          <td class="py-2 pr-3 grade-cell">${existing?.grade ? `<span class="pill pill-green">${existing.grade}</span>` : "—"}</td>
          <td class="py-2 pr-3"><button type="button" class="text-forest-700 hover:underline text-xs font-medium" onclick="downloadEntryStudentReport('${st.$id}')">Report</button></td>
        </tr>
      `;
    }).join("");

    table.querySelectorAll("input").forEach((input) => {
      input.addEventListener("input", (e) => {
        const row = e.target.closest("tr");
        const ca1 = parseFloat(row.querySelector(".ca1-input").value) || 0;
        const ca2 = parseFloat(row.querySelector(".ca2-input").value) || 0;
        const exam = parseFloat(row.querySelector(".exam-input").value) || 0;
        const total = ca1 + ca2 + exam;
        row.querySelector(".total-cell").textContent = total;
        row.querySelector(".grade-cell").innerHTML = `<span class="pill pill-green">${computeGrade(total)}</span>`;
      });
    });
  } catch (err) {
    console.error(err);
    ENTRY_STUDENTS = [];
    table.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-red-600 text-sm">Couldn't load the class list.</td></tr>`;
  }
}

["e-class", "e-subject", "e-term"].forEach((id) => document.getElementById(id).addEventListener("change", loadEntrySheet));

/* ---------- PDF downloads ---------- */

/** Exports the entry sheet exactly as currently on screen (whatever
 * scores have been typed but not yet saved are NOT included — this
 * reads from CURRENT_SCORES, the last saved data, same as the page
 * itself shows on load). */
document.getElementById("entry-pdf-btn")?.addEventListener("click", () => {
  const rawClass = document.getElementById("e-class").value;
  const subject = document.getElementById("e-subject").value;
  const term = document.getElementById("e-term").value;
  if (!rawClass || !subject) {
    toast("Pick a class and subject first.", "error");
    return;
  }
  const rows = ENTRY_STUDENTS.map((st) => {
    const sc = CURRENT_SCORES[st.$id];
    return {
      student_name: st.full_name,
      ca1: sc?.ca1, ca2: sc?.ca2, exam: sc?.exam, total: sc?.total, grade: sc?.grade, position: sc?.position,
    };
  });
  downloadScoresPdf(rows, { className: rawClass, subject, term });
});

/** Every score on record for one student (any subject/term the
 * staff member's session can see — the "scores" collection grants
 * read("team:staff") collection-wide, same as it does for admin),
 * so a teacher can hand a student their full report without needing
 * to be the one who taught every subject on it. */
async function downloadEntryStudentReport(studentId) {
  const student = ENTRY_STUDENTS.find((s) => s.$id === studentId);
  if (!student) return;
  try {
    const { documents: scores } = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.scores, [
      Query.equal("student_auth_id", studentId),
      Query.limit(200),
    ]);
    downloadFullReportCardPdf(student, scores);
  } catch (err) {
    console.error(err);
    toast("Couldn't build that student's report. See console for details.", "error");
  }
}

document.getElementById("save-scores-btn").addEventListener("click", async () => {
  const btn = document.getElementById("save-scores-btn");
  const rawClass = document.getElementById("e-class").value;
  const subject = document.getElementById("e-subject").value;
  const term = document.getElementById("e-term").value;
  if (!rawClass || !subject) return;

  const { className } = parseClassAssignment(rawClass);

  btn.disabled = true;
  btn.textContent = "Saving...";

  try {
    const rows = [...document.querySelectorAll("#entry-table tr[data-auth-id]")];
    const results = rows.map((row) => {
      const authId = row.dataset.authId;
      const studentId = row.dataset.studentId;
      const studentName = row.dataset.studentName;
      const ca1 = parseFloat(row.querySelector(".ca1-input").value) || 0;
      const ca2 = parseFloat(row.querySelector(".ca2-input").value) || 0;
      const exam = parseFloat(row.querySelector(".exam-input").value) || 0;
      const total = ca1 + ca2 + exam;
      return { authId, studentId, studentName, ca1, ca2, exam, total, grade: computeGrade(total) };
    });

    // Rank -> position (1 = highest total)
    const sorted = [...results].sort((a, b) => b.total - a.total);
    const positionMap = {};
    sorted.forEach((r, i) => (positionMap[r.authId] = i + 1));

    // Unlike Appwrite, this can be written directly from the browser
    // with no server-side function: the "scores" collection's API
    // rule (student_auth_id = @request.auth.id, or staff/admin) lets
    // a student read their own row without any per-document
    // permission grant, and staff already have collection-level
    // create/update rights. So this is just an update-if-exists /
    // create-otherwise loop, same shape save-scores used to do
    // server-side — just running here instead.
    const scoreRows = results.map((r) => ({ ...r, position: positionMap[r.authId] }));

    const { documents: existingScores } = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.scores, [
      Query.equal("class_name", className),
      Query.equal("subject", subject),
      Query.equal("term", term),
      Query.limit(500),
    ]);
    const existingByAuthId = {};
    existingScores.forEach((doc) => (existingByAuthId[doc.student_auth_id] = doc));

    for (const r of scoreRows) {
      const data = {
        student_auth_id: r.authId,
        student_id: r.studentId || "",
        student_name: r.studentName || "",
        class_name: className,
        subject,
        term,
        ca1: r.ca1,
        ca2: r.ca2,
        exam: r.exam,
        total: r.total,
        grade: r.grade,
        position: r.position,
      };
      const existing = existingByAuthId[r.authId];
      if (existing) {
        await databases.updateDocument(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.scores, existing.$id, data);
      } else {
        await databases.createDocument(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.scores, ID.unique(), data);
      }
    }

    toast("Scores saved and positions updated.");
    await loadEntrySheet();
  } catch (err) {
    console.error(err);
    toast("Couldn't save scores. See console for details.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save scores";
  }
});

/* ---------- Add Student ----------
   Staff can add students, but only to a class they're themselves
   assigned to — enforced here for a clean UI (dropdowns only ever
   show their own classes/arms) AND again server-side in the
   create-account Function, which is the actual security boundary. */

/** Fetches the full classes collection (readable by any signed-in
 * user) and keeps only the ones this staff member is assigned to. */
async function loadAssignedClasses() {
  try {
    const { documents } = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.classes, [Query.limit(200)]);
    const assignedNames = new Set((PROFILE.classes || []).map((c) => parseClassAssignment(c).className));
    CLASSES_CACHE = documents.filter((c) => assignedNames.has(c.name));
  } catch (err) {
    console.error(err);
    CLASSES_CACHE = [];
  }
  populateStudentClassOptions();
}

/** Which arms of this class the staff member is actually assigned to
 * (a class with no arms at all is assigned as a whole). */
function assignedArmsForClass(cls) {
  if (!cls.arms || cls.arms.length === 0) return [];
  const assigned = PROFILE.classes || [];
  return cls.arms.filter((a) => assigned.includes(formatClassAssignment(cls.name, a)));
}

function populateStudentClassOptions() {
  const sel = document.getElementById("s-class");
  sel.innerHTML = CLASSES_CACHE.length
    ? CLASSES_CACHE.map((c) => `<option value="${c.$id}">${escapeHtml(c.name)}</option>`).join("")
    : `<option value="">No classes assigned</option>`;
  updateStudentArmDeptOptions();
}

function updateStudentArmDeptOptions() {
  const classId = document.getElementById("s-class").value;
  const cls = CLASSES_CACHE.find((c) => c.$id === classId);
  const armSel = document.getElementById("s-arm");
  const deptSel = document.getElementById("s-department");
  const arms = cls ? assignedArmsForClass(cls) : [];
  armSel.innerHTML = `<option value="">—</option>` + arms.map((a) => `<option>${escapeHtml(a)}</option>`).join("");
  deptSel.innerHTML = `<option value="">—</option>` + (cls?.departments || []).map((d) => `<option>${escapeHtml(d)}</option>`).join("");
}
document.getElementById("s-class")?.addEventListener("change", updateStudentArmDeptOptions);

async function loadStudents(searchTerm = "") {
  let rows;
  try {
    const res = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.students, [Query.orderDesc("$createdAt"), Query.limit(100)]);
    rows = res.documents;
  } catch (err) {
    console.error(err);
    return;
  }

  const assigned = new Set(PROFILE.classes || []);
  rows = rows.filter((r) => assigned.has(formatClassAssignment(r.class_name, r.arm)));

  if (searchTerm) {
    const t = searchTerm.toLowerCase();
    rows = rows.filter((r) => r.full_name.toLowerCase().includes(t) || r.school_id.toLowerCase().includes(t));
  }

  document.getElementById("students-table").innerHTML = rows.map((r) => `
    <tr class="border-b border-ink/5">
      <td class="py-2.5 pr-3">${escapeHtml(r.full_name)}</td>
      <td class="py-2.5 pr-3 font-idmono text-xs">${escapeHtml(r.school_id)}</td>
      <td class="py-2.5 pr-3">${escapeHtml(r.class_name || "—")}</td>
      <td class="py-2.5 pr-3">${escapeHtml(r.arm || "—")}</td>
    </tr>
  `).join("") || `<tr><td colspan="4" class="py-4 text-ink/40 text-sm">No students in your classes yet.</td></tr>`;
}

document.getElementById("student-search")?.addEventListener("input", (e) => loadStudents(e.target.value));

document.getElementById("student-form").addEventListener("submit", async (e) => {
  e.preventDefault();

  const classId = document.getElementById("s-class").value;
  const cls = CLASSES_CACHE.find((c) => c.$id === classId);
  if (!cls) {
    toast("You don't have a class to add a student to. Ask an admin to assign you one first.", "error");
    return;
  }

  const btn = e.target.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Creating...";

  try {
    const fullName = document.getElementById("s-name").value.trim();
    const arm = document.getElementById("s-arm").value;
    const department = document.getElementById("s-department").value;
    const guardianName = document.getElementById("s-guardian-name").value.trim();
    const guardianPhone = document.getElementById("s-guardian-phone").value.trim();
    const guardianEmail = document.getElementById("s-guardian-email").value.trim();

    const { schoolId } = await createAccount("student", {
      fullName,
      classId,
      className: cls.name,
      arm,
      department,
      subjects: cls.subjects || [],
      guardianName,
      guardianPhone,
      guardianEmail,
    });

    document.getElementById("modal-name").textContent = fullName;
    document.getElementById("modal-meta").textContent = `${cls.name}${arm ? " · Arm " + arm : ""}`;
    document.getElementById("modal-id").textContent = schoolId;
    document.getElementById("modal-initials").textContent = initials(fullName);
    document.getElementById("id-modal").classList.remove("hidden");
    document.getElementById("id-modal").classList.add("flex");

    e.target.reset();
    updateStudentArmDeptOptions();
    await loadStudents();
    toast("Student added.");
  } catch (err) {
    console.error(err);
    const message = isRateLimitError(err)
      ? "Too many account creations at once. Wait a moment and try again."
      : err.message === "Another account creation is already in progress. Wait for it to finish."
        ? err.message
        : err.message || "Couldn't add student. See console for details.";
    toast(message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Add student & generate ID";
  }
});

document.getElementById("modal-close")?.addEventListener("click", () => {
  document.getElementById("id-modal").classList.add("hidden");
  document.getElementById("id-modal").classList.remove("flex");
});

/* ---------- CBT tests ---------- */
let CBT_TESTS_CACHE = [];
let cbtQuestionCount = 0;

function addCbtQuestionBlock() {
  const qIndex = cbtQuestionCount++;
  const wrap = document.createElement("div");
  wrap.className = "border border-ink/10 rounded-xl p-3.5 cbt-question-block";
  wrap.dataset.qIndex = qIndex;
  wrap.innerHTML = `
    <div class="flex items-start justify-between gap-2 mb-2">
      <textarea rows="2" placeholder="Question text" class="cbt-q-text flex-1 px-3 py-2 rounded-lg border border-ink/10 outline-none focus:border-forest-600 text-sm"></textarea>
      <button type="button" class="cbt-remove-q text-red-600 text-xs font-medium hover:underline shrink-0 mt-2">Remove</button>
    </div>
    <div class="space-y-1.5">
      ${[0, 1, 2, 3].map((i) => `
        <label class="flex items-center gap-2 text-sm">
          <input type="radio" name="cbt-correct-${qIndex}" value="${i}" class="cbt-correct-radio" ${i === 0 ? "checked" : ""} />
          <input type="text" placeholder="Option ${i + 1}" class="cbt-option flex-1 px-3 py-1.5 rounded-lg border border-ink/10 outline-none focus:border-forest-600 text-sm" />
        </label>
      `).join("")}
    </div>
  `;
  wrap.querySelector(".cbt-remove-q").addEventListener("click", () => wrap.remove());
  document.getElementById("cbt-questions").appendChild(wrap);
}

document.getElementById("cbt-add-question").addEventListener("click", addCbtQuestionBlock);
addCbtQuestionBlock(); // start every new form with one question ready to fill in

document.getElementById("cbt-form").addEventListener("submit", async (e) => {
  e.preventDefault();

  const blocks = [...document.querySelectorAll(".cbt-question-block")];
  if (blocks.length === 0) {
    toast("Add at least one question.", "error");
    return;
  }

  const questions = [];
  for (const block of blocks) {
    const text = block.querySelector(".cbt-q-text").value.trim();
    const options = [...block.querySelectorAll(".cbt-option")].map((inp) => inp.value.trim());
    const correct = Number(block.querySelector(".cbt-correct-radio:checked")?.value ?? -1);
    if (!text || options.some((o) => !o) || correct < 0) {
      toast("Every question needs text, 4 options, and a marked correct answer.", "error");
      return;
    }
    questions.push({ q: text, options, correct });
  }

  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Saving...";

  try {
    await databases.createDocument(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.cbtTests, ID.unique(), {
      title: document.getElementById("cbt-title").value.trim(),
      class_name: document.getElementById("cbt-class").value,
      arm: document.getElementById("cbt-arm").value || "",
      subject: document.getElementById("cbt-subject").value,
      term: document.getElementById("cbt-term").value,
      duration_minutes: Number(document.getElementById("cbt-duration").value) || 20,
      questions: JSON.stringify(questions),
      published: false,
      created_by: PROFILE.$id,
    });

    toast("Test saved as a draft.");
    e.target.reset();
    document.getElementById("cbt-questions").innerHTML = "";
    cbtQuestionCount = 0;
    addCbtQuestionBlock();
    loadCbtTests();
  } catch (err) {
    console.error(err);
    toast(err.message || "Couldn't save the test.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save test";
  }
});

async function loadCbtTests() {
  const list = document.getElementById("cbt-list");
  try {
    const { documents } = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.cbtTests, [
      Query.equal("created_by", PROFILE.$id),
      Query.orderDesc("$createdAt"),
      Query.limit(100),
    ]);
    CBT_TESTS_CACHE = documents;
  } catch (err) {
    console.error(err);
    list.innerHTML = `<p class="text-sm text-red-600">Couldn't load your tests.</p>`;
    return;
  }

  if (CBT_TESTS_CACHE.length === 0) {
    list.innerHTML = `<p class="text-sm text-ink/40">No tests yet — build one on the left.</p>`;
    return;
  }

  list.innerHTML = CBT_TESTS_CACHE.map((t) => {
    const qCount = (() => { try { return JSON.parse(t.questions).length; } catch { return 0; } })();
    return `
      <div class="border border-ink/10 rounded-xl p-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="font-display font-semibold">${escapeHtml(t.title)}</p>
            <p class="text-xs text-ink/50 mt-1">${escapeHtml(t.class_name)}${t.arm ? " (" + escapeHtml(t.arm) + ")" : ""} · ${escapeHtml(t.subject)} · ${escapeHtml(t.term)} · ${qCount} question${qCount === 1 ? "" : "s"} · ${t.duration_minutes} min</p>
          </div>
          <span class="pill ${t.published ? "pill-green" : "pill-gray"} shrink-0">${t.published ? "Published" : "Draft"}</span>
        </div>
        <div class="flex gap-3 mt-3 text-xs font-medium">
          <button type="button" class="text-forest-700 hover:underline" onclick="toggleCbtPublish('${t.$id}')">${t.published ? "Unpublish" : "Publish"}</button>
          <button type="button" class="text-forest-700 hover:underline" onclick="viewCbtResults('${t.$id}')">View results</button>
          <button type="button" class="text-red-600 hover:underline" onclick="deleteCbtTest('${t.$id}')">Delete</button>
        </div>
      </div>
    `;
  }).join("");
}

async function toggleCbtPublish(testId) {
  const test = CBT_TESTS_CACHE.find((t) => t.$id === testId);
  if (!test) return;
  try {
    await databases.updateDocument(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.cbtTests, testId, { published: !test.published });
    toast(test.published ? "Test unpublished." : "Test published — students can now take it.");
    loadCbtTests();
  } catch (err) {
    console.error(err);
    toast(err.message || "Couldn't update the test.", "error");
  }
}

async function deleteCbtTest(testId) {
  if (!confirm("Delete this test? Existing student attempts stay on record, but the test itself will be gone.")) return;
  try {
    await databases.deleteDocument(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.cbtTests, testId);
    toast("Test deleted.");
    loadCbtTests();
  } catch (err) {
    console.error(err);
    toast(err.message || "Couldn't delete the test.", "error");
  }
}

async function viewCbtResults(testId) {
  const test = CBT_TESTS_CACHE.find((t) => t.$id === testId);
  if (!test) return;

  const panel = document.getElementById("cbt-results-panel");
  panel.classList.remove("hidden");
  document.getElementById("cbt-results-title").textContent = `Results — ${test.title}`;
  document.getElementById("cbt-results-table").innerHTML = `<tr><td colspan="3" class="py-4"><div class="skeleton h-6 rounded-lg"></div></td></tr>`;

  try {
    const { documents: attempts } = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.cbtAttempts, [
      Query.equal("test_id", testId),
      Query.orderDesc("$createdAt"),
      Query.limit(200),
    ]);

    if (attempts.length === 0) {
      document.getElementById("cbt-results-stats").innerHTML = "";
      document.getElementById("cbt-results-table").innerHTML = `<tr><td colspan="3" class="py-6 text-center text-ink/40 text-sm">No submissions yet.</td></tr>`;
      return;
    }

    const avg = (attempts.reduce((sum, a) => sum + (a.score / (a.total_questions || 1)) * 100, 0) / attempts.length).toFixed(0);
    const highest = Math.max(...attempts.map((a) => (a.score / (a.total_questions || 1)) * 100)).toFixed(0);
    document.getElementById("cbt-results-stats").innerHTML = `
      <div><p class="text-ink/50 mb-1">Submissions</p><p class="font-display font-bold text-lg">${attempts.length}</p></div>
      <div><p class="text-ink/50 mb-1">Class average</p><p class="font-display font-bold text-lg">${avg}%</p></div>
      <div><p class="text-ink/50 mb-1">Highest</p><p class="font-display font-bold text-lg">${highest}%</p></div>
    `;

    document.getElementById("cbt-results-table").innerHTML = attempts.map((a) => `
      <tr class="border-b border-ink/5">
        <td class="py-2 pr-3">${escapeHtml(a.student_name || a.student_auth_id)}</td>
        <td class="py-2 pr-3 font-semibold">${a.score}/${a.total_questions}</td>
        <td class="py-2 pr-3 text-ink/50">${new Date(a.$createdAt).toLocaleString()}</td>
      </tr>
    `).join("");
  } catch (err) {
    console.error(err);
    document.getElementById("cbt-results-table").innerHTML = `<tr><td colspan="3" class="py-6 text-center text-red-600 text-sm">Couldn't load results.</td></tr>`;
  }
}

document.getElementById("cbt-results-close").addEventListener("click", () => {
  document.getElementById("cbt-results-panel").classList.add("hidden");
});

document.getElementById("message-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const target = document.getElementById("m-class").value;
  const content = document.getElementById("m-content").value.trim();
  if (!target || !content) return;

  try {
    await databases.createDocument(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.messages, ID.unique(), {
      scope: "class",
      target,
      content,
      from_name: PROFILE.full_name,
    });
    toast("Message sent to " + target);
    e.target.reset();
  } catch (err) {
    console.error(err);
    toast("Couldn't send message.", "error");
  }
});

(async function init() {
  const session = await requireSession("staff");
  if (!session) return;
  PROFILE = session.profile;
  renderProfile(PROFILE);
  await loadAssignedClasses();
  initTabRouter("overview");

  // Live updates: if an admin changes this staff member's assigned
  // classes/subjects (or position/name) while this dashboard is
  // open, reflect it immediately instead of waiting for next login.
  subscribeToDocument(POCKETBASE_CONFIG.collections.staff, PROFILE.$id, (event) => {
    if (event.events.some((e) => e.endsWith(".delete"))) {
      toast("Your account was removed by the school.", "error");
      setTimeout(() => logout("index.html"), 1500);
      return;
    }
    PROFILE = { ...PROFILE, ...event.payload };
    renderProfile(PROFILE);
    loadAssignedClasses(); // rebuild the Add Student class/arm options against the new assignment
    const activeScoresTab = !document.getElementById("tab-scores").classList.contains("hidden");
    if (activeScoresTab) loadEntrySheet(); // options depend on the class/subject lists just rebuilt above
    toast("Your assigned classes/subjects were just updated.", "info");
  });
})();
