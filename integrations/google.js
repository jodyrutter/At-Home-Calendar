// Google Calendar integration.
//
// OAuth:
//   - Auth endpoint:  https://accounts.google.com/o/oauth2/v2/auth
//   - Token endpoint: https://oauth2.googleapis.com/token
//   - Scopes used:
//       openid email profile
//       https://www.googleapis.com/auth/calendar.readonly
//   - access_type=offline + prompt=consent ensures we get a refresh_token
//     the first time the user connects (Google only returns one on the
//     very first consent for a given {user, client, scopes} tuple).
//
// Sync model:
//   - list calendars via /calendar/v3/users/me/calendarList
//   - for each calendar, list events via /calendar/v3/calendars/{id}/events
//     with singleEvents=true (expands recurrences into concrete instances)
//     and pagination via pageToken.
//   - On the *second* sync onward, pass the previously saved nextSyncToken
//     back as syncToken — Google then only returns changes + deletions.
//   - If Google 410-s (sync token expired), do a full resync for that
//     calendar.

import { buildFormBody } from "./oauth.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const CALENDAR_LIST_ENDPOINT = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const EVENTS_ENDPOINT_PREFIX = "https://www.googleapis.com/calendar/v3/calendars";

const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly"
];

export function isConfigured() {
  return (
    Boolean(String(process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim()) &&
    Boolean(String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim())
  );
}

export function buildAuthorizationUrl({ redirectUri, state, codeChallenge }) {
  const clientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
  if (!clientId) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID is not set.");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    // Force the consent screen the first time so we're guaranteed a
    // refresh_token. Google silently skips it on subsequent auths which
    // means no refresh_token is returned — without one we can't do
    // scheduled syncs after the ~1h access_token expires.
    prompt: "consent",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  });

  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

async function tokenRequest(body) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload.error_description || payload.error || response.statusText;
    throw new Error(`Google token exchange failed: ${error}`);
  }

  return payload;
}

export async function exchangeAuthorizationCode({ code, redirectUri, codeVerifier }) {
  const body = buildFormBody({
    code,
    client_id: String(process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim(),
    client_secret: String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim(),
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier
  });
  return tokenRequest(body);
}

export async function refreshAccessToken(refreshToken) {
  const body = buildFormBody({
    client_id: String(process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim(),
    client_secret: String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim(),
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });
  return tokenRequest(body);
}

export async function fetchUserInfo(accessToken) {
  const response = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    throw new Error(`Google userinfo failed: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  return {
    email: payload.email || "",
    displayName: payload.name || payload.email || "",
    picture: payload.picture || null
  };
}

async function googleGet(url, accessToken) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload.error?.message || response.statusText;
    const err = new Error(`Google API error: ${error}`);
    err.status = response.status;
    err.body = payload;
    throw err;
  }
  return payload;
}

export async function listCalendars(accessToken) {
  const out = [];
  let pageToken = "";
  do {
    const url = new URL(CALENDAR_LIST_ENDPOINT);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const payload = await googleGet(url.toString(), accessToken);
    if (Array.isArray(payload.items)) {
      for (const cal of payload.items) {
        out.push({
          id: cal.id,
          summary: cal.summary || cal.summaryOverride || cal.id,
          timeZone: cal.timeZone || null,
          primary: Boolean(cal.primary),
          accessRole: cal.accessRole || null,
          colorId: cal.colorId || null,
          backgroundColor: cal.backgroundColor || null
        });
      }
    }
    pageToken = payload.nextPageToken || "";
  } while (pageToken);
  return out;
}

// Returns { events: [...], nextSyncToken: string }
// If previousSyncToken is provided and still valid, Google returns only
// changed + deleted events. If Google 410-s, we fall back to a full sync
// automatically.
export async function listEvents(accessToken, calendarId, { previousSyncToken = "", windowMonths = 13 } = {}) {
  const events = [];
  let pageToken = "";
  let nextSyncToken = previousSyncToken;
  let useSyncToken = Boolean(previousSyncToken);

  // Time window for initial/full syncs. We pull events from ~1 month in the
  // past through ~12 months in the future so the calendar view looks full
  // right away without dragging in the user's entire 10-year history.
  const now = new Date();
  const timeMin = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const timeMaxDate = new Date(now);
  timeMaxDate.setMonth(timeMaxDate.getMonth() + (windowMonths - 1));
  const timeMax = timeMaxDate.toISOString();

  do {
    const url = new URL(`${EVENTS_ENDPOINT_PREFIX}/${encodeURIComponent(calendarId)}/events`);

    if (useSyncToken) {
      url.searchParams.set("syncToken", previousSyncToken);
    } else {
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("timeMin", timeMin);
      url.searchParams.set("timeMax", timeMax);
    }
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    url.searchParams.set("maxResults", "250");

    let payload;
    try {
      payload = await googleGet(url.toString(), accessToken);
    } catch (err) {
      if (err.status === 410 && useSyncToken) {
        // Sync token is stale (Google ages them out). Retry as a full sync.
        useSyncToken = false;
        pageToken = "";
        nextSyncToken = "";
        continue;
      }
      throw err;
    }

    if (Array.isArray(payload.items)) {
      for (const item of payload.items) {
        events.push(item);
      }
    }

    if (payload.nextPageToken) {
      pageToken = payload.nextPageToken;
    } else {
      pageToken = "";
      nextSyncToken = payload.nextSyncToken || nextSyncToken;
    }
  } while (pageToken);

  return { events, nextSyncToken };
}

// Translate a Google Calendar event object into Hearthboard's event shape.
// Returns null if the event should be skipped (cancelled status, missing
// timestamps, etc.).
export function mapGoogleEventToHearthboard(raw, { integration, calendar, ownerMemberId }) {
  if (!raw || raw.status === "cancelled") {
    return { deleted: true, sourceEventId: raw?.id || "" };
  }

  const isAllDay = Boolean(raw.start?.date && !raw.start?.dateTime);
  let start = null;
  let end = null;

  if (isAllDay) {
    // All-day events give "YYYY-MM-DD" — interpret as local midnight so the
    // event shows up on the correct day regardless of viewer timezone.
    start = new Date(`${raw.start.date}T00:00:00`);
    end = new Date(`${raw.end.date}T00:00:00`);
  } else {
    start = raw.start?.dateTime ? new Date(raw.start.dateTime) : null;
    end = raw.end?.dateTime ? new Date(raw.end.dateTime) : null;
  }

  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  const title = String(raw.summary || "(untitled event)").trim().slice(0, 200);
  const description = String(raw.description || "").trim().slice(0, 2000);
  const location = String(raw.location || "").trim().slice(0, 240);

  return {
    title,
    description,
    location,
    category: String(calendar?.summary || "Google Calendar").slice(0, 80),
    allDay: isAllDay,
    start: start.toISOString(),
    end: end.toISOString(),
    memberIds: ownerMemberId ? [ownerMemberId] : [],
    source: {
      provider: "google",
      integrationId: integration.id,
      calendarId: calendar.id,
      calendarSummary: calendar.summary || null,
      eventId: String(raw.id || ""),
      etag: String(raw.etag || ""),
      htmlLink: String(raw.htmlLink || ""),
      syncedAt: new Date().toISOString()
    }
  };
}
