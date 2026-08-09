/* ============================================================
   admin-auth.html — admin sign-in (real email + password)
   The admin account is created once via scripts/setup-pocketbase.js
   or the PocketBase Admin UI — "admins" is itself a PocketBase auth
   collection, so there's no separate profile-linking step needed.
   ============================================================ */

(function () {
  const form = document.getElementById("admin-login-form");
  const errorEl = document.getElementById("form-error");
  const submitBtn = document.getElementById("submit-btn");

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove("hidden");
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.classList.add("hidden");

    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;

    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in...";

    pb.authStore.clear();

    try {
      await pb.collection(POCKETBASE_CONFIG.collections.admins).authWithPassword(email, password);
    } catch (err) {
      showError("Incorrect email or password.");
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign in";
      return;
    }

    window.location.href = "admin.html";
  });
})();
