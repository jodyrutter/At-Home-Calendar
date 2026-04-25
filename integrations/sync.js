// Sync orchestrator + scheduler for calendar integrations.
//
// Runs per-integration syncs in sequence (one at a time — no parallelism
// needed for a household-scale deployment, and it keeps the Postgres
// write pattern simple). The top-level scheduler fires twice a day at
// 00:00 and 12:00 in the configured APP_TIMEZONE, plus once on boot
// after a short delay to catch up from any downtime.
//
// Edit semantics: the user chose "editable, overwritten on sync." That
// means each sync fully overwrites every field on every imported event
// from the upstream source. If a family member hand-edited "Dentist" to
// "Dentist (reschedule?)" locally, the next sync wipes that change.
// We surface that trade-off in the edit UI with a small note.

import { nanoid } from "nanoid";
import { decryptSecret, encryptSecret, tryDecryptSecret } from "./crypto.js";
import * as googleClient from "./google.js";
import * as microsoftClient from "./microsoft.js";

// How long before an access_token actually expires do we refuse to trust
// it and force a refresh. 60s buffer absorbs clock skew.
const TOKEN_EXPIRY_SAFETY_MS = 60 * 1000;

function providerClient(provider) {
  if (provider === "google") return googleClient;
  if (provider === "microsoft") return microsoftClient;
  throw new Error(`Unknown provider: ${provider}`);
}

function findIntegrationById(db, integrationId) {
  if (!Array.isArray(db.data.integrations)) return null;
  return db.data.integrations.find((entry) => entry.id === integrationId) || null;
}

function memberIdForUser(db, userId) {
  // We tag imported events with the household-member color tied to the
  // user who linked the account. If the user isn't mapped to a member
  // (e.g. admin-only account), we leave memberIds empty and the event
  // still shows on the shared calendar without a personal tag.
  if (!userId || !Array.isArray(db.data.members)) return null;
  const member = db.data.members.find(
    (m) => String(m.userId || "") === String(userId)
  );
  return member?.id || null;
}

async function ensureFreshAccessToken(integration) {
  const expiresAt = Number(integration.tokens?.accessTokenExpiresAt || 0);
  if (expiresAt && expiresAt - Date.now() > TOKEN_EXPIRY_SAFETY_MS) {
    const current = tryDecryptSecret(integration.tokens?.accessTokenEncrypted);
    if (current) {
      return { accessToken: current, refreshed: false };
    }
  }

  const refreshTokenEncrypted = integration.tokens?.refreshTokenEncrypted;
  if (!refreshTokenEncrypted) {
    throw new Error("This integration has no refresh token on file — reconnect the account.");
  }
  const refreshToken = decryptSecret(refreshTokenEncrypted);
  const client = providerClient(integration.provider);
  const resp = await client.refreshAccessToken(refreshToken);

  const accessToken = String(resp.access_token || "").trim();
  if (!accessToken) {
    throw new Error("Provider did not return a new access_token on refresh.");
  }

  // Microsoft rotates refresh tokens — if a new one comes back, swap it.
  // Google usually keeps the same refresh token, but if they ever do
  // rotate we handle it transparently.
  const newRefreshToken = String(resp.refresh_token || "").trim();

  const expiresInSec = Number(resp.expires_in || 3600);
  integration.tokens.accessTokenEncrypted = encryptSecret(accessToken);
  integration.tokens.accessTokenExpiresAt = Date.now() + expiresInSec * 1000;
  if (newRefreshToken) {
    integration.tokens.refreshTokenEncrypted = encryptSecret(newRefreshToken);
  }
  integration.updatedAt = new Date().toISOString();

  return { accessToken, refreshed: true };
}

function findExistingEventIndex(db, provider, integrationId, sourceEventId) {
  return db.data.events.findIndex(
    (event) =>
      event?.source?.provider === provider &&
      String(event?.source?.integrationId || "") === String(integrationId) &&
      String(event?.source?.eventId || "") === String(sourceEventId)
  );
}

function dropEventsFromDeletedCalendar(db, integration, retainedCalendarIds) {
  // When a user deletes a calendar upstream, we want to clean up the
  // events we imported from it. "retainedCalendarIds" is the set of
  // calendarIds returned by the most recent listCalendars() call.
  const keep = new Set(retainedCalendarIds.map(String));
  db.data.events = db.data.events.filter((event) => {
    if (event?.source?.provider !== integration.provider) return true;
    if (String(event?.source?.integrationId || "") !== String(integration.id)) return true;
    const calId = String(event?.source?.calendarId || "");
    return !calId || keep.has(calId);
  });
}

function upsertImportedEvent(db, mapped, { createdDefaults }) {
  const index = findExistingEventIndex(
    db,
    mapped.source.provider,
    mapped.source.integrationId,
    mapped.source.eventId
  );

  if (index >= 0) {
    const existing = db.data.events[index];
    db.data.events[index] = {
      ...existing,
      title: mapped.title,
      description: mapped.description,
      location: mapped.location,
      category: mapped.category,
      allDay: mapped.allDay,
      start: mapped.start,
      end: mapped.end,
      memberIds: mapped.memberIds,
      source: mapped.source,
      updatedAt: new Date().toISOString()
    };
    return { operation: "update" };
  }

  db.data.events.push({
    id: nanoid(),
    title: mapped.title,
    description: mapped.description,
    location: mapped.location,
    category: mapped.category,
    allDay: mapped.allDay,
    start: mapped.start,
    end: mapped.end,
    memberIds: mapped.memberIds,
    notifications: createdDefaults.notifications,
    createdAt: createdDefaults.timestamp,
    updatedAt: createdDefaults.timestamp,
    source: mapped.source
  });
  return { operation: "insert" };
}

function deleteImportedEvent(db, provider, integrationId, sourceEventId) {
  const index = findExistingEventIndex(db, provider, integrationId, sourceEventId);
  if (index >= 0) {
    db.data.events.splice(index, 1);
    return true;
  }
  return false;
}

function defaultImportedEventNotifications() {
  // Don't nag people about imported events by default. They can toggle
  // notifications on via the edit form if they want — same as local events.
  return {
    enabled: false,
    targetUserIds: [],
    offsets: [],
    customMessage: "",
    deliveredAt: {},
    draftedReminders: {}
  };
}

export async function syncIntegration(db, integration, options = {}) {
  const { onProgress = () => {} } = options;
  const provider = integration.provider;
  const client = providerClient(provider);

  onProgress({ phase: "refreshing-token" });
  const { accessToken } = await ensureFreshAccessToken(integration);

  onProgress({ phase: "listing-calendars" });
  const calendars = await client.listCalendars(accessToken);
  integration.calendars = calendars.map((cal) => ({
    id: cal.id,
    summary: cal.summary,
    primary: Boolean(cal.primary)
  }));

  // Ensure per-calendar sync cursor state exists.
  integration.syncCursors = integration.syncCursors || {};

  let totalUpserted = 0;
  let totalDeleted = 0;

  const createdDefaults = {
    notifications: defaultImportedEventNotifications(),
    timestamp: new Date().toISOString()
  };

  for (const calendar of calendars) {
    onProgress({ phase: "syncing-calendar", calendar: calendar.summary });
    try {
      if (provider === "google") {
        const previousSyncToken = String(integration.syncCursors[calendar.id] || "");
        const { events, nextSyncToken } = await client.listEvents(accessToken, calendar.id, {
          previousSyncToken
        });
        for (const raw of events) {
          const mapped = client.mapGoogleEventToHearthboard(raw, {
            integration,
            calendar,
            ownerMemberId: memberIdForUser(db, integration.userId)
          });
          if (!mapped) continue;
          if (mapped.deleted) {
            if (deleteImportedEvent(db, provider, integration.id, mapped.sourceEventId)) {
              totalDeleted += 1;
            }
            continue;
          }
          const { operation } = upsertImportedEvent(db, mapped, { createdDefaults });
          if (operation === "insert" || operation === "update") totalUpserted += 1;
        }
        if (nextSyncToken) integration.syncCursors[calendar.id] = nextSyncToken;
      } else if (provider === "microsoft") {
        const previousDeltaLink = String(integration.syncCursors[calendar.id] || "");
        const { events, nextDeltaLink } = await client.listEvents(accessToken, calendar.id, {
          previousDeltaLink
        });
        for (const raw of events) {
          const mapped = client.mapMicrosoftEventToHearthboard(raw, {
            integration,
            calendar,
            ownerMemberId: memberIdForUser(db, integration.userId)
          });
          if (!mapped) continue;
          if (mapped.deleted) {
            if (deleteImportedEvent(db, provider, integration.id, mapped.sourceEventId)) {
              totalDeleted += 1;
            }
            continue;
          }
          const { operation } = upsertImportedEvent(db, mapped, { createdDefaults });
          if (operation === "insert" || operation === "update") totalUpserted += 1;
        }
        if (nextDeltaLink) integration.syncCursors[calendar.id] = nextDeltaLink;
      }
    } catch (err) {
      // One flaky calendar shouldn't abort the whole integration sync.
      // Capture the error onto the integration so the UI can surface it.
      integration.lastCalendarErrors = integration.lastCalendarErrors || {};
      integration.lastCalendarErrors[calendar.id] = {
        message: String(err?.message || err),
        at: new Date().toISOString()
      };
    }
  }

  dropEventsFromDeletedCalendar(
    db,
    integration,
    calendars.map((c) => c.id)
  );

  integration.lastSyncAt = new Date().toISOString();
  integration.lastSyncError = null;
  integration.lastSyncSummary = { upserted: totalUpserted, deleted: totalDeleted };
  integration.updatedAt = new Date().toISOString();

  return { upserted: totalUpserted, deleted: totalDeleted };
}

export async function syncAllIntegrations(db, { log = () => {} } = {}) {
  if (!Array.isArray(db.data.integrations)) db.data.integrations = [];
  const integrations = db.data.integrations.slice();

  let anyChanges = false;
  for (const ref of integrations) {
    // Find the live record — syncIntegration mutates it in place, but we
    // want to look up the live one in case concurrent requests reshuffled.
    const integration = findIntegrationById(db, ref.id);
    if (!integration) continue;
    if (integration.disabled) continue;

    log(`[sync] ${integration.provider}:${integration.accountEmail || integration.id}`);
    try {
      await syncIntegration(db, integration);
      anyChanges = true;
    } catch (err) {
      integration.lastSyncError = {
        message: String(err?.message || err),
        at: new Date().toISOString()
      };
      integration.updatedAt = new Date().toISOString();
      anyChanges = true;
      log(`[sync] ${integration.provider} failed: ${err?.message || err}`);
    }
  }

  if (anyChanges) {
    await db.write();
  }
}

// Fires syncAllIntegrations() at 00:00 and 12:00 in the given timezone,
// plus once shortly after boot. Uses a recomputed setTimeout per run
// (rather than setInterval) so DST transitions don't drift us.
export function startIntegrationScheduler(db, { timezone, log = () => {} }) {
  let timer = null;
  let stopped = false;

  function scheduleNext() {
    if (stopped) return;
    const delayMs = millisUntilNextSyncWindow(new Date(), timezone);
    timer = setTimeout(async () => {
      try {
        await syncAllIntegrations(db, { log });
      } catch (err) {
        log(`[sync] scheduler run failed: ${err?.message || err}`);
      } finally {
        scheduleNext();
      }
    }, delayMs);
    // Don't hold the Node event loop open just for scheduling.
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  // Kick off an initial catch-up sync 60s after boot, then hand control
  // to the twice-daily cadence.
  const bootTimer = setTimeout(async () => {
    if (stopped) return;
    try {
      await syncAllIntegrations(db, { log });
    } catch (err) {
      log(`[sync] boot-catchup failed: ${err?.message || err}`);
    } finally {
      scheduleNext();
    }
  }, 60 * 1000);
  if (bootTimer && typeof bootTimer.unref === "function") bootTimer.unref();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (bootTimer) clearTimeout(bootTimer);
  };
}

// Compute the delay until the next 00:00 or 12:00 in the given timezone.
// We use Intl.DateTimeFormat to avoid depending on a full tz library —
// the math is just "what time is it locally, how many ms until the
// next 00:00 or 12:00 boundary."
function millisUntilNextSyncWindow(now, timezone) {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    const parts = formatter.formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value || "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value || "0");
    const second = Number(parts.find((p) => p.type === "second")?.value || "0");

    const msSinceMidnight = ((hour * 60 + minute) * 60 + second) * 1000;
    const NOON = 12 * 60 * 60 * 1000;
    const DAY = 24 * 60 * 60 * 1000;

    let delay;
    if (msSinceMidnight < NOON) {
      delay = NOON - msSinceMidnight;
    } else {
      delay = DAY - msSinceMidnight;
    }

    // Safety floor of 60s so a weird clock skew can't produce a negative
    // or zero delay that would hot-loop.
    return Math.max(delay, 60 * 1000);
  } catch {
    // If the timezone string is bogus we fall back to plain UTC cadence.
    return 12 * 60 * 60 * 1000;
  }
}
