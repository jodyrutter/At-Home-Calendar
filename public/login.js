const searchParams = new URLSearchParams(window.location.search);
const isEmbeddedMobileApp = window.self !== window.top || searchParams.get("mobileApp") === "1";

function normalizeInternalPath(pathname) {
  try {
    const url = new URL(pathname || "/account", window.location.origin);
    if (url.origin !== window.location.origin) {
      return "/account";
    }
    if (!/^\/(?!\/)/.test(url.pathname || "/")) {
      return "/account";
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/account";
  }
}

function pathWithMobileApp(pathname) {
  const url = new URL(normalizeInternalPath(pathname || "/account"), window.location.origin);
  if (isEmbeddedMobileApp) {
    url.searchParams.set("mobileApp", "1");
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

const nextUrl = pathWithMobileApp(normalizeInternalPath(searchParams.get("next") || "/account"));

const elements = {
  copy: document.querySelector("#login-copy"),
  loginForm: document.querySelector("#login-form"),
  loginError: document.querySelector("#login-error"),
  loginUsername: document.querySelector("#login-username"),
  loginPassword: document.querySelector("#login-password"),
  loginRemember: document.querySelector("#login-remember"),
  registerPanel: document.querySelector("#register-panel"),
  registerCopy: document.querySelector("#register-copy"),
  registerForm: document.querySelector("#register-form"),
  registerError: document.querySelector("#register-error"),
  registerUsername: document.querySelector("#register-username"),
  registerPassword: document.querySelector("#register-password"),
  registerRemember: document.querySelector("#register-remember")
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }
  return payload;
}

function showError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function clearError(element) {
  element.hidden = true;
  element.textContent = "";
}

async function loadSession() {
  const session = await api("/api/session");
  if (session.authenticated) {
    window.location.replace(nextUrl);
    return;
  }

  elements.copy.textContent = `Sign in to continue to ${nextUrl}.`;
  if (!session.canSelfRegister) {
    elements.registerPanel.hidden = true;
    if (elements.registerCopy) {
      elements.registerCopy.textContent = "New accounts can only be created from your local network.";
    }
  } else {
    elements.registerPanel.hidden = false;
  }
}

elements.loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError(elements.loginError);

  try {
    await api("/api/session/login", {
      method: "POST",
      body: JSON.stringify({
        username: elements.loginUsername.value,
        password: elements.loginPassword.value,
        rememberMe: elements.loginRemember.checked
      })
    });

    window.location.replace(nextUrl);
  } catch (error) {
    showError(elements.loginError, error.message);
  }
});

elements.registerForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError(elements.registerError);

  try {
    await api("/api/session/register", {
      method: "POST",
      body: JSON.stringify({
        username: elements.registerUsername.value,
        password: elements.registerPassword.value,
        rememberMe: elements.registerRemember.checked
      })
    });

    window.location.replace(pathWithMobileApp("/account"));
  } catch (error) {
    showError(elements.registerError, error.message);
  }
});

loadSession().catch((error) => {
  showError(elements.loginError, error.message);
});
