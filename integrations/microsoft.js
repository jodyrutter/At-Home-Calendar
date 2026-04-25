// Microsoft Graph calendar integration (Outlook / Microsoft 365 / Live.com).
//
// OAuth:
//   - Auth endpoint:  https://login.microsoftonline.com/common/oauth2/v2.0/authorize
//   - Token endpoint: https://login.microsoftonline.com/common/oauth2/v2.0/token
//   - Scopes used:
//       openid profile email offline_access
//       Calendars.Read
//   - offline_access is required to get back a refresh_token.
//   - We use the /common tenant so both personal (@outlook.com, @hotmail.com,
//     @live.com) and work/school accounts can sign in.
//
// Sync model:
//   - List calendars via GET /me/calendars
//   - For each calendar, use the calendarView/delta endpoint. First call
//     has no $deltatoken; returns events + a @odata.deltaLink with a token.
//     Subsequent calls append ?$deltatoken=XYZ and return only changes /
//     deletions since that token.
//   - calendarView is inherently "expanded" (concrete instances of
//     recurring events), matching how Hearthboard renders things.

import { buildFormBody } from "./oauth.js";

const AUTH_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_ME = "https://graph.microsoft.com/v1.0/me";
const GRAPH_CALENDARS = "https://graph.microsoft.com/v1.0/me/calendars";

const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "https://graph.microsoft.com/Calendars.Read"
];

export function isConfigured() {
  return (
    Boolean(String(process.env.MICROSOFT_OAUTH_CLIENT_ID || "").trim()) &&
    Boolean(String(process.env.MICROSOFT_OAUTH_CLIENT_SECRET || "").trim())
  );
}

export function buildAuthorizationUrl({ redirectUri, state, codeChallenge }) {
  const clientId = String(process.env.MICROSOFT_OAUTH_CLIENT_ID || "").trim();
  if (!clientId) {
    throw new Error("MICROSOFT_OAUTH_CLIENT_ID is not set.");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: SCOPES.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    // prompt=select_account so users with multiple Microsoft accounts
    // get a picker rather than being silently signed into whichever
    // one is cached.
    prompt: "select_account"
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
    throw new Error(`Microsoft token exchange failed: ${error}`);
  }
  return payload;
}

export async function exchangeAuthorizationCode({ code, redirectUri, codeVerifier }) {
  const body = buildFormBody({
    client_id: String(process.env.MICROSOFT_OAUTH_CLIENT_ID || "").trim(),
    client_secret: String(process.env.MICROSOFT_OAUTH_CLIENT_SECRET || "").trim(),
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
    scope: SCOPES.join(" ")
  });
  return tokenRequest(body);
}

export async function refreshAccessToken(refreshToken) {
  const body = buildFormBody({
    client_id: String(process.env.MICROSOFT_OAUTH_CLIENT_ID || "").trim(),
    client_secret: String(process.env.MICROSOFT_OAUTH_CLIENT_SECRET || "").trim(),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    scope: SCOPES.join(" ")
  });
  return tokenRequest(body);
}

async function graphGet(url, accessToken, { headers = {} } = {}) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...headers
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload.error?.message || response.statusText;
    const err = new Error(`Microsoft Graph error: ${error}`);
    err.status = response.status;
    err.body = payload;
    throw err;
  }
  return payload;
}

export async function fetchUserInfo(accessToken) {
  const payload = await graphGet(GRAPH_ME, accessToken);
  return {
    email: payload.mail || payload.userPrincipalName || "",
    displayName: payload.displayName || payload.mail || payload.userPrincipalName || "",
    picture: null
  };
}

export async function listCalendars(accessToken) {
  const out = [];
  let url = `${GRAPH_CALENDARS}?$top=50`;
  while (url) {
    const payload = await graphGet(url, accessToken);
    if (Array.isArray(payload.value)) {
      for (const cal of payload.value) {
        out.push({
          id: cal.id,
          summary: cal.name || "Calendar",
          timeZone: null,
          primary: Boolean(cal.isDefaultCalendar),
          accessRole: cal.canEdit ? "writer" : "reader",
          colorId: null,
          backgroundColor: null
        });
      }
    }
    url = payload["@odata.nextLink"] || "";
  }
  return out;
}

// Microsoft's calendarView/delta returns events in a window defined by
// startDateTime/endDateTime. After the first call, we get a deltaLink
// URL with an embedded $deltatoken — passing that URL back retrieves
// only changes since. If the link 410-s we do a fresh full pull.
export async function listEvents(accessToken, calendarId, { previousDeltaLink = "", windowMonths = 13 } = {}) {
  const events = [];
  let deltaLink = "";

  // Start URL: either the saved deltaLink, or a fresh calendarView/delta
  // request with a ~13 month window (30 days back, 12 months forward).
  let url = previousDeltaLink || null;
  if (!url) {
    const now = new Date();
    const startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const endDate = new Date(now);
    endDate.setMonth(endDate.getMonth() + (windowMonths - 1));
    const startDateTime = startDate.toISOString();
    const endDateTime = endDate.toISOString();
    url =
      `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}` +
      `/calendarView/delta?startDateTime=${encodeURIComponent(startDateTime)}` +
      `&endDateTime=${encodeURIComponent(endDateTime)}&$top=200`;
  }

  // Prefer: odata.track-changes tells Graph we understand delta links.
  const headers = { Prefer: 'odata.track-changes, outlook.timezone="UTC"' };

  while (url) {
    let payload;
    try {
      payload = await graphGet(url, accessToken, { headers });
    } catch (err) {
      if (err.status === 410 && previousDeltaLink) {
        // Stale delta token. Retry without it.
        return listEvents(accessToken, calendarId, { previousDeltaLink: "", windowMonths });
      }
      throw err;
    }

    if (Array.isArray(payload.value)) {
      for (const item of payload.value) {
        events.push(item);
      }
    }

    if (payload["@odata.nextLink"]) {
      url = payload["@odata.nextLink"];
    } else {
      deltaLink = payload["@odata.deltaLink"] || "";
      url = null;
    }
  }

  return { events, nextDeltaLink: deltaLink };
}

// Translate a Graph event into Hearthboard's event shape. Handles both
// normal events and delta-response "tombstones" (which carry only an
// id + "@removed" field).
export function mapMicrosoftEventToHearthboard(raw, { integration, calendar, ownerMemberId }) {
  if (!raw) return null;

  // Graph marks deletions with a top-level "@removed" marker.
  if (raw["@removed"]) {
    return { deleted: true, sourceEventId: String(raw.id || "") };
  }

  if (raw.isCancelled) {
    return { deleted: true, sourceEventId: String(raw.id || "") };
  }

  const isAllDay = Boolean(raw.isAllDay);

  let start = null;
  let end = null;
  if (raw.start?.dateTime) {
    // Graph's dateTime doesn't include a "Z" or offset — timeZone is in
    // the sibling "timeZone" field (usually "UTC" since we asked for it
    // via the Prefer header).
    const tz = raw.start.timeZone || "UTC";
    start = parseGraphDateTime(raw.start.dateTime, tz);
  }
  if (raw.end?.dateTime) {
    const tz = raw.end.timeZone || "UTC";
    end = parseGraphDateTime(raw.end.dateTime, tz);
  }

  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  const title = String(raw.subject || "(untitled event)").trim().slice(0, 200);
  // Graph event bodies come as { contentType: "html"|"text", content }
  // Strip HTML for the description field — we don't render rich text.
  let description = "";
  if (raw.bodyPreview) {
    description = String(raw.bodyPreview).trim();
  } else if (raw.body?.content) {
    description = String(raw.body.content)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  description = description.slice(0, 2000);

  const locationName = raw.location?.displayName || "";
  const location = String(locationName).trim().slice(0, 240);

  return {
    title,
    description,
    location,
    category: String(calendar?.summary || "Outlook Calendar").slice(0, 80),
    allDay: isAllDay,
    start: start.toISOString(),
    end: end.toISOString(),
    memberIds: ownerMemberId ? [ownerMemberId] : [],
    source: {
      provider: "microsoft",
      integrationId: integration.id,
      calendarId: calendar.id,
      calendarSummary: calendar.summary || null,
      eventId: String(raw.id || ""),
      etag: String(raw["@odata.etag"] || ""),
      htmlLink: String(raw.webLink || ""),
      syncedAt: new Date().toISOString()
    }
  };
}

function parseGraphDateTime(dateTimeStr, timeZone) {
  // Graph returns ISO-ish strings without trailing Z. If the timeZone
  // field says UTC, append Z so Date parses it correctly. Otherwise we
  // trust the tz name and fall back to UTC if we can't interpret it —
  // still correct to within a few hours for display purposes.
  if (!dateTimeStr) return null;
  const trimmed = String(dateTimeStr).trim();
  if (/Z$/.test(trimmed) || /[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    return new Date(trimmed);
  }
  if (!timeZone || timeZone.toUpperCase() === "UTC") {
    return new Date(trimmed + "Z");
  }
  // For non-UTC zones we lack a real tz library; treat as UTC and let
  // the calendar UI show a slightly-off time rather than throw. The
  // user can toggle their Outlook default tz to UTC-aware if this is
  // ever an issue. (We always ask for UTC via the Prefer header so
  // this path should be rare.)
  return new Date(trimmed + "Z");
}
