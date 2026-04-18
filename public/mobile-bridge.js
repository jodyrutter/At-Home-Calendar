const isEmbeddedMobileApp = (() => {
  const params = new URLSearchParams(window.location.search);
  return window.self !== window.top || params.get("mobileApp") === "1";
})();

const MOBILE_APP_HEADER = "X-Hearthboard-Mobile-App";

if (isEmbeddedMobileApp) {
  document.documentElement.dataset.mobileApp = "true";
  document.body?.setAttribute("data-mobile-app", "true");

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const requestUrl = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    if (requestUrl.origin !== window.location.origin) {
      return nativeFetch(input, init);
    }

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers || {}).forEach((value, key) => {
      headers.set(key, value);
    });
    headers.set(MOBILE_APP_HEADER, "1");

    const nextInit = {
      ...init,
      credentials: init.credentials || (input instanceof Request ? input.credentials : "include") || "include",
      headers
    };

    if (input instanceof Request) {
      return nativeFetch(new Request(input, nextInit));
    }

    return nativeFetch(input, nextInit);
  };
}

async function api(path) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${path}`);
  }

  return response.json();
}

function postToParent(type, payload) {
  if (!isEmbeddedMobileApp || window.parent === window) {
    return;
  }

  window.parent.postMessage(
    {
      source: "hearthboard-mobile",
      type,
      payload
    },
    "*"
  );
}

let syncing = false;

async function syncMobileBridge() {
  if (!isEmbeddedMobileApp || syncing) {
    return;
  }

  syncing = true;
  try {
    const session = await api("/api/session");
    postToParent("session", {
      ...session,
      path: window.location.pathname,
      title: document.title,
      baseUrl: window.location.origin
    });

    if (session.authenticated) {
      const reminderPayload = await api("/api/mobile/reminders");
      postToParent("reminders", reminderPayload);
    } else {
      postToParent("reminders", {
        generatedAt: new Date().toISOString(),
        user: null,
        reminders: []
      });
    }
  } catch (error) {
    postToParent("sync-error", {
      message: error.message
    });
  } finally {
    syncing = false;
  }
}

window.addEventListener("message", (event) => {
  if (event.data?.source !== "hearthboard-mobile-app") {
    return;
  }

  if (event.data?.type === "hearthboard-mobile-sync") {
    syncMobileBridge();
  }
});

window.addEventListener("focus", syncMobileBridge);
window.addEventListener("pageshow", syncMobileBridge);
window.addEventListener("hearthboard:mobile-sync", syncMobileBridge);

queueMicrotask(syncMobileBridge);
