const elements = {
  copy: document.querySelector("#access-copy"),
  form: document.querySelector("#access-form"),
  password: document.querySelector("#access-password"),
  error: document.querySelector("#access-error")
};

const nextUrl = new URLSearchParams(window.location.search).get("next") || "/";

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }
  return payload;
}

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = false;
}

function clearError() {
  elements.error.hidden = true;
  elements.error.textContent = "";
}

async function loadStatus() {
  try {
    const status = await api("/api/auth/status");
    if (status.authenticated) {
      window.location.replace(nextUrl);
      return;
    }

    if (!status.passwordConfigured) {
      elements.copy.textContent = "A password has not been configured on this machine yet, so protected pages and albums stay locked.";
      elements.form.hidden = true;
      return;
    }

    elements.copy.textContent = `Enter your configured password to continue to ${nextUrl}.`;
  } catch (error) {
    showError(error.message);
  }
}

elements.form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();

  try {
    await api("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        password: elements.password.value
      })
    });

    window.location.replace(nextUrl);
  } catch (error) {
    showError(error.message);
  }
});

loadStatus();
