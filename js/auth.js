/* ============================================================
   auth.html — student & staff sign-in (full name + school ID)
   No email, no password field shown — the school ID doubles as the
   password behind the scenes (see the setup guide's security note).

   In the PocketBase version, "students" and "staff" are themselves
   PocketBase auth collections (not separate profile documents
   linked to a shared Users table the way Appwrite needed), so
   signing in is a single authWithPassword() call against the right
   collection, and the record that comes back already IS the full
   profile — no follow-up lookup needed.
   ============================================================ */

(function () {
  const tabStudent = document.getElementById("tab-student");
  const tabStaff = document.getElementById("tab-staff");
  const subtitle = document.getElementById("subtitle");
  const form = document.getElementById("login-form");
  const errorEl = document.getElementById("form-error");
  const submitBtn = document.getElementById("submit-btn");

  let role = "student";

  function setRole(newRole) {
    role = newRole;
    tabStudent.classList.toggle("active", role === "student");
    tabStudent.setAttribute("aria-selected", role === "student" ? "true" : "false");
    tabStaff.classList.toggle("active", role === "staff");
    tabStaff.setAttribute("aria-selected", role === "staff" ? "true" : "false");
    subtitle.textContent = role === "student" ? "Sign in to view your dashboard." : "Sign in to your staff dashboard.";
    errorEl.classList.add("hidden");
  }

  tabStudent.addEventListener("click", () => setRole("student"));
  tabStaff.addEventListener("click", () => setRole("staff"));

  // Respect ?as=student / ?as=staff coming from index.html's buttons.
  const params = new URLSearchParams(window.location.search);
  setRole(params.get("as") === "staff" ? "staff" : "student");

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove("hidden");
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.classList.add("hidden");

    const fullName = document.getElementById("fullName").value.trim();
    const schoolId = document.getElementById("schoolId").value.trim().toUpperCase();
    if (!fullName || !schoolId) return;

    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in...";

    const email = idToEmail(schoolId, role);
    const collectionId = role === "student" ? POCKETBASE_CONFIG.collections.students : POCKETBASE_CONFIG.collections.staff;

    pb.authStore.clear(); // clear any stale session before signing in

    let authData;
    try {
      authData = await pb.collection(collectionId).authWithPassword(email, schoolId);
    } catch (err) {
      showError("Name or ID not recognized. Double-check your ID card.");
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign in";
      return;
    }

    // Extra guard, mirroring the original design: the ID alone is
    // enough to authenticate, so also check the typed name matches
    // the name on file.
    if ((authData.record.full_name || "").trim().toLowerCase() !== fullName.toLowerCase()) {
      pb.authStore.clear();
      showError("That name doesn't match the ID entered.");
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign in";
      return;
    }

    window.location.href = role === "student" ? "student.html" : "staff.html";
  });
})();
