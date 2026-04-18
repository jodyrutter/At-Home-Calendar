const isEmbeddedMobileApp = (() => {
  const params = new URLSearchParams(window.location.search);
  return window.self !== window.top || params.get("mobileApp") === "1";
})();

const MOBILE_APP_HEADER = "X-Hearthboard-Mobile-App";
const SCHEDULED_REMINDER_KEY = "hearthboard-mobile-reminders";
const directNativeCapacitorApp = Boolean(window.Capacitor?.isNativePlatform?.()) && window.parent === window;

function capacitorPlugin(name) {
  return window.Capacitor?.Plugins?.[name] || null;
}

function reminderNumericId(reminderId) {
  let hash = 0;
  for (const character of String(reminderId)) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }

  return Math.abs(hash) + 1;
}

async function syncNativeNotifications(payload) {
  if (!directNativeCapacitorApp) {
    return;
  }

  const LocalNotifications = capacitorPlugin("LocalNotifications");
  const Preferences = capacitorPlugin("Preferences");
  if (!LocalNotifications || !Preferences) {
    return;
  }

  const reminders = Array.isArray(payload?.reminders) ? payload.reminders : [];
  const permission = await LocalNotifications.requestPermissions();
  if (permission.display !== "granted") {
    return;
  }

  const now = Date.now();
  const upcoming = reminders
    .filter((reminder) => new Date(reminder.scheduleAt).getTime() > now)
    .slice(0, 64);
  const nextIds = upcoming.map((reminder) => reminderNumericId(reminder.reminderId));
  const previousValue = (await Preferences.get({ key: SCHEDULED_REMINDER_KEY })).value;
  const previousIds = previousValue ? JSON.parse(previousValue) : [];
  const managedIds = [...new Set([...previousIds, ...nextIds])];

  if (managedIds.length > 0) {
    await LocalNotifications.cancel({
      notifications: managedIds.map((id) => ({ id }))
    });
  }

  if (upcoming.length > 0) {
    await LocalNotifications.schedule({
      notifications: upcoming.map((reminder) => ({
        id: reminderNumericId(reminder.reminderId),
        title: reminder.title,
        body: reminder.body,
        schedule: {
          at: new Date(reminder.scheduleAt),
          allowWhileIdle: true
        },
        extra: {
          eventId: reminder.eventId,
          eventUrl: reminder.eventUrl,
          baseUrl: window.location.origin
        }
      }))
    });
  }

  await Preferences.set({
    key: SCHEDULED_REMINDER_KEY,
    value: JSON.stringify(nextIds)
  });
}

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
      await syncNativeNotifications(reminderPayload);
    } else {
      const emptyReminderPayload = {
        generatedAt: new Date().toISOString(),
        user: null,
        reminders: []
      };
      postToParent("reminders", emptyReminderPayload);
      await syncNativeNotifications(emptyReminderPayload);
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

if (directNativeCapacitorApp) {
  capacitorPlugin("App")?.addListener?.("appStateChange", ({ isActive }) => {
    if (isActive) {
      syncMobileBridge();
    }
  });

  capacitorPlugin("LocalNotifications")?.addListener?.("localNotificationActionPerformed", (event) => {
    const eventUrl = String(event.notification?.extra?.eventUrl || "/");
    const url = new URL(eventUrl || "/", window.location.origin);
    url.searchParams.set("mobileApp", "1");
    window.location.assign(url.toString());
  });
}

queueMicrotask(syncMobileBridge);
