import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Preferences } from "@capacitor/preferences";

const BASE_URL_KEY = "hearthboard-mobile-base-url";
const SCHEDULED_REMINDER_KEY = "hearthboard-mobile-reminders";
const REMINDER_SYNC_INTERVAL_MS = 2 * 60 * 1000;
const CANDIDATE_BASE_URLS = [
  "https://192.168.1.118:42069",
  "https://jodyrutter-sh.duckdns.org"
];

const state = {
  baseUrl: "",
  syncing: false,
  lastReminderPayload: null
};

const elements = {
  frame: document.querySelector("#hearthboard-frame"),
  retryConnection: document.querySelector("#retry-connection"),
  retryFallback: document.querySelector("#retry-fallback"),
  fallbackPanel: document.querySelector("#fallback-panel"),
  connectionPill: document.querySelector("#connection-pill"),
  connectionTitle: document.querySelector("#connection-title"),
  connectionDescription: document.querySelector("#connection-description"),
  connectionRoute: document.querySelector("#connection-route"),
  notificationStatus: document.querySelector("#notification-status")
};

function setConnectionState(kind, title, description) {
  elements.connectionPill.className = `connection-pill ${kind}`;
  elements.connectionPill.textContent = kind === "local" ? "Local" : kind === "remote" ? "Remote" : kind === "ready" ? "Ready" : kind === "error" ? "Offline" : "Detecting";
  elements.connectionTitle.textContent = title;
  elements.connectionDescription.textContent = description;
}

function baseUrlLabel(baseUrl) {
  if (!baseUrl) {
    return "Not set";
  }

  return baseUrl.includes("192.168.") ? "Local HTTPS" : "DuckDNS HTTPS";
}

async function canReach(baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`${baseUrl}/api/health?ts=${Date.now()}`, {
      method: "GET",
      mode: "cors",
      cache: "no-store",
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function detectBaseUrl() {
  const saved = (await Preferences.get({ key: BASE_URL_KEY })).value;
  const candidates = [...new Set([saved, ...CANDIDATE_BASE_URLS].filter(Boolean))];

  for (const candidate of candidates) {
    if (await canReach(candidate)) {
      await Preferences.set({ key: BASE_URL_KEY, value: candidate });
      return candidate;
    }
  }

  return "";
}

function buildMobileUrl(baseUrl) {
  const url = new URL("/", baseUrl);
  url.searchParams.set("mobileApp", "1");
  return url.toString();
}

function buildMobileEventUrl(baseUrl, eventUrl = "/") {
  const url = new URL(eventUrl || "/", baseUrl);
  url.searchParams.set("mobileApp", "1");
  return url.toString();
}

function reminderNumericId(reminderId) {
  let hash = 0;
  for (const character of String(reminderId)) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }

  return Math.abs(hash) + 1;
}

async function syncNotifications(payload) {
  state.lastReminderPayload = payload;
  const reminders = Array.isArray(payload?.reminders) ? payload.reminders : [];

  if (!Capacitor.isNativePlatform()) {
    elements.notificationStatus.textContent = reminders.length ? `${reminders.length} queued for native build` : "Needs Android build";
    return;
  }

  const permission = await LocalNotifications.requestPermissions();
  if (permission.display !== "granted") {
    elements.notificationStatus.textContent = "Permission blocked";
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
          baseUrl: state.baseUrl
        }
      }))
    });
  }

  await Preferences.set({
    key: SCHEDULED_REMINDER_KEY,
    value: JSON.stringify(nextIds)
  });

  elements.notificationStatus.textContent = upcoming.length ? `${upcoming.length} scheduled` : "No upcoming reminders";
}

async function requestReminderSync() {
  if (!elements.frame.contentWindow) {
    return;
  }

  elements.frame.contentWindow.postMessage(
    {
      source: "hearthboard-mobile-app",
      type: "hearthboard-mobile-sync"
    },
    "*"
  );
}

async function connectFrame() {
  if (state.syncing) {
    return;
  }

  state.syncing = true;
  setConnectionState("waiting", "Looking for your board", "Checking local HTTPS first, then your DuckDNS address.");
  elements.connectionRoute.textContent = "Scanning";
  elements.notificationStatus.textContent = "Waiting";
  elements.fallbackPanel.hidden = true;

  const baseUrl = await detectBaseUrl();
  state.baseUrl = baseUrl;

  if (!baseUrl) {
    setConnectionState("error", "Hearthboard is not reachable", "I could not reach either your LAN HTTPS address or the DuckDNS address.");
    elements.connectionRoute.textContent = "Unavailable";
    elements.notificationStatus.textContent = "Offline";
    elements.fallbackPanel.hidden = false;
    state.syncing = false;
    return;
  }

  const isLocal = baseUrl.includes("192.168.");
  setConnectionState(isLocal ? "local" : "remote", isLocal ? "Connected on your home network" : "Connected through DuckDNS", `Using ${baseUrl} inside the app shell.`);
  elements.connectionRoute.textContent = baseUrlLabel(baseUrl);
  elements.notificationStatus.textContent = "Syncing";
  elements.frame.src = buildMobileUrl(baseUrl);
  state.syncing = false;
}

function openEventInFrame(eventUrl = "/") {
  if (!state.baseUrl) {
    return;
  }

  elements.frame.src = buildMobileEventUrl(state.baseUrl, eventUrl);
}

window.addEventListener("message", async (event) => {
  if (event.source !== elements.frame.contentWindow) {
    return;
  }

  if (event.data?.source !== "hearthboard-mobile") {
    return;
  }

  if (event.data.type === "session") {
    const session = event.data.payload || {};
    elements.notificationStatus.textContent = session.authenticated ? "Waiting for reminder sync" : "Sign in to sync";
    if (session.baseUrl) {
      state.baseUrl = session.baseUrl;
      setConnectionState(session.baseUrl.includes("192.168.") ? "local" : "remote", session.authenticated ? "Hearthboard is ready on mobile" : "Sign in to continue", session.authenticated ? "The app shell is connected and can mirror upcoming reminders." : "Once you sign in, this app will schedule your upcoming reminders.");
      elements.connectionRoute.textContent = baseUrlLabel(session.baseUrl);
    }
  }

  if (event.data.type === "reminders") {
    await syncNotifications(event.data.payload || { reminders: [] });
  }

  if (event.data.type === "sync-error") {
    elements.notificationStatus.textContent = "Sync problem";
  }
});

elements.retryConnection.addEventListener("click", connectFrame);
elements.retryFallback.addEventListener("click", connectFrame);
elements.frame.addEventListener("load", () => {
  requestReminderSync();
});

setInterval(requestReminderSync, REMINDER_SYNC_INTERVAL_MS);

App.addListener("appStateChange", ({ isActive }) => {
  if (isActive) {
    connectFrame();
    requestReminderSync();
  }
});

if (Capacitor.isNativePlatform()) {
  LocalNotifications.addListener("localNotificationActionPerformed", async (event) => {
    const eventUrl = String(event.notification?.extra?.eventUrl || "/");
    if (!state.baseUrl) {
      await connectFrame();
    }
    openEventInFrame(eventUrl);
  });
}

connectFrame();
