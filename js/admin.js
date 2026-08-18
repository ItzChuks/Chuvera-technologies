/* ============================================================
   admin.html — admin dashboard logic (Appwrite)
   ============================================================ */

let ADMIN_PROFILE = null;
let CLASSES_CACHE = [];
let STUDENTS_CACHE = [];
let STAFF_CACHE = [];
let SCORES_CACHE = [];
let MATERIALS_CACHE = [];
// Account-creation helpers (createAccount, deleteAccount, the
// cooldown/rate-limit tracking) now live in utils.js, shared with
// staff.js so staff can add students too — see functions/create-account.

function splitCsv(value) {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

/* ---------- Tabs ---------- */
function setActiveTab(tab) {
  document.querySelectorAll(".tab-section").forEach((el) => el.classList.add("hidden"));
  document.getElementById(`tab-${tab}`).classList.remove("hidden");

  document.querySelectorAll(".nav-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));

  const titles = {
    overview: ["Overview", "A quick look at the whole school"],
    classes: ["Classes & Subjects", "Set up your school's structure"],
    students: ["Students", "Add students and issue login IDs"],
    staff: ["Staff", "Add staff and issue login IDs"],
    scores: ["Scores", "Review scores entered by staff"],
    analytics: ["Analytics", "Class performance and student trends at a glance"],
    library: ["Library", "Upload materials for the student Digital Library"],
    cbt: ["CBT", "Build tests, publish them, and review results across the school"],
    messages: ["Messages", "Reach students by class or individually"],
  };
  document.getElementById("page-title").textContent = titles[tab][0];
  document.getElementById("page-subtitle").textContent = titles[tab][1];

  if (tab === "scores") loadScores();
  if (tab === "analytics") { loadAnalytics(); populateAnalyticsStudents(); }
  if (tab === "library") loadMaterials();
  if (tab === "cbt") loadCbtTests();

  requestAnimationFrame(refreshNavIndicators);
}

document.querySelectorAll("#sidebar-nav .nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => navigateToTab(btn.dataset.tab));
});

document.getElementById("logout-btn").addEventListener("click", () => logout("admin-auth.html"));
document.getElementById("logout-btn-mobile").addEventListener("click", () => logout("admin-auth.html"));

/* ---------- PDF downloads ---------- */
document.getElementById("classes-pdf-btn")?.addEventListener("click", () => downloadClassesPdf(CLASSES_CACHE));

document.getElementById("students-pdf-btn")?.addEventListener("click", () => {
  const term = document.getElementById("student-search").value;
  let rows = STUDENTS_CACHE;
  if (term) {
    const t = term.toLowerCase();
    rows = rows.filter((r) => r.full_name.toLowerCase().includes(t) || r.school_id.toLowerCase().includes(t));
  }
  downloadStudentsListPdf(rows, { subtitle: term ? `Filtered by "${term}" · ${rows.length} student${rows.length === 1 ? "" : "s"}` : "" });
});

document.getElementById("staff-pdf-btn")?.addEventListener("click", () => {
  const term = document.getElementById("staff-search")?.value || "";
  let rows = STAFF_CACHE;
  if (term) {
    const t = term.toLowerCase();
    rows = rows.filter((r) => r.full_name.toLowerCase().includes(t) || r.school_id.toLowerCase().includes(t) || (r.position || "").toLowerCase().includes(t));
  }
  downloadStaffListPdf(rows);
});

document.getElementById("scores-pdf-btn")?.addEventListener("click", () => {
  const classId = document.getElementById("sc-class").value;
  const className = CLASSES_CACHE.find((c) => c.$id === classId)?.name || "";
  const subject = document.getElementById("sc-subject").value;
  const term = document.getElementById("sc-term").value;
  const searchTerm = document.getElementById("sc-search")?.value || "";

  let rows = SCORES_CACHE;
  if (searchTerm) {
    const t = searchTerm.toLowerCase();
    rows = rows.filter((r) => (r.student_name || "").toLowerCase().includes(t) || (r.student_id || "").toLowerCase().includes(t));
  }
  downloadScoresPdf(rows, { className, subject, term });
});

/** Every score on record for one student, across every subject and
 * term — used for the "Report" link on each row of the Students
 * table so admin can hand a student/guardian their full report
 * without needing to first pick a term in the Scores tab. */
async function downloadStudentReport(studentId) {
  const student = STUDENTS_CACHE.find((s) => s.$id === studentId);
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

// createAccount() / deleteAccount() now live in utils.js (shared with staff.js).

/* ---------- Overview stats ---------- */
async function loadStats() {
  try {
    const dbId = POCKETBASE_CONFIG.databaseId;
    const [students, staffList, classes] = await Promise.all([
      databases.listDocuments(dbId, POCKETBASE_CONFIG.collections.students, [Query.limit(1)]),
      databases.listDocuments(dbId, POCKETBASE_CONFIG.collections.staff, [Query.limit(1)]),
      databases.listDocuments(dbId, POCKETBASE_CONFIG.collections.classes, [Query.limit(1)]),
    ]);
    document.getElementById("stat-students").textContent = students.total ?? 0;
    document.getElementById("stat-staff").textContent = staffList.total ?? 0;
    document.getElementById("stat-classes").textContent = classes.total ?? 0;
  } catch (err) {
    console.error(err);
  }
}

/* ---------- Shared edit modal ---------- */
let EDIT_CONTEXT = null; // { type: 'class' | 'student' | 'staff', id }

function openEditModal(type, title, bodyHtml, ctx) {
  document.getElementById("edit-modal-title").textContent = title;
  document.getElementById("edit-form-body").innerHTML = bodyHtml;
  EDIT_CONTEXT = { type, ...ctx };
  document.getElementById("edit-modal").classList.remove("hidden");
  document.getElementById("edit-modal").classList.add("flex");
}

function closeEditModal() {
  document.getElementById("edit-modal").classList.add("hidden");
  document.getElementById("edit-modal").classList.remove("flex");
  document.getElementById("edit-form-body").innerHTML = "";
  EDIT_CONTEXT = null;
}

document.getElementById("edit-modal-close").addEventListener("click", closeEditModal);
document.getElementById("edit-modal-cancel").addEventListener("click", closeEditModal);

document.getElementById("edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!EDIT_CONTEXT) return;
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Saving...";
  try {
    if (EDIT_CONTEXT.type === "class") await saveClassEdit(EDIT_CONTEXT.id);
    else if (EDIT_CONTEXT.type === "student") await saveStudentEdit(EDIT_CONTEXT.id);
    else if (EDIT_CONTEXT.type === "staff") await saveStaffEdit(EDIT_CONTEXT.id);
    else if (EDIT_CONTEXT.type === "score") await saveScoreEdit(EDIT_CONTEXT.id);
    closeEditModal();
  } catch (err) {
    console.error(err);
    toast(err.message || "Could not save changes.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save changes";
  }
});

function attachPillToggle(selector) {
  document.querySelectorAll(selector).forEach((cb) => {
    cb.addEventListener("change", () => {
      cb.closest("label").classList.toggle("pill-green", cb.checked);
      cb.closest("label").classList.toggle("pill-gray", !cb.checked);
    });
  });
}

/* ---------- Classes ---------- */
async function loadClasses() {
  let data;
  try {
    const res = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.classes, [Query.orderAsc("name"), Query.limit(200)]);
    data = res.documents;
  } catch (err) {
    console.error(err);
    return;
  }
  CLASSES_CACHE = data;

  const list = document.getElementById("classes-list");
  list.innerHTML = CLASSES_CACHE.map((c) => `
    <div class="border border-ink/10 rounded-xl p-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="font-display font-semibold">${escapeHtml(c.name)}</p>
          <p class="text-xs text-ink/50 mt-1">Arms: ${(c.arms || []).map(escapeHtml).join(", ") || "—"}</p>
          <p class="text-xs text-ink/50">Departments: ${(c.departments || []).map(escapeHtml).join(", ") || "—"}</p>
          <p class="text-xs text-ink/50">Subjects: ${(c.subjects || []).map(escapeHtml).join(", ") || "—"}</p>
        </div>
        <div class="flex flex-col items-end gap-1.5 shrink-0 text-xs font-medium">
          <button type="button" class="text-forest-700 hover:underline" onclick="editClass('${c.$id}')">Edit</button>
          <button type="button" class="text-forest-700 hover:underline" onclick="syncClassSubjects('${c.$id}')">Sync subjects</button>
          <button type="button" class="text-red-600 hover:underline" onclick="deleteClass('${c.$id}')">Delete</button>
        </div>
      </div>
    </div>
  `).join("") || `<p class="text-sm text-ink/40">No classes yet — add your first one.</p>`;

  const classOptions = CLASSES_CACHE.map((c) => `<option value="${c.$id}">${escapeHtml(c.name)}</option>`).join("");
  document.getElementById("s-class").innerHTML = classOptions;
  document.getElementById("sc-class").innerHTML = `<option value="">All classes</option>` + classOptions;
  const anClassSel = document.getElementById("an-class");
  if (anClassSel) anClassSel.innerHTML = `<option value="">All classes</option>` + classOptions;
  const libClassSel = document.getElementById("lib-class");
  if (libClassSel) libClassSel.innerHTML = `<option value="">All classes</option>` + CLASSES_CACHE.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("");
  populateArmSelect("sc-arm", document.getElementById("sc-class").value);
  populateArmSelect("an-arm", document.getElementById("an-class").value);

  updateArmDeptOptions();
  updateSubjectOptions();
  renderStaffAssignmentOptions();
  populateCbtDropdowns();
}

/** Builds the checkbox-pill list for a set of classes/arms, marking
 * `assigned` values as pre-checked. Shared by the Add Staff form
 * (assigned = []) and the Edit Staff modal (assigned = their current
 * classes/subjects) so both stay in sync with real class data — this
 * used to be free-text, which let typos/formatting drift out of sync
 * with real data and silently broke the staff "Enter Scores" screen. */
function renderClassAssignmentOptionsHtml(assigned, checkClass) {
  if (CLASSES_CACHE.length === 0) {
    return `<p class="text-sm text-ink/40">Add a class first (Classes &amp; Subjects tab).</p>`;
  }
  return CLASSES_CACHE.map((c) => {
    const options = c.arms && c.arms.length ? c.arms.map((a) => formatClassAssignment(c.name, a)) : [c.name];
    return options.map((value) => `
      <label class="pill ${assigned.includes(value) ? "pill-green" : "pill-gray"} cursor-pointer select-none">
        <input type="checkbox" value="${escapeHtml(value)}" class="${checkClass}" style="accent-color:#2b5646" ${assigned.includes(value) ? "checked" : ""} />
        ${escapeHtml(value)}
      </label>
    `).join("");
  }).join("");
}

function renderSubjectAssignmentOptionsHtml(assigned, checkClass) {
  const allSubjects = new Set();
  CLASSES_CACHE.forEach((c) => (c.subjects || []).forEach((s) => allSubjects.add(s)));
  return [...allSubjects].map((s) => `
    <label class="pill ${assigned.includes(s) ? "pill-green" : "pill-gray"} cursor-pointer select-none">
      <input type="checkbox" value="${escapeHtml(s)}" class="${checkClass}" style="accent-color:#2b5646" ${assigned.includes(s) ? "checked" : ""} />
      ${escapeHtml(s)}
    </label>
  `).join("") || `<p class="text-sm text-ink/40">No subjects added to any class yet.</p>`;
}

function renderStaffAssignmentOptions() {
  document.getElementById("st-classes").innerHTML = renderClassAssignmentOptionsHtml([], "st-class-check");
  document.getElementById("st-subjects").innerHTML = renderSubjectAssignmentOptionsHtml([], "st-subject-check");
  attachPillToggle(".st-class-check, .st-subject-check");
}

/** Refills an "All arms" dropdown to match whichever class is picked
 * in a paired class select — used by the Scores and Analytics filters
 * so admin can narrow a report down to one arm, not just the whole class. */
function populateArmSelect(selectId, classId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const current = sel.value;
  const cls = CLASSES_CACHE.find((c) => c.$id === classId);
  const arms = cls?.arms || [];
  sel.innerHTML = `<option value="">All arms</option>` + arms.map((a) => `<option ${a === current ? "selected" : ""}>${escapeHtml(a)}</option>`).join("");
}

function updateArmDeptOptions() {
  const classId = document.getElementById("s-class").value;
  const cls = CLASSES_CACHE.find((c) => c.$id === classId);
  const armSel = document.getElementById("s-arm");
  const deptSel = document.getElementById("s-department");
  armSel.innerHTML = `<option value="">—</option>` + (cls?.arms || []).map((a) => `<option>${escapeHtml(a)}</option>`).join("");
  deptSel.innerHTML = `<option value="">—</option>` + (cls?.departments || []).map((d) => `<option>${escapeHtml(d)}</option>`).join("");
}
document.getElementById("s-class")?.addEventListener("change", updateArmDeptOptions);

function updateSubjectOptions() {
  const allSubjects = new Set();
  CLASSES_CACHE.forEach((c) => (c.subjects || []).forEach((s) => allSubjects.add(s)));
  document.getElementById("sc-subject").innerHTML = `<option value="">All subjects</option>` + [...allSubjects].map((s) => `<option>${escapeHtml(s)}</option>`).join("");
}

document.getElementById("class-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("class-name").value.trim();
  const arms = splitCsv(document.getElementById("class-arms").value);
  const departments = splitCsv(document.getElementById("class-departments").value);
  const subjects = splitCsv(document.getElementById("class-subjects").value);

  try {
    await databases.createDocument(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.classes, ID.unique(), { name, arms, departments, subjects });
    toast(`${name} added.`);
    e.target.reset();
    await loadClasses();
    await loadStats();
  } catch (err) {
    console.error(err);
    toast("Couldn't add class. See console for details.", "error");
  }
});

function classEditBodyHtml(cls) {
  return `
    <div>
      <label class="block text-sm font-medium text-ink/70 mb-1.5">Class name</label>
      <input id="ef-class-name" required value="${escapeHtml(cls.name)}" class="w-full px-3.5 py-2.5 rounded-lg border border-ink/10 outline-none focus:border-forest-600" />
    </div>
    <div>
      <label class="block text-sm font-medium text-ink/70 mb-1.5">Arms (comma-separated)</label>
      <input id="ef-class-arms" value="${escapeHtml((cls.arms || []).join(", "))}" class="w-full px-3.5 py-2.5 rounded-lg border border-ink/10 outline-none focus:border-forest-600" />
    </div>
    <div>
      <label class="block text-sm font-medium text-ink/70 mb-1.5">Departments (comma-separated)</label>
      <input id="ef-class-departments" value="${escapeHtml((cls.departments || []).join(", "))}" class="w-full px-3.5 py-2.5 rounded-lg border border-ink/10 outline-none focus:border-forest-600" />
    </div>
    <div>
      <label class="block text-sm font-medium text-ink/70 mb-1.5">Subjects (comma-separated)</label>
      <input id="ef-class-subjects" value="${escapeHtml((cls.subjects || []).join(", "))}" class="w-full px-3.5 py-2.5 rounded-lg border border-ink/10 outline-none focus:border-forest-600" />
    </div>
    <p class="text-xs text-ink/50">Removing an arm or subject here also clears/removes it from students and staff already assigned to it. Renaming the class updates every student, staff, and score record that references it.</p>
  `;
}

function editClass(id) {
  const cls = CLASSES_CACHE.find((c) => c.$id === id);
  if (!cls) return;
  openEditModal("class", `Edit ${cls.name}`, classEditBodyHtml(cls), { id });
}

async function saveClassEdit(id) {
  const oldCls = CLASSES_CACHE.find((c) => c.$id === id);
  const name = document.getElementById("ef-class-name").value.trim();
  const arms = splitCsv(document.getElementById("ef-class-arms").value);
  const departments = splitCsv(document.getElementById("ef-class-departments").value);
  const subjects = splitCsv(document.getElementById("ef-class-subjects").value);

  await databases.updateDocument(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.classes, id, { name, arms, departments, subjects });

  const nameChanged = oldCls.name !== name;
  const subjectsChanged = JSON.stringify(oldCls.subjects || []) !== JSON.stringify(subjects);
  const removedArms = (oldCls.arms || []).filter((a) => !arms.includes(a));
  const matchName = nameChanged ? name : oldCls.name;

  const cascadeErrors = [];
  if (nameChanged) {
    try { await cascadeClassRename(oldCls.name, name); }
    catch (err) { console.error(err); cascadeErrors.push("renaming existing student/staff/score records"); }
  }
  for (const arm of removedArms) {
    try { await cascadeArmRemoved(matchName, arm); }
    catch (err) { console.error(err); cascadeErrors.push(`clearing the removed arm "${arm}"`); }
  }
  if (subjectsChanged) {
    try { await cascadeClassSubjectsSync(matchName, subjects, oldCls.subjects || []); }
    catch (err) { console.error(err); cascadeErrors.push("syncing subjects to students/staff"); }
  }

  if (cascadeErrors.length > 0) {
    toast(`Class saved, but ${cascadeErrors.join(" and ")} failed — check the browser console and try the edit again.`, "error");
  } else {
    toast("Class updated.");
  }
  await Promise.all([loadClasses(), loadStudents(), loadStaff(), loadStats()]);
}

/** Manual escape hatch: re-pushes this class's current subject list
 * onto every student in it right now, regardless of whether the
 * subjects field technically changed since the class doc was last
 * saved. Useful if an earlier auto-sync silently failed (e.g. a
 * class-name mismatch, or a permissions/network hiccup) and simply
 * re-saving the class wouldn't retrigger it because nothing "changed"
 * from the class doc's point of view. Logs the matched-student count
 * to the console either way, so a 0 tells you the class name on the
 * student records doesn't exactly match this class's name. */
async function syncClassSubjects(id) {
  const cls = CLASSES_CACHE.find((c) => c.$id === id);
  if (!cls) return;
  try {
    await cascadeClassSubjectsSync(cls.name, cls.subjects || [], []);
    toast(`Subjects re-synced to every student in ${cls.name}.`);
    await loadStudents(document.getElementById("student-search").value);
  } catch (err) {
    console.error(err);
    toast("Sync failed — check the browser console for details.", "error");
  }
}

async function deleteClass(id) {
  const cls = CLASSES_CACHE.find((c) => c.$id === id);
  if (!cls) return;
  if (!confirm(`Delete class "${cls.name}"? Students in this class will have their class cleared, and staff assignments to it removed. This cannot be undone.`)) return;

  try {
    const dbId = POCKETBASE_CONFIG.databaseId;

    const students = await databases.listDocuments(dbId, POCKETBASE_CONFIG.collections.students, [Query.equal("class_name", cls.name), Query.limit(200)]);
    await Promise.all(students.documents.map((s) =>
      databases.updateDocument(dbId, POCKETBASE_CONFIG.collections.students, s.$id, { class_id: "", class_name: "", arm: "", department: "" })
    ));

    const staffList = await databases.listDocuments(dbId, POCKETBASE_CONFIG.collections.staff, [Query.limit(200)]);
    await Promise.all(staffList.documents.map((st) => {
      const updated = (st.classes || []).filter((c) => parseClassAssignment(c).className !== cls.name);
      if (updated.length !== (st.classes || []).length) {
        return databases.updateDocument(dbId, POCKETBASE_CONFIG.collections.staff, st.$id, { classes: updated });
      }
      return Promise.resolve();
    }));

    await databases.deleteDocument(dbId, POCKETBASE_CONFIG.collections.classes, id);
    toast("Class deleted.");
    await Promise.all([loadClasses(), loadStudents(), loadStaff(), loadStats()]);
  } catch (err) {
    console.error(err);
    toast("Could not delete class. See console for details.", "error");
  }
}

/** When a class is renamed, every record that stores the class as a
 * plain string (students, staff assignments, scores, class-scoped
 * messages) needs to follow — otherwise those records silently point
 * at a class name that no longer exists. Best-effort: logs and
 * continues rather than leaving the class doc unsaved if one part
 * of the cascade fails. */
async function cascadeClassRename(oldName, newName) {
  const dbId = POCKETBASE_CONFIG.databaseId;
  const students = await databases.listDocuments(dbId, POCKETBASE_CONFIG.collections.students, [Query.equal("class_name", oldName), Query.limit(200)]);
  await Promise.all(students.documents.map((s) => databases.updateDocument(dbId, POCKETBASE_CONFIG.collections.students, s.$id, { class_name: newName })));

  const staffList = await databases.listDocuments(dbId, POCKETBASE_CONFIG.collections.staff, [Query.limit(200)]);
  await Promise.all(staffList.documents.map((st) => {
    const updated = (st.classes || []).map((c) => {
      const { className, arm } = parseClassAssignment(c);
      return className === oldName ? formatClassAssignment(newName, arm) : c;
    });
    if (JSON.stringify(updated) !== JSON.stringify(st.classes || [])) {
      return databases.updateDocument(dbId, POCKETBASE_CONFIG.collections.staff, st.$id, { classes: updated });
    }
    return Promise.resolve();
  }));

  const scores = await databases.listDocuments(dbId, POCKETBASE_CONFIG.collections.scores, [Query.equal("class_name", oldName), Query.limit(200)]);
  await Promise.all(scores.documents.map((sc) => databases.updateDocument(dbId, POCKETBASE_CONFIG.collections.scores, sc.$id, { class_name: newName })));

  const messages = await databases.listDocuments(dbId, POCKETBASE_CONFIG.collections.messages, [Query.equal("scope", "class"), Query.equal("target", oldName), Query.limit(200)]);
  await Promise.all(messages.documents.map((m) => databases.updateDocument(dbId, POCKETBASE_CONFIG.collections.messages, m.$id, { target: newName })));
}

/** Clears a removed arm off any student who had it, and drops the
 * matching "Class (Arm)" entry from any staff assignment list. */
async function cascadeArmRemoved(className, arm) {
  const dbId = POCKETBASE_CONFIG.databaseId;
  const students = await databases.listDocuments(dbId, POCKETBASE_CONFIG.collections.students, [Query.equal("class_name", className), Query.equal("arm", arm), Query.limit(200)]);
  await Promise.all(students.documents.map((s) => databases.updateDocument(dbId, POCKETBASE_CONFIG.collections.students, s.$id, { arm: "" })));

  const target = formatClassAssignment(className, arm);
  const staffList = await databases.listDocuments(dbId, POCKETBASE_CONFIG.collections.staff, [Query.limit(200)]);
  await Promise.all(staffList.documents.map((st) => {
    if ((st.classes || []).includes(target)) {
      return databases.updateDocument(dbId, POCKETBASE_CONFIG.collections.staff, st.$id, { classes: st.classes.filter((c) => c !== target) });
    }
    return Promise.resolve();
  }));
}

/** Every student in a class mirrors that class's subject list exactly
 * (this matches how subjects are set when a student is created or
 * edited) — so this does a full resync rather than only handling
 * removals, meaning a newly added subject becomes available to every
 * current student in the class immediately, not just to students
 * added afterwards. Subjects dropped from the class are also
 * unassigned from any staff member who taught them here, but only if
 * no other class still offers that subject (so e.g. a Mathematics
 * teacher for JSS2 doesn't lose Mathematics just because it was
 * removed from JSS1). Historical scores are left untouched either
 * way — this only affects what's currently offered/assigned. */
async function cascadeClassSubjectsSync(className, newSubjects, oldSubjects) {
  const dbId = POCKETBASE_CONFIG.databaseId;
  let students = await databases.listDocuments(dbId, POCKETBASE_CONFIG.collections.students, [Query.equal("class_name", className), Query.limit(200)]);

  // Fallback: an exact match found nobody, which almost always means
  // some students' class_name drifted from the class's current name
  // (leftover from a rename that didn't fully cascade, a stray space,
  // different casing, etc.) rather than the class genuinely being
  // empty. Scan everyone and match loosely, then heal the field back
  // to the canonical name so this doesn't keep happening.
  if (students.documents.length === 0) {
    const all = await databases.listDocuments(dbId, POCKETBASE_CONFIG.collections.students, [Query.limit(200)]);
    const target = className.trim().toLowerCase();
    const loose = all.documents.filter((s) => (s.class_name || "").trim().toLowerCase() === target && s.class_name !== className);
    if (loose.length > 0) {
      console.warn(`Subject sync: 0 exact matches for class_name === "${className}", but found ${loose.length} student(s) with a near-match class_name (e.g. "${loose[0].class_name}") — healing them to the exact name.`);
    }
    students = { documents: loose };
  }

  console.log(`Subject sync: updating ${students.documents.length} student(s) to class_name "${className}" with subjects [${newSubjects.join(", ")}].`);
  await Promise.all(students.documents.map((s) => databases.updateDocument(dbId, POCKETBASE_CONFIG.collections.students, s.$id, { class_name: className, subjects: newSubjects })));

  const removedSubjects = (oldSubjects || []).filter((s) => !newSubjects.includes(s));
  if (removedSubjects.length === 0) return;

  const { documents: allClasses } = await databases.listDocuments(dbId, POCKETBASE_CONFIG.collections.classes, [Query.limit(200)]);
  const stillOffered = new Set();
  allClasses.forEach((c) => (c.subjects || []).forEach((s) => stillOffered.add(s)));
  const trulyGone = removedSubjects.filter((s) => !stillOffered.has(s));
  if (trulyGone.length === 0) return;

  const staffList = await databases.listDocuments(dbId, POCKETBASE_CONFIG.collections.staff, [Query.limit(200)]);
  await Promise.all(staffList.documents.map((st) => {
    const updated = (st.subjects || []).filter((s) => !trulyGone.includes(s));
    if (updated.length !== (st.subjects || []).length) {
      return databases.updateDocument(dbId, POCKETBASE_CONFIG.collections.staff, st.$id, { subjects: updated });
    }
    return Promise.resolve();
  }));
}

/* ---------- Students ---------- */
async function loadStudents(searchTerm = "") {
  let rows;
  try {
    const res = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.students, [Query.orderDesc("$createdAt"), Query.limit(100)]);
    rows = res.documents;
  } catch (err) {
    console.error(err);
    return;
  }
  STUDENTS_CACHE = rows;

  if (searchTerm) {
    const t = searchTerm.toLowerCase();
    rows = rows.filter((r) => r.full_name.toLowerCase().includes(t) || r.school_id.toLowerCase().includes(t));
  }

  document.getElementById("students-table").innerHTML = rows.map((r) => `
    <tr class="border-b border-ink/5">
      <td class="py-2.5 pr-3">
        <div class="flex items-center gap-2.5">
          ${avatarHtml(r, { size: 32 })}
          <span>${escapeHtml(r.full_name)}</span>
        </div>
      </td>
      <td class="py-2.5 pr-3 font-idmono text-xs">${escapeHtml(r.school_id)}</td>
      <td class="py-2.5 pr-3">${escapeHtml(r.class_name || "—")}</td>
      <td class="py-2.5 pr-3">${escapeHtml(r.arm || "—")}</td>
      <td class="py-2.5 pr-3">
        <div class="flex gap-3">
          <button type="button" class="text-forest-700 hover:underline" onclick="editStudent('${r.$id}')">Edit</button>
          <button type="button" class="text-forest-700 hover:underline" onclick="downloadStudentReport('${r.$id}')">Report</button>
          <button type="button" class="text-red-600 hover:underline" onclick="deleteStudent('${r.$id}')">Delete</button>
        </div>
      </td>
    </tr>
  `).join("") || `<tr><td colspan="5" class="py-4 text-ink/40 text-sm">No students yet.</td></tr>`;
}

document.getElementById("student-search").addEventListener("input", (e) => loadStudents(e.target.value));

document.getElementById("student-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Creating...";

  try {
    const fullName = document.getElementById("s-name").value.trim();
    const classId = document.getElementById("s-class").value;
    const cls = CLASSES_CACHE.find((c) => c.$id === classId);
    const arm = document.getElementById("s-arm").value;
    const department = document.getElementById("s-department").value;
    const guardianName = document.getElementById("s-guardian-name").value.trim();
    const guardianPhone = document.getElementById("s-guardian-phone").value.trim();
    const guardianEmail = document.getElementById("s-guardian-email").value.trim();

    const { schoolId, userId } = await createAccount("student", {
      fullName,
      classId,
      className: cls?.name || "",
      arm,
      department,
      subjects: cls?.subjects || [],
      guardianName,
      guardianPhone,
      guardianEmail,
    });

    const photoFile = document.getElementById("s-photo").files?.[0];
    if (photoFile) {
      try {
        await databases.updateDocument(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.students, userId, { photo: photoFile });
      } catch (photoErr) {
        console.error(photoErr);
        toast("Student added, but the photo couldn't be uploaded.", "error");
      }
    }

    document.getElementById("modal-name").textContent = fullName;
    document.getElementById("modal-meta").textContent = `${cls?.name || ""}${arm ? " · Arm " + arm : ""}`;
    document.getElementById("modal-id").textContent = schoolId;
    document.getElementById("modal-initials").textContent = initials(fullName);
    document.getElementById("id-modal").classList.remove("hidden");
    document.getElementById("id-modal").classList.add("flex");

    e.target.reset();
    document.getElementById("s-photo-preview").textContent = "No photo";
    updateArmDeptOptions();
    await loadStudents();
    await loadStats();
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

document.getElementById("modal-close").addEventListener("click", () => {
  document.getElementById("id-modal").classList.add("hidden");
  document.getElementById("id-modal").classList.remove("flex");
});

/** Shared photo field for the Edit Student / Edit Staff modals: shows
 * the current avatar, a file input to replace it, and (only when a
 * photo already exists) a checkbox to remove it outright. */
function photoEditFieldHtml(record, inputId) {
  return `
    <div>
      <label class="block text-sm font-medium text-ink/70 mb-1.5">Photo</label>
      <div class="flex items-center gap-3">
        <div id="${inputId}-preview" class="w-14 h-14 rounded-lg overflow-hidden shrink-0">${avatarHtml(record, { size: 56 })}</div>
        <div class="flex-1 space-y-1.5">
          <input id="${inputId}" type="file" accept="image/png,image/jpeg,image/webp" class="w-full text-sm" />
          ${record.photo ? `<label class="flex items-center gap-1.5 text-xs text-ink/60 cursor-pointer"><input type="checkbox" id="${inputId}-remove" style="accent-color:#2b5646" /> Remove current photo</label>` : ""}
        </div>
      </div>
    </div>
  `;
}

function studentEditBodyHtml(s) {
  const classOptions = CLASSES_CACHE.map((c) => `<option value="${c.$id}" ${c.$id === s.class_id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("");
  return `
    <div>
      <label class="block text-sm font-medium text-ink/70 mb-1.5">Full name</label>
      <input id="ef-s-name" required value="${escapeHtml(s.full_name)}" class="w-full px-3.5 py-2.5 rounded-lg border border-ink/10 outline-none focus:border-forest-600" />
    </div>
    ${photoEditFieldHtml(s, "ef-s-photo")}
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="block text-sm font-medium text-ink/70 mb-1.5">Class</label>
        <select id="ef-s-class" class="w-full px-3.5 py-2.5 rounded-lg border border-ink/10 outline-none focus:border-forest-600">${classOptions}</select>
      </div>
      <div>
        <label class="block text-sm font-medium text-ink/70 mb-1.5">Arm</label>
        <select id="ef-s-arm" class="w-full px-3.5 py-2.5 rounded-lg border border-ink/10 outline-none focus:border-forest-600"></select>
      </div>
    </div>
    <div>
      <label class="block text-sm font-medium text-ink/70 mb-1.5">Department</label>
      <select id="ef-s-department" class="w-full px-3.5 py-2.5 rounded-lg border border-ink/10 outline-none focus:border-forest-600"></select>
    </div>
    <div>
      <label class="block text-sm font-medium text-ink/70 mb-1.5">Guardian name</label>
      <input id="ef-s-guardian-name" value="${escapeHtml(s.guardian_name || "")}" class="w-full px-3.5 py-2.5 rounded-lg border border-ink/10 outline-none focus:border-forest-600" />
    </div>
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="block text-sm font-medium text-ink/70 mb-1.5">Guardian phone</label>
        <input id="ef-s-guardian-phone" value="${escapeHtml(s.guardian_phone || "")}" class="w-full px-3.5 py-2.5 rounded-lg border border-ink/10 outline-none focus:border-forest-600" />
      </div>
      <div>
        <label class="block text-sm font-medium text-ink/70 mb-1.5">Guardian email</label>
        <input id="ef-s-guardian-email" type="email" value="${escapeHtml(s.guardian_email || "")}" class="w-full px-3.5 py-2.5 rounded-lg border border-ink/10 outline-none focus:border-forest-600" />
      </div>
    </div>
  `;
}

function updateEditArmDeptOptions(selectedArm = "", selectedDept = "") {
  const classId = document.getElementById("ef-s-class").value;
  const cls = CLASSES_CACHE.find((c) => c.$id === classId);
  const armSel = document.getElementById("ef-s-arm");
  const deptSel = document.getElementById("ef-s-department");
  armSel.innerHTML = `<option value="">—</option>` + (cls?.arms || []).map((a) => `<option ${a === selectedArm ? "selected" : ""}>${escapeHtml(a)}</option>`).join("");
  deptSel.innerHTML = `<option value="">—</option>` + (cls?.departments || []).map((d) => `<option ${d === selectedDept ? "selected" : ""}>${escapeHtml(d)}</option>`).join("");
}

function editStudent(id) {
  const s = STUDENTS_CACHE.find((x) => x.$id === id);
  if (!s) return;
  openEditModal("student", `Edit ${s.full_name}`, studentEditBodyHtml(s), { id });
  document.getElementById("ef-s-class").addEventListener("change", () => updateEditArmDeptOptions());
  updateEditArmDeptOptions(s.arm, s.department);
  wirePhotoPreview("ef-s-photo", "ef-s-photo-preview");
}

async function saveStudentEdit(id) {
  const fullName = document.getElementById("ef-s-name").value.trim();
  const classId = document.getElementById("ef-s-class").value;
  const cls = CLASSES_CACHE.find((c) => c.$id === classId);
  const arm = document.getElementById("ef-s-arm").value;
  const department = document.getElementById("ef-s-department").value;
  const guardianName = document.getElementById("ef-s-guardian-name").value.trim();
  const guardianPhone = document.getElementById("ef-s-guardian-phone").value.trim();
  const guardianEmail = document.getElementById("ef-s-guardian-email").value.trim();

  const data = {
    full_name: fullName,
    class_id: classId,
    class_name: cls?.name || "",
    arm,
    department,
    subjects: cls?.subjects || [],
    guardian_name: guardianName,
    guardian_phone: guardianPhone,
    guardian_email: guardianEmail,
  };
  const photoFile = document.getElementById("ef-s-photo")?.files?.[0];
  const removePhoto = document.getElementById("ef-s-photo-remove")?.checked;
  if (photoFile) data.photo = photoFile;
  else if (removePhoto) data.photo = null;

  await databases.updateDocument(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.students, id, data);

  toast("Student updated.");
  await loadStudents(document.getElementById("student-search").value);
  await loadStats();
}

async function deleteStudent(id) {
  const s = STUDENTS_CACHE.find((x) => x.$id === id);
  if (!s) return;
  if (!confirm(`Delete ${s.full_name} (${s.school_id})? This removes their login and all their data. This cannot be undone.`)) return;

  try {
    await deleteAccount("student", id);
    toast("Student deleted.");
    await loadStudents(document.getElementById("student-search").value);
    await loadStats();
  } catch (err) {
    console.error(err);
    toast(err.message || "Could not delete student.", "error");
  }
}

/* ---------- Staff ---------- */
async function loadStaff(searchTerm = "") {
  let data;
  try {
    const res = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.staff, [Query.orderDesc("$createdAt"), Query.limit(100)]);
    data = res.documents;
  } catch (err) {
    console.error(err);
    return;
  }
  STAFF_CACHE = data;

  let rows = data;
  if (searchTerm) {
    const t = searchTerm.toLowerCase();
    rows = rows.filter((r) =>
      r.full_name.toLowerCase().includes(t) ||
      r.school_id.toLowerCase().includes(t) ||
      (r.position || "").toLowerCase().includes(t)
    );
  }

  document.getElementById("staff-table").innerHTML = rows.map((r) => `
    <tr class="border-b border-ink/5">
      <td class="py-2.5 pr-3">
        <div class="flex items-center gap-2.5">
          ${avatarHtml(r, { size: 32 })}
          <span>${escapeHtml(r.full_name)}</span>
        </div>
      </td>
      <td class="py-2.5 pr-3 font-idmono text-xs">${escapeHtml(r.school_id)}</td>
      <td class="py-2.5 pr-3">${escapeHtml(r.position || "—")}</td>
      <td class="py-2.5 pr-3">${(r.classes || []).map(escapeHtml).join(", ") || "—"}</td>
      <td class="py-2.5 pr-3">
        <div class="flex gap-3">
          <button type="button" class="text-forest-700 hover:underline" onclick="editStaff('${r.$id}')">Edit</button>
          <button type="button" class="text-red-600 hover:underline" onclick="deleteStaff('${r.$id}')">Delete</button>
        </div>
      </td>
    </tr>
  `).join("") || `<tr><td colspan="5" class="py-4 text-ink/40 text-sm">No staff match your search.</td></tr>`;
}

document.getElementById("staff-search")?.addEventListener("input", (e) => loadStaff(e.target.value));

document.getElementById("staff-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Creating...";

  try {
    const fullName = document.getElementById("st-name").value.trim();
    const position = document.getElementById("st-position").value.trim();
    const classes = [...document.querySelectorAll(".st-class-check:checked")].map((cb) => cb.value);
    const subjects = [...document.querySelectorAll(".st-subject-check:checked")].map((cb) => cb.value);

    const { schoolId, userId } = await createAccount("staff", { fullName, position, classes, subjects });

    const photoFile = document.getElementById("st-photo").files?.[0];
    if (photoFile) {
      try {
        await databases.updateDocument(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.staff, userId, { photo: photoFile });
      } catch (photoErr) {
        console.error(photoErr);
        toast("Staff member added, but the photo couldn't be uploaded.", "error");
      }
    }

    document.getElementById("modal-name").textContent = fullName;
    document.getElementById("modal-meta").textContent = position || "Staff";
    document.getElementById("modal-id").textContent = schoolId;
    document.getElementById("modal-initials").textContent = initials(fullName);
    document.getElementById("id-modal").classList.remove("hidden");
    document.getElementById("id-modal").classList.add("flex");

    e.target.reset();
    document.getElementById("st-photo-preview").textContent = "No photo";
    document.querySelectorAll(".st-class-check, .st-subject-check").forEach((cb) => {
      cb.closest("label").classList.remove("pill-green");
      cb.closest("label").classList.add("pill-gray");
    });
    await loadStaff();
    await loadStats();
    toast("Staff member added.");
  } catch (err) {
    console.error(err);
    const message = isRateLimitError(err)
      ? "Too many account creations at once. Wait a moment and try again."
      : err.message === "Another account creation is already in progress. Wait for it to finish."
        ? err.message
        : err.message || "Couldn't add staff. See console for details.";
    toast(message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Add staff & generate ID";
  }
});

function staffEditBodyHtml(st) {
  return `
    <div>
      <label class="block text-sm font-medium text-ink/70 mb-1.5">Full name</label>
      <input id="ef-st-name" required value="${escapeHtml(st.full_name)}" class="w-full px-3.5 py-2.5 rounded-lg border border-ink/10 outline-none focus:border-forest-600" />
    </div>
    ${photoEditFieldHtml(st, "ef-st-photo")}
    <div>
      <label class="block text-sm font-medium text-ink/70 mb-1.5">Position</label>
      <input id="ef-st-position" value="${escapeHtml(st.position || "")}" class="w-full px-3.5 py-2.5 rounded-lg border border-ink/10 outline-none focus:border-forest-600" />
    </div>
    <div>
      <label class="block text-sm font-medium text-ink/70 mb-1.5">Assigned classes</label>
      <div id="ef-st-classes" class="flex flex-wrap gap-2 p-3 rounded-lg border border-ink/10 min-h-[48px]">
        ${renderClassAssignmentOptionsHtml(st.classes || [], "ef-st-class-check")}
      </div>
    </div>
    <div>
      <label class="block text-sm font-medium text-ink/70 mb-1.5">Assigned subjects</label>
      <div id="ef-st-subjects" class="flex flex-wrap gap-2 p-3 rounded-lg border border-ink/10 min-h-[48px]">
        ${renderSubjectAssignmentOptionsHtml(st.subjects || [], "ef-st-subject-check")}
      </div>
    </div>
  `;
}

function editStaff(id) {
  const st = STAFF_CACHE.find((x) => x.$id === id);
  if (!st) return;
  openEditModal("staff", `Edit ${st.full_name}`, staffEditBodyHtml(st), { id });
  attachPillToggle(".ef-st-class-check, .ef-st-subject-check");
  wirePhotoPreview("ef-st-photo", "ef-st-photo-preview");
}

async function saveStaffEdit(id) {
  const fullName = document.getElementById("ef-st-name").value.trim();
  const position = document.getElementById("ef-st-position").value.trim();
  const classes = [...document.querySelectorAll(".ef-st-class-check:checked")].map((cb) => cb.value);
  const subjects = [...document.querySelectorAll(".ef-st-subject-check:checked")].map((cb) => cb.value);

  const data = { full_name: fullName, position, classes, subjects };
  const photoFile = document.getElementById("ef-st-photo")?.files?.[0];
  const removePhoto = document.getElementById("ef-st-photo-remove")?.checked;
  if (photoFile) data.photo = photoFile;
  else if (removePhoto) data.photo = null;

  await databases.updateDocument(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.staff, id, data);
  toast("Staff member updated.");
  await loadStaff(document.getElementById("staff-search")?.value || "");
  await loadStats();
}

async function deleteStaff(id) {
  const st = STAFF_CACHE.find((x) => x.$id === id);
  if (!st) return;
  if (!confirm(`Delete ${st.full_name} (${st.school_id})? This removes their login and staff access. This cannot be undone.`)) return;

  try {
    await deleteAccount("staff", id);
    toast("Staff member deleted.");
    await loadStaff(document.getElementById("staff-search")?.value || "");
    await loadStats();
  } catch (err) {
    console.error(err);
    toast(err.message || "Could not delete staff member.", "error");
  }
}

/* ---------- Scores overview ---------- */
async function loadScores() {
  const classId = document.getElementById("sc-class").value;
  const className = CLASSES_CACHE.find((c) => c.$id === classId)?.name;
  const arm = document.getElementById("sc-arm")?.value || "";
  const subject = document.getElementById("sc-subject").value;
  const term = document.getElementById("sc-term").value;
  const searchTerm = document.getElementById("sc-search")?.value || "";

  const filters = [Query.equal("term", term), Query.orderAsc("position"), Query.limit(200)];
  if (className) filters.push(Query.equal("class_name", className));
  if (subject) filters.push(Query.equal("subject", subject));

  try {
    const { documents: data } = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.scores, filters);
    SCORES_CACHE = data;

    let rows = data;
    // Scores don't store an arm of their own — narrow by arm using each
    // score's linked student record instead (class_name alone can span
    // several arms).
    if (arm) {
      if (STUDENTS_CACHE.length === 0) await loadStudents();
      rows = rows.filter((r) => STUDENTS_CACHE.find((s) => s.$id === r.student_auth_id)?.arm === arm);
    }
    if (searchTerm) {
      const t = searchTerm.toLowerCase();
      rows = rows.filter((r) =>
        (r.student_name || "").toLowerCase().includes(t) ||
        (r.student_id || "").toLowerCase().includes(t)
      );
    }

    document.getElementById("scores-table").innerHTML = rows.map((r) => `
      <tr class="border-b border-ink/5">
        <td class="py-2.5 pr-3">${escapeHtml(r.student_name || r.student_id)}</td>
        <td class="py-2.5 pr-3">${r.ca1 ?? "—"}</td>
        <td class="py-2.5 pr-3">${r.ca2 ?? "—"}</td>
        <td class="py-2.5 pr-3">${r.exam ?? "—"}</td>
        <td class="py-2.5 pr-3 font-semibold">${r.total ?? "—"}</td>
        <td class="py-2.5 pr-3"><span class="pill pill-green">${escapeHtml(r.grade ?? "—")}</span></td>
        <td class="py-2.5 pr-3">${r.position ?? "—"}</td>
        <td class="py-2.5 pr-3">
          <div class="flex gap-3">
            <button type="button" class="text-forest-700 hover:underline" onclick="editScore('${r.$id}')">Edit</button>
            <button type="button" class="text-red-600 hover:underline" onclick="deleteScore('${r.$id}')">Delete</button>
          </div>
        </td>
      </tr>
    `).join("") || `<tr><td colspan="8" class="py-4 text-ink/40 text-sm">No scores match this filter.</td></tr>`;
  } catch (err) {
    console.error(err);
  }
}
document.getElementById("sc-class")?.addEventListener("change", () => {
  populateArmSelect("sc-arm", document.getElementById("sc-class").value);
  loadScores();
});
["sc-arm", "sc-subject", "sc-term"].forEach((id) => {
  document.getElementById(id).addEventListener("change", loadScores);
});
document.getElementById("sc-search")?.addEventListener("input", debounce(loadScores, 250));

/* ---------- Analytics ---------- */
const TERM_ORDER = ["First Term", "Second Term", "Third Term"];
const GRADE_COLORS = { A: "#3c7360", B: "#5c8f79", C: "#c9a227", D: "#d97a3c", E: "#c9622c", F: "#b3392c" };
let analyticsCharts = {}; // keyed by canvas id, so we can destroy before redrawing

function renderChart(canvasId, config) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (analyticsCharts[canvasId]) analyticsCharts[canvasId].destroy();
  analyticsCharts[canvasId] = new Chart(canvas.getContext("2d"), config);
}

/** Class performance: average score per subject + grade distribution,
 * for whichever class/term is selected (class blank = whole school). */
async function loadAnalytics() {
  const classId = document.getElementById("an-class").value;
  const className = CLASSES_CACHE.find((c) => c.$id === classId)?.name;
  const arm = document.getElementById("an-arm")?.value || "";
  const term = document.getElementById("an-term").value;

  const filters = [Query.equal("term", term), Query.limit(500)];
  if (className) filters.push(Query.equal("class_name", className));

  let data;
  try {
    const res = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.scores, filters);
    data = res.documents;
  } catch (err) {
    console.error(err);
    return;
  }

  if (arm) {
    if (STUDENTS_CACHE.length === 0) await loadStudents();
    data = data.filter((r) => STUDENTS_CACHE.find((s) => s.$id === r.student_auth_id)?.arm === arm);
  }

  const emptyEl = document.getElementById("an-empty");
  const contentEl = document.getElementById("an-content");
  if (data.length === 0) {
    emptyEl.classList.remove("hidden");
    contentEl.classList.add("hidden");
    document.getElementById("an-stats").innerHTML = "";
    return;
  }
  emptyEl.classList.add("hidden");
  contentEl.classList.remove("hidden");

  // Average total score per subject
  const bySubject = {};
  data.forEach((r) => {
    if (!bySubject[r.subject]) bySubject[r.subject] = [];
    bySubject[r.subject].push(Number(r.total) || 0);
  });
  const subjects = Object.keys(bySubject).sort();
  const subjectAverages = subjects.map((s) => bySubject[s].reduce((a, b) => a + b, 0) / bySubject[s].length);

  renderChart("chart-subject-avg", {
    type: "bar",
    data: {
      labels: subjects,
      datasets: [{ label: "Average score", data: subjectAverages, backgroundColor: "#3c7360", borderRadius: 6 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, max: 100 } },
      plugins: { legend: { display: false } },
    },
  });

  // Grade distribution across every score in this filter
  const gradeCounts = {};
  data.forEach((r) => {
    const g = r.grade || "—";
    gradeCounts[g] = (gradeCounts[g] || 0) + 1;
  });
  const grades = Object.keys(gradeCounts).sort();

  renderChart("chart-grade-dist", {
    type: "doughnut",
    data: {
      labels: grades,
      datasets: [{ data: grades.map((g) => gradeCounts[g]), backgroundColor: grades.map((g) => GRADE_COLORS[g] || "#8fab9c") }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } },
  });

  // Quick stats strip
  const overallAvg = (data.reduce((sum, r) => sum + (Number(r.total) || 0), 0) / data.length).toFixed(1);
  const topSubject = subjects[subjectAverages.indexOf(Math.max(...subjectAverages))];
  const weakestSubject = subjects[subjectAverages.indexOf(Math.min(...subjectAverages))];
  document.getElementById("an-stats").innerHTML = `
    <div><p class="text-ink/50 mb-1">Overall average</p><p class="font-display font-bold text-lg">${overallAvg}</p></div>
    <div><p class="text-ink/50 mb-1">Strongest subject</p><p class="font-display font-bold text-lg">${escapeHtml(topSubject)}</p></div>
    <div><p class="text-ink/50 mb-1">Needs attention</p><p class="font-display font-bold text-lg">${escapeHtml(weakestSubject)}</p></div>
  `;
}

/** Fills the student picker for the trend chart (loads STUDENTS_CACHE
 * if the Students tab hasn't been visited yet this session). */
async function populateAnalyticsStudents() {
  if (STUDENTS_CACHE.length === 0) await loadStudents();
  const sel = document.getElementById("an-student");
  const current = sel.value;
  sel.innerHTML = `<option value="">Pick a student…</option>` + STUDENTS_CACHE
    .map((s) => `<option value="${s.$id}">${escapeHtml(s.full_name)} (${escapeHtml(s.school_id)})</option>`)
    .join("");
  sel.value = current;
}

/** One student's total score per subject, across all three terms —
 * shows whether they're trending up, flat, or down over the session. */
async function loadStudentTrend() {
  const studentId = document.getElementById("an-student").value;
  const emptyEl = document.getElementById("an-student-empty");
  const contentEl = document.getElementById("an-student-content");

  if (!studentId) {
    emptyEl.classList.remove("hidden");
    contentEl.classList.add("hidden");
    return;
  }

  let data;
  try {
    const res = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.scores, [
      Query.equal("student_auth_id", studentId),
      Query.limit(200),
    ]);
    data = res.documents;
  } catch (err) {
    console.error(err);
    return;
  }

  if (data.length === 0) {
    emptyEl.classList.remove("hidden");
    emptyEl.textContent = "No scores published for this student yet.";
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

  renderChart("chart-student-trend", {
    type: "line",
    data: { labels: TERM_ORDER, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, max: 100 } },
    },
  });
}

document.getElementById("an-class")?.addEventListener("change", () => {
  populateArmSelect("an-arm", document.getElementById("an-class").value);
  loadAnalytics();
});
["an-arm", "an-term"].forEach((id) => {
  document.getElementById(id)?.addEventListener("change", loadAnalytics);
});
document.getElementById("an-student")?.addEventListener("change", loadStudentTrend);

function scoreEditBodyHtml(sc) {
  return `
    <div>
      <p class="text-sm font-medium text-ink/70 mb-1">${escapeHtml(sc.student_name || sc.student_id)}</p>
      <p class="text-xs text-ink/40">${escapeHtml(sc.subject)} · ${escapeHtml(sc.term)}</p>
    </div>
    <div class="grid grid-cols-3 gap-3">
      <div>
        <label class="block text-sm font-medium text-ink/70 mb-1.5">CA1</label>
        <input id="ef-sc-ca1" type="number" min="0" max="100" value="${sc.ca1 ?? 0}" class="w-full px-3.5 py-2.5 rounded-lg border border-ink/10 outline-none focus:border-forest-600" />
      </div>
      <div>
        <label class="block text-sm font-medium text-ink/70 mb-1.5">CA2</label>
        <input id="ef-sc-ca2" type="number" min="0" max="100" value="${sc.ca2 ?? 0}" class="w-full px-3.5 py-2.5 rounded-lg border border-ink/10 outline-none focus:border-forest-600" />
      </div>
      <div>
        <label class="block text-sm font-medium text-ink/70 mb-1.5">Exam</label>
        <input id="ef-sc-exam" type="number" min="0" max="100" value="${sc.exam ?? 0}" class="w-full px-3.5 py-2.5 rounded-lg border border-ink/10 outline-none focus:border-forest-600" />
      </div>
    </div>
    <div>
      <label class="block text-sm font-medium text-ink/70 mb-1.5">Teacher's remark</label>
      <textarea id="ef-sc-teacher-remark" rows="2" class="w-full px-3.5 py-2.5 rounded-lg border border-ink/10 outline-none focus:border-forest-600">${escapeHtml(sc.teacher_remark || "")}</textarea>
    </div>
    <div>
      <label class="block text-sm font-medium text-ink/70 mb-1.5">Admin's remark</label>
      <textarea id="ef-sc-admin-remark" rows="2" class="w-full px-3.5 py-2.5 rounded-lg border border-ink/10 outline-none focus:border-forest-600">${escapeHtml(sc.admin_remark || "")}</textarea>
    </div>
    <p class="text-xs text-ink/50">Total and grade recalculate automatically from CA1 + CA2 + Exam. Positions for the rest of the class are not recalculated automatically — use the Staff Portal's Save Scores to refresh rankings after an edit like this.</p>
  `;
}

function editScore(id) {
  const sc = SCORES_CACHE.find((x) => x.$id === id);
  if (!sc) return;
  openEditModal("score", `Edit score — ${sc.student_name || sc.student_id}`, scoreEditBodyHtml(sc), { id });
}

async function saveScoreEdit(id) {
  const ca1 = parseFloat(document.getElementById("ef-sc-ca1").value) || 0;
  const ca2 = parseFloat(document.getElementById("ef-sc-ca2").value) || 0;
  const exam = parseFloat(document.getElementById("ef-sc-exam").value) || 0;
  const teacherRemark = document.getElementById("ef-sc-teacher-remark").value.trim();
  const adminRemark = document.getElementById("ef-sc-admin-remark").value.trim();
  const total = ca1 + ca2 + exam;
  const grade = computeGrade(total);

  await databases.updateDocument(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.scores, id, {
    ca1, ca2, exam, total, grade,
    teacher_remark: teacherRemark,
    admin_remark: adminRemark,
  });

  toast("Score updated.");
  await loadScores();
}

async function deleteScore(id) {
  const sc = SCORES_CACHE.find((x) => x.$id === id);
  if (!sc) return;
  if (!confirm(`Delete the ${sc.subject} score for ${sc.student_name || sc.student_id} (${sc.term})? This cannot be undone.`)) return;

  try {
    await databases.deleteDocument(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.scores, id);
    toast("Score deleted.");
    await loadScores();
  } catch (err) {
    console.error(err);
    toast(err.message || "Could not delete score. Make sure the scores collection grants delete(\"team:admins\").", "error");
  }
}

/* ---------- Library (admin-uploaded materials) ---------- */
async function loadMaterials() {
  const searchTerm = document.getElementById("lib-search")?.value || "";
  let data;
  try {
    const res = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.materials, [Query.orderDesc("$createdAt"), Query.limit(100)]);
    data = res.documents;
  } catch (err) {
    console.error(err);
    document.getElementById("materials-list").innerHTML = `<p class="text-sm text-red-600">Couldn't load materials. Make sure the "materials" collection and storage bucket exist (see setup guide).</p>`;
    return;
  }
  MATERIALS_CACHE = data;

  let rows = data;
  if (searchTerm) {
    const t = searchTerm.toLowerCase();
    rows = rows.filter((m) =>
      m.title.toLowerCase().includes(t) ||
      (m.subject || "").toLowerCase().includes(t) ||
      (m.class_name || "").toLowerCase().includes(t)
    );
  }

  document.getElementById("materials-list").innerHTML = rows.map((m) => `
    <div class="border border-ink/10 rounded-xl p-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="font-display font-semibold">${escapeHtml(m.title)}</p>
          <p class="text-xs text-ink/50 mt-1">${escapeHtml(m.subject || "No subject")}${m.class_name ? " · " + escapeHtml(m.class_name) : " · All classes"}</p>
          ${m.description ? `<p class="text-sm text-ink/70 mt-2">${escapeHtml(m.description)}</p>` : ""}
          <p class="text-xs text-ink/40 mt-2 font-idmono">${escapeHtml(m.file_name || "")}</p>
        </div>
        <div class="flex flex-col items-end gap-1.5 shrink-0 text-xs font-medium">
          <a href="${materialFileUrl(m)}" target="_blank" rel="noopener" class="text-forest-700 hover:underline">View</a>
          <button type="button" class="text-red-600 hover:underline" onclick="deleteMaterial('${m.$id}')">Delete</button>
        </div>
      </div>
    </div>
  `).join("") || `<p class="text-sm text-ink/40">No materials uploaded yet.</p>`;
}

document.getElementById("lib-search")?.addEventListener("input", debounce(loadMaterials, 250));

document.getElementById("material-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("material-submit-btn");
  const title = document.getElementById("lib-title").value.trim();
  const description = document.getElementById("lib-description").value.trim();
  const subject = document.getElementById("lib-subject").value.trim();
  const className = document.getElementById("lib-class").value;
  const fileInput = document.getElementById("lib-file");
  const file = fileInput.files[0];

  if (!file) {
    toast("Choose a file to upload.", "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Uploading...";

  try {
    // PocketBase stores the file directly on the record via a "file"
    // field (no separate Storage bucket + two-step upload the way
    // Appwrite needed) — so this is a single create() call with a
    // FormData body instead of an upload followed by a document create.
    const form = new FormData();
    form.append("title", title);
    form.append("description", description);
    form.append("subject", subject);
    form.append("class_name", className);
    form.append("file_name", file.name);
    form.append("uploaded_by", "Admin");
    form.append("file", file);

    await pb.collection(POCKETBASE_CONFIG.collections.materials).create(form, { requestKey: null });

    toast("Material uploaded.");
    e.target.reset();
    await loadMaterials();
  } catch (err) {
    console.error(err);
    toast(err.message || "Couldn't upload material. See console for details.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Upload material";
  }
});

async function deleteMaterial(id) {
  const m = MATERIALS_CACHE.find((x) => x.$id === id);
  if (!m) return;
  if (!confirm(`Delete "${m.title}"? This removes it from every student's Digital Library. This cannot be undone.`)) return;

  try {
    // Deleting the record also removes its attached file — PocketBase
    // manages storage per-field, so there's no separate bucket file
    // to clean up the way Appwrite needed.
    await databases.deleteDocument(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.materials, id);
    toast("Material deleted.");
    await loadMaterials();
  } catch (err) {
    console.error(err);
    toast(err.message || "Could not delete material.", "error");
  }
}

/* ---------- Messages ---------- */
document.getElementById("m-scope").addEventListener("change", (e) => {
  document.getElementById("m-target-wrap").classList.toggle("hidden", e.target.value === "school");
});

async function loadMessages() {
  let data;
  try {
    const res = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.messages, [Query.orderDesc("$createdAt"), Query.limit(30)]);
    data = res.documents;
  } catch (err) {
    console.error(err);
    return;
  }

  document.getElementById("messages-list").innerHTML = data.map((m) => `
    <div class="border border-ink/10 rounded-xl p-4">
      <div class="flex items-center justify-between mb-1">
        <span class="pill pill-green">${escapeHtml(m.scope)}${m.target ? ": " + escapeHtml(m.target) : ""}</span>
        <span class="text-xs text-ink/40">${new Date(m.$createdAt).toLocaleDateString()}</span>
      </div>
      <p class="text-sm text-ink/80">${escapeHtml(m.content)}</p>
    </div>
  `).join("") || `<p class="text-sm text-ink/40">No messages sent yet.</p>`;
}

document.getElementById("message-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const scope = document.getElementById("m-scope").value;
  const target = document.getElementById("m-target").value.trim();
  const content = document.getElementById("m-content").value.trim();

  try {
    await databases.createDocument(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.messages, ID.unique(), {
      scope,
      target: scope === "school" ? "" : target,
      content,
      from_name: "Admin",
    });
    toast("Message sent.");
    e.target.reset();
    document.getElementById("m-target-wrap").classList.add("hidden");
    await loadMessages();
  } catch (err) {
    console.error(err);
    toast("Couldn't send message.", "error");
  }
});

/* ---------- CBT tests ----------
   Same feature staff already have, opened up to admin too so the
   school office can build/publish/retire tests across ANY class —
   not just ones a particular teacher is assigned to. Unlike staff.js
   (which only lists tests it created), this lists every test in the
   school, and shows who each one was built by. */
let CBT_TESTS_CACHE = [];
let cbtQuestionCount = 0;

function populateCbtDropdowns() {
  const uniqueClassNames = [...new Set(CLASSES_CACHE.map((c) => c.name))];
  const allSubjects = new Set();
  CLASSES_CACHE.forEach((c) => (c.subjects || []).forEach((s) => allSubjects.add(s)));
  document.getElementById("cbt-class").innerHTML = uniqueClassNames.map((c) => `<option>${escapeHtml(c)}</option>`).join("") || `<option value="">No classes yet</option>`;
  document.getElementById("cbt-subject").innerHTML = [...allSubjects].map((s) => `<option>${escapeHtml(s)}</option>`).join("") || `<option value="">No subjects yet</option>`;
  updateCbtArmOptions();
}

/** Refills the Arm dropdown for whichever class is currently picked.
 * Blank/"All arms" is always first and means the test targets the
 * whole class, same as before this option existed. */
function updateCbtArmOptions() {
  const className = document.getElementById("cbt-class").value;
  const cls = CLASSES_CACHE.find((c) => c.name === className);
  const arms = cls?.arms || [];
  const armSel = document.getElementById("cbt-arm");
  armSel.innerHTML = `<option value="">All arms</option>` + arms.map((a) => `<option>${escapeHtml(a)}</option>`).join("");
}
document.getElementById("cbt-class")?.addEventListener("change", updateCbtArmOptions);

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
      created_by: ADMIN_PROFILE.$id,
    });

    toast("Test saved as a draft.");
    e.target.reset();
    populateCbtDropdowns();
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

/** Best-effort "who built this" label: checks the staff cache first,
 * then falls back to "You" for tests admin itself created. */
function cbtCreatorLabel(createdById) {
  if (createdById === ADMIN_PROFILE?.$id) return "You";
  const staffMember = STAFF_CACHE.find((s) => s.$id === createdById);
  return staffMember ? staffMember.full_name : "Staff";
}

async function loadCbtTests() {
  const list = document.getElementById("cbt-list");
  try {
    const { documents } = await databases.listDocuments(POCKETBASE_CONFIG.databaseId, POCKETBASE_CONFIG.collections.cbtTests, [
      Query.orderDesc("$createdAt"),
      Query.limit(100),
    ]);
    CBT_TESTS_CACHE = documents;
  } catch (err) {
    console.error(err);
    list.innerHTML = `<p class="text-sm text-red-600">Couldn't load tests.</p>`;
    return;
  }

  if (CBT_TESTS_CACHE.length === 0) {
    list.innerHTML = `<p class="text-sm text-ink/40">No tests yet — build one on the left, or wait for staff to publish theirs.</p>`;
    return;
  }

  list.innerHTML = CBT_TESTS_CACHE.map((t) => {
    const qCount = (() => { try { return JSON.parse(t.questions).length; } catch { return 0; } })();
    return `
      <div class="border border-ink/10 rounded-xl p-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="font-display font-semibold">${escapeHtml(t.title)}</p>
            <p class="text-xs text-ink/50 mt-1">${escapeHtml(t.class_name)}${t.arm ? " (" + escapeHtml(t.arm) + ")" : ""} · ${escapeHtml(t.subject)} · ${escapeHtml(t.term)} · ${qCount} question${qCount === 1 ? "" : "s"} · ${t.duration_minutes} min · By ${escapeHtml(cbtCreatorLabel(t.created_by))}</p>
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

/* ---------- Boot ---------- */
(async function init() {
  const session = await requireSession("admin");
  if (!session) return;
  ADMIN_PROFILE = session.profile;
  initTabRouter("overview");
  await Promise.all([loadStats(), loadClasses(), loadStudents(), loadStaff(), loadMessages()]);

  // Live updates: if this admin has the console open in two tabs, or
  // another admin is editing at the same time, reflect changes to
  // classes/students/staff as soon as they happen rather than
  // requiring a manual refresh. Skips re-rendering the edit modal
  // itself so an in-progress edit isn't yanked out from under you.
  subscribeToCollection(POCKETBASE_CONFIG.collections.classes, () => {
    if (EDIT_CONTEXT?.type !== "class") loadClasses();
    loadStats();
  });
  subscribeToCollection(POCKETBASE_CONFIG.collections.students, () => {
    if (EDIT_CONTEXT?.type !== "student") loadStudents(document.getElementById("student-search").value);
    loadStats();
  });
  subscribeToCollection(POCKETBASE_CONFIG.collections.staff, () => {
    if (EDIT_CONTEXT?.type !== "staff") loadStaff(document.getElementById("staff-search")?.value || "");
    loadStats();
  });
  subscribeToCollection(POCKETBASE_CONFIG.collections.scores, () => {
    const scoresTabActive = !document.getElementById("tab-scores").classList.contains("hidden");
    if (scoresTabActive && EDIT_CONTEXT?.type !== "score") loadScores();
  });
  subscribeToCollection(POCKETBASE_CONFIG.collections.materials, () => {
    const libraryTabActive = !document.getElementById("tab-library").classList.contains("hidden");
    if (libraryTabActive) loadMaterials();
  });
})();
