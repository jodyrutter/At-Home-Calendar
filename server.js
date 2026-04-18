import express from "express";
import { copyFile, mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JSONFilePreset } from "lowdb/node";
import { nanoid } from "nanoid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const PORT = Number(process.env.PORT || 42069);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "store.json");
const THUMBNAIL_DIR = path.join(DATA_DIR, "media-thumbs");
const VIDEO_PROXY_DIR = path.join(DATA_DIR, "video-proxies");
const APP_TIMEZONE = process.env.APP_TIMEZONE || "America/Port-au-Prince";
const HOUSEHOLD_NAME = process.env.HOUSEHOLD_NAME || "Hearthboard Household";
const MEDIA_LIBRARY_ROOTS = process.env.MEDIA_LIBRARY_ROOTS || "";
const FFMPEG_BIN = process.env.FFMPEG_BIN || "/usr/bin/ffmpeg";
const OLLAMA_BASE_URL = String(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const OLLAMA_MODEL = String(process.env.OLLAMA_MODEL || "hearthboard-assistant").trim() || "hearthboard-assistant";
const OLLAMA_FALLBACK_MODEL = String(process.env.OLLAMA_FALLBACK_MODEL || "qwen2.5:7b").trim() || "qwen2.5:7b";
const OLLAMA_KEEP_ALIVE = String(process.env.OLLAMA_KEEP_ALIVE || "0").trim() || "0";
const OLLAMA_AWAKE_KEEP_ALIVE = String(process.env.OLLAMA_AWAKE_KEEP_ALIVE || "5m").trim() || "5m";
const OLLAMA_TIMEOUT_MS = Number.parseInt(String(process.env.OLLAMA_TIMEOUT_MS || "120000"), 10);
const JODY_AI_NAME = String(process.env.JODY_AI_NAME || "Jody AI").trim() || "Jody AI";
const ASSISTANT_MAX_MESSAGES = 12;
const ASSISTANT_MAX_MESSAGE_LENGTH = 4000;
const BRAVE_SEARCH_API_KEY = String(process.env.BRAVE_SEARCH_API_KEY || "").trim();
const BRAVE_SEARCH_BASE_URL = String(process.env.BRAVE_SEARCH_BASE_URL || "https://api.search.brave.com/res/v1/web/search").trim();
const WEB_SEARCH_RESULT_LIMIT = 5;
const WEB_SEARCH_CONTEXT_LIMIT = 3;
const WEB_SEARCH_PAGE_CHAR_LIMIT = 3200;
const WEB_SEARCH_TIMEOUT_MS = Number.parseInt(String(process.env.WEB_SEARCH_TIMEOUT_MS || "15000"), 10);
const ALLOW_PRIVATE_WEB_FETCH = normalizeBoolean(process.env.ALLOW_PRIVATE_WEB_FETCH);
const TRUST_PROXY_HEADERS = normalizeBoolean(process.env.TRUST_PROXY_HEADERS);
const AUTH_COOKIE = "hearthboard_session";
const DEVICE_COOKIE = "hearthboard_device";
const AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const AUTH_REMEMBER_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEVICE_COOKIE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX_ATTEMPTS = 10;
const ADMIN_USERNAME = "jodyrutter";
const VISIBILITY_OPTIONS = new Set(["public", "trusted", "family", "admin"]);
const PERMISSION_LEVELS = ["default", "trusted", "family", "admin"];
const PAGE_KEYS = ["calendar", "gallery", "assistant"];
const EVENT_NOTIFICATION_OFFSET_OPTIONS = [1440, 180, 60, 10, 0];
const MOBILE_REMINDER_LOOKAHEAD_DAYS = 45;
const VISIBILITY_RANKS = new Map([
  ["public", 0],
  ["trusted", 1],
  ["family", 2],
  ["admin", 3]
]);
const ASSISTANT_SYSTEM_PROMPT =
  String(process.env.ASSISTANT_SYSTEM_PROMPT || "").trim() ||
  [
    "You are Hearthboard Assistant, a private local AI for one household.",
    "Be helpful, concise, and practical.",
    "Prefer short clear answers unless the user asks for more depth.",
    "If you are unsure, say so plainly.",
    "Do not claim to have internet access, live system control, or extra knowledge you were not given.",
    "When brainstorming, provide a few useful options and tradeoffs."
  ].join(" ");
const WEB_SEARCH_SYSTEM_PROMPT = [
  "You have been given web search results and page extracts from the open web.",
  "Use them when they are relevant and recent.",
  "Cite factual claims from the web using square brackets like [1] or [2] matching the source list provided.",
  "If the sources conflict or seem weak, say so plainly.",
  "Do not cite sources you were not given."
].join(" ");

const palette = ["#f97316", "#14b8a6", "#8b5cf6", "#ef4444", "#2563eb", "#ca8a04"];
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const videoExtensions = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const panoramaExtensions = new Set([".html", ".htm"]);
const rawExtensions = new Set([".dng"]);
const supportExtensions = new Set([".txt", ".gz", ".json", ".js", ".css"]);
const DEFAULT_MEDIA_PAGE_SIZE = 48;
const MAX_MEDIA_PAGE_SIZE = 120;
const MEDIA_INDEX_TTL_MS = 5 * 60 * 1000;

function defaultMediaLibraries() {
  if (process.platform === "win32") {
    return [{ id: "drone", label: "Drone pictures", path: "E:\\Drone", excludePaths: [], remoteProtected: false, writable: false }];
  }

  return [];
}

function parseMediaLibraries() {
  if (!MEDIA_LIBRARY_ROOTS.trim()) {
    return defaultMediaLibraries();
  }

  try {
    const parsed = JSON.parse(MEDIA_LIBRARY_ROOTS);
    if (!Array.isArray(parsed)) {
      return defaultMediaLibraries();
    }

    return parsed
      .map((entry) => ({
        id: String(entry.id || "").trim(),
        label: String(entry.label || entry.id || "").trim(),
        path: String(entry.path || "").trim(),
        remoteProtected: normalizeBoolean(entry.remoteProtected),
        authMode: String(entry.authMode || "").trim().toLowerCase(),
        quarantinePath: String(entry.quarantinePath || "").trim(),
        writable: normalizeBoolean(entry.writable) || Boolean(String(entry.quarantinePath || "").trim()),
        excludePaths: Array.isArray(entry.excludePaths)
          ? entry.excludePaths
              .map((excludePath) => String(excludePath || "").replaceAll("\\", "/").trim().replace(/^\/+|\/+$/g, ""))
              .filter(Boolean)
          : []
      }))
      .filter((entry) => entry.id && entry.label && entry.path);
  } catch {
    return defaultMediaLibraries();
  }
}

const mediaLibraries = parseMediaLibraries();
const mediaLibraryMap = new Map(mediaLibraries.map((library) => [library.id, library]));

function seedMembers() {
  return [{ id: nanoid(), name: "Jody", role: "", color: "#2473eb" }];
}

function defaultData() {
  const members = seedMembers();
  return {
    householdName: HOUSEHOLD_NAME,
    timezone: APP_TIMEZONE,
    members,
    events: [],
    bulletins: [],
    mediaViews: {},
    security: {
      remoteAccess: {
        passwordHash: null,
        protectedPages: {
          calendar: true,
          assistant: true,
          gallery: false
        }
      },
      users: [],
      sessions: [],
      devices: [],
      localAi: {
        allowed: true,
        updatedAt: null,
        updatedBy: null
      },
      pageVisibility: defaultPageVisibility(),
      libraryVisibility: defaultLibraryVisibility()
    }
  };
}

function defaultPageVisibility() {
  return {
    calendar: { lan: "family", remote: "family" },
    gallery: { lan: "public", remote: "public" },
    assistant: { lan: "trusted", remote: "trusted" }
  };
}

function defaultLibraryVisibilityEntry(library) {
  const authMode = String(library?.authMode || "").trim().toLowerCase();
  if (authMode === "always") {
    return { lan: "family", remote: "family" };
  }

  if (authMode === "remote" || library?.remoteProtected) {
    return { lan: "public", remote: "trusted" };
  }

  return { lan: "public", remote: "public" };
}

function defaultLibraryVisibility() {
  return Object.fromEntries(mediaLibraries.map((library) => [library.id, defaultLibraryVisibilityEntry(library)]));
}

function normalizeVisibilityLevel(value, fallback = "public") {
  const normalized = String(value || "").trim().toLowerCase();
  return VISIBILITY_OPTIONS.has(normalized) ? normalized : fallback;
}

function normalizeVisibilityRule(rule, fallbackRule) {
  const fallback = fallbackRule || { lan: "public", remote: "public" };
  if (!rule || typeof rule !== "object") {
    return { ...fallback };
  }

  return {
    lan: normalizeVisibilityLevel(rule.lan, fallback.lan),
    remote: normalizeVisibilityLevel(rule.remote, fallback.remote)
  };
}

function visibilityLevelRank(value) {
  return VISIBILITY_RANKS.get(normalizeVisibilityLevel(value, "public")) ?? 0;
}

function clampVisibilityRule(rule, minimumRule) {
  const normalizedRule = normalizeVisibilityRule(rule, minimumRule);
  const minimum = normalizeVisibilityRule(minimumRule, minimumRule);
  return {
    lan: visibilityLevelRank(normalizedRule.lan) < visibilityLevelRank(minimum.lan) ? minimum.lan : normalizedRule.lan,
    remote: visibilityLevelRank(normalizedRule.remote) < visibilityLevelRank(minimum.remote) ? minimum.remote : normalizedRule.remote
  };
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

await mkdir(DATA_DIR, { recursive: true });
await mkdir(THUMBNAIL_DIR, { recursive: true });
await mkdir(VIDEO_PROXY_DIR, { recursive: true });
const db = await JSONFilePreset(DB_FILE, defaultData());
const pendingThumbnailJobs = new Map();
const pendingVideoVariantJobs = new Map();
const mediaIndexCache = new Map();
const pendingMediaIndexJobs = new Map();
const authSessions = new Map();
const authRateLimitBuckets = new Map();

if (!Array.isArray(db.data.events)) {
  db.data.events = [];
}

if (!Array.isArray(db.data.bulletins)) {
  db.data.bulletins = [];
}

if (!db.data.mediaViews || typeof db.data.mediaViews !== "object") {
  db.data.mediaViews = {};
}

if (!db.data.security || typeof db.data.security !== "object") {
  db.data.security = {};
}

if (!db.data.security.remoteAccess || typeof db.data.security.remoteAccess !== "object") {
  db.data.security.remoteAccess = {
    passwordHash: null,
    protectedPages: {
      calendar: true,
      assistant: true,
      gallery: false
    }
  };
}

if (!Array.isArray(db.data.security.users)) {
  db.data.security.users = [];
}

if (!Array.isArray(db.data.security.sessions)) {
  db.data.security.sessions = [];
}

if (!Array.isArray(db.data.security.devices)) {
  db.data.security.devices = [];
}

if (!db.data.security.localAi || typeof db.data.security.localAi !== "object") {
  db.data.security.localAi = {
    allowed: true,
    updatedAt: null,
    updatedBy: null
  };
}

const localAiWasRestrictedOnBoot = db.data.security.localAi.allowed === false;
db.data.security.localAi.allowed = true;
if (localAiWasRestrictedOnBoot) {
  db.data.security.localAi.updatedAt = new Date().toISOString();
  db.data.security.localAi.updatedBy = "startup";
}
db.data.security.localAi.updatedAt = db.data.security.localAi.updatedAt || null;
db.data.security.localAi.updatedBy = db.data.security.localAi.updatedBy || null;

if (!db.data.security.pageVisibility || typeof db.data.security.pageVisibility !== "object") {
  db.data.security.pageVisibility = defaultPageVisibility();
}

for (const pageKey of PAGE_KEYS) {
  db.data.security.pageVisibility[pageKey] = clampVisibilityRule(db.data.security.pageVisibility[pageKey], defaultPageVisibility()[pageKey]);
}

if (!db.data.security.libraryVisibility || typeof db.data.security.libraryVisibility !== "object") {
  db.data.security.libraryVisibility = defaultLibraryVisibility();
}

for (const library of mediaLibraries) {
  db.data.security.libraryVisibility[library.id] = normalizeVisibilityRule(
    db.data.security.libraryVisibility[library.id],
    defaultLibraryVisibilityEntry(library)
  );
}

for (const event of db.data.events) {
  event.memberIds = Array.isArray(event.memberIds) ? [...new Set(event.memberIds.map((memberId) => String(memberId || "").trim()).filter(Boolean))] : [];
  event.notifications = sanitizeStoredEventNotifications(event.notifications);
}

for (const user of db.data.security.users) {
  user.username = normalizeUsername(user.username);
  user.role = user.role === "admin" ? "admin" : "user";
  user.email = String(user.email || "").trim();
  user.phone = String(user.phone || "").trim();
  user.passwordHash = user.passwordHash || null;
  user.permissionLevel = PERMISSION_LEVELS.includes(String(user.permissionLevel || "").trim().toLowerCase())
    ? String(user.permissionLevel || "").trim().toLowerCase()
    : user.role === "admin"
      ? "admin"
      : "default";
  user.approved = user.role === "admin" ? true : normalizeBoolean(user.approved);
  user.householdMember = user.role === "admin" ? true : normalizeBoolean(user.householdMember);
}

let adminUser = db.data.security.users.find((user) => user.username === ADMIN_USERNAME);
if (!adminUser) {
  adminUser = {
    id: nanoid(),
    username: ADMIN_USERNAME,
    role: "admin",
    permissionLevel: "admin",
    approved: true,
    householdMember: true,
    email: "",
    phone: "",
    passwordHash: db.data.security.remoteAccess.passwordHash || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.data.security.users.push(adminUser);
} else {
  adminUser.role = "admin";
  adminUser.permissionLevel = "admin";
  adminUser.approved = true;
  adminUser.householdMember = true;
  if (!adminUser.passwordHash && db.data.security.remoteAccess.passwordHash) {
    adminUser.passwordHash = db.data.security.remoteAccess.passwordHash;
  }
  adminUser.updatedAt = adminUser.updatedAt || new Date().toISOString();
}

db.data.security.remoteAccess.passwordHash = adminUser.passwordHash || null;
synchronizeMembersWithUsers();

for (const session of db.data.security.sessions) {
  if (!session || typeof session !== "object") {
    continue;
  }

  session.token = String(session.token || "").trim();
  session.userId = String(session.userId || "").trim();
  session.createdAt = session.createdAt || new Date().toISOString();
  session.lastSeenAt = session.lastSeenAt || session.createdAt;
  session.expiresAt = session.expiresAt || new Date(Date.now() + AUTH_SESSION_TTL_MS).toISOString();
  session.remembered = Boolean(session.remembered);
}

db.data.security.sessions = db.data.security.sessions.filter((session) => {
  if (!session.token || !session.userId) {
    return false;
  }

  if (!userById(session.userId)) {
    return false;
  }

  return new Date(session.expiresAt).getTime() > Date.now();
});

for (const session of db.data.security.sessions) {
  authSessions.set(session.token, session);
}

for (const device of db.data.security.devices) {
  if (!device || typeof device !== "object") {
    continue;
  }

  device.id = String(device.id || "").trim() || nanoid();
  device.userAgent = String(device.userAgent || "").trim();
  device.label = String(device.label || "").trim() || summarizeUserAgent(device.userAgent);
  device.ip = String(device.ip || "").trim();
  device.host = String(device.host || "").trim();
  device.firstSeenAt = device.firstSeenAt || new Date().toISOString();
  device.lastSeenAt = device.lastSeenAt || device.firstSeenAt;
  device.lastPath = String(device.lastPath || "").trim();
  device.visitCount = Math.max(1, Number.parseInt(String(device.visitCount || "1"), 10) || 1);
  device.authenticatedVisitCount = Math.max(0, Number.parseInt(String(device.authenticatedVisitCount || "0"), 10) || 0);
  device.anonymousVisitCount = Math.max(0, Number.parseInt(String(device.anonymousVisitCount || "0"), 10) || 0);
  device.usernames = Array.isArray(device.usernames) ? [...new Set(device.usernames.map((entry) => normalizeUsername(entry)).filter(Boolean))] : [];
}

db.data.security.devices = db.data.security.devices.filter((device) => device.id);

await db.write();

function sortEvents(events) {
  return [...events].sort((left, right) => {
    const startDiff = new Date(left.start).getTime() - new Date(right.start).getTime();
    if (startDiff !== 0) {
      return startDiff;
    }
    return left.title.localeCompare(right.title);
  });
}

function sortBulletins(bulletins) {
  return [...bulletins].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }

    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });
}

function sortMembers(members) {
  return [...members].sort((left, right) => {
    if (left.userId && right.userId) {
      const leftUser = userById(left.userId);
      const rightUser = userById(right.userId);
      if (leftUser?.role !== rightUser?.role) {
        return leftUser?.role === "admin" ? -1 : 1;
      }
    }

    return String(left.name || "").localeCompare(String(right.name || ""));
  });
}

function prettifyUsername(username) {
  const normalized = normalizeUsername(username).replace(/[._-]+/g, " ").trim();
  if (!normalized) {
    return "Household member";
  }

  return normalized
    .split(/\s+/)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function notificationOffsetLabel(offsetMinutes) {
  if (offsetMinutes === 0) {
    return "At start";
  }

  if (offsetMinutes % 1440 === 0) {
    const days = offsetMinutes / 1440;
    return `${days} day${days === 1 ? "" : "s"} before`;
  }

  if (offsetMinutes % 60 === 0) {
    const hours = offsetMinutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"} before`;
  }

  return `${offsetMinutes} min before`;
}

function memberColorForUser(user, existingMember = null) {
  const current = String(existingMember?.color || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(current)) {
    return current;
  }

  const seed = String(user?.username || existingMember?.name || "");
  const hash = [...seed].reduce((total, character) => total + character.charCodeAt(0), 0);
  return palette[hash % palette.length];
}

function synchronizeMembersWithUsers() {
  if (!Array.isArray(db.data.members)) {
    db.data.members = [];
  }

  const originalMembers = [...db.data.members];
  const nextMembers = [];
  const userIdMap = new Map();

  for (const user of users()) {
    if (!userIsHouseholdMember(user)) {
      continue;
    }

    let member = originalMembers.find((entry) => entry.userId === user.id);

    if (!member && user.username === ADMIN_USERNAME) {
      member = originalMembers.find((entry) => normalizeUsername(entry.name) === "jody");
    }

    if (!member) {
      member = originalMembers.find((entry) => normalizeUsername(entry.username) === user.username);
    }

    const displayName = String(member?.name || "").trim() || prettifyUsername(user.username);
    const nextMember = {
      id: member?.id || nanoid(),
      userId: user.id,
      username: user.username,
      name: displayName,
      role: String(member?.role || "").trim(),
      color: memberColorForUser(user, member)
    };

    nextMembers.push(nextMember);
    userIdMap.set(user.id, nextMember.id);
  }

  const validMemberIds = new Set(nextMembers.map((member) => member.id));
  const validNotificationUserIds = new Set(notificationTargetUsers().map((user) => user.id));
  for (const event of db.data.events) {
    event.memberIds = Array.isArray(event.memberIds) ? event.memberIds.filter((memberId) => validMemberIds.has(memberId)) : [];
    event.notifications = sanitizeStoredEventNotifications(event.notifications);
    event.notifications.targetUserIds = event.notifications.targetUserIds.filter((userId) => validNotificationUserIds.has(userId));
    if (event.notifications.targetUserIds.length === 0) {
      event.notifications = {
        enabled: false,
        targetUserIds: [],
        offsetsMinutes: []
      };
    }
  }

  db.data.members = sortMembers(nextMembers);
  return userIdMap;
}

function normalizeEventPayload(payload, existingEvent = null) {
  const title = String(payload.title || "").trim();
  const description = String(payload.description || "").trim();
  const category = String(payload.category || "General").trim() || "General";
  const location = String(payload.location || "").trim();
  const allDay = Boolean(payload.allDay);
  const start = new Date(payload.start);
  const end = new Date(payload.end);
  const memberIds = Array.isArray(payload.memberIds)
    ? payload.memberIds.filter((memberId) => db.data.members.some((member) => member.id === memberId))
    : [];
  const notifications = normalizeEventNotifications(payload.notifications, existingEvent?.notifications);

  if (!title) {
    return { error: "Event title is required." };
  }

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { error: "Start and end times must be valid." };
  }

  if (end.getTime() < start.getTime()) {
    return { error: "Event end time must be after the start time." };
  }

  if (notifications.enabled && notifications.targetUserIds.length === 0) {
    return { error: "Choose at least one account to notify." };
  }

  if (notifications.enabled && notifications.offsetsMinutes.length === 0) {
    return { error: "Choose at least one reminder time." };
  }

  return {
    data: {
      id: existingEvent?.id || nanoid(),
      title,
      description,
      category,
      location,
      allDay,
      memberIds,
      notifications,
      start: start.toISOString(),
      end: end.toISOString(),
      createdAt: existingEvent?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  };
}

function normalizeBulletinPayload(payload, existingBulletin = null) {
  const title = String(payload.title || "").trim();
  const message = String(payload.message || "").trim();
  const author = String(payload.author || "").trim();
  const tone = String(payload.tone || "Note").trim() || "Note";
  const pinned = Boolean(payload.pinned);

  if (!title) {
    return { error: "Bulletin title is required." };
  }

  if (!message) {
    return { error: "Bulletin message is required." };
  }

  return {
    data: {
      id: existingBulletin?.id || nanoid(),
      title,
      message,
      author: author || "Household",
      tone,
      pinned,
      createdAt: existingBulletin?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  };
}

function snapshot(request = null) {
  return {
    householdName: db.data.householdName,
    timezone: db.data.timezone,
    members: sortMembers(db.data.members),
    events: sortEvents(db.data.events),
    bulletins: sortBulletins(db.data.bulletins),
    mediaLibraries: mediaLibraries.map((library) => ({ id: library.id, label: library.label })),
    notificationTargets: notificationTargetUsers().map((user) => notificationTargetSummary(user)),
    reminderOptions: EVENT_NOTIFICATION_OFFSET_OPTIONS.map((offsetMinutes) => ({
      offsetMinutes,
      label: notificationOffsetLabel(offsetMinutes)
    })),
    currentUser: request ? userSummary(authenticatedUser(request)) : null
  };
}

function remoteAccessConfig() {
  return db.data.security.remoteAccess;
}

function users() {
  return db.data.security.users;
}

function memberByUserId(userId) {
  return db.data.members.find((member) => member.userId === userId) || null;
}

function findUserByUsername(username) {
  const normalized = normalizeUsername(username);
  return users().find((user) => user.username === normalized) || null;
}

function userById(userId) {
  return users().find((user) => user.id === userId) || null;
}

function adminUserAccount() {
  return findUserByUsername(ADMIN_USERNAME);
}

function passwordConfigured() {
  return Boolean(adminUserAccount()?.passwordHash);
}

function userSummary(user) {
  if (!user) {
    return null;
  }

  const member = memberByUserId(user.id);
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    approved: user.role === "admin" ? true : Boolean(user.approved),
    permissionLevel: user.role === "admin" ? "admin" : (user.permissionLevel || "default"),
    householdMember: user.role === "admin" ? true : Boolean(user.householdMember),
    memberId: member?.id || null,
    memberName: member?.name || prettifyUsername(user.username),
    email: String(user.email || "").trim(),
    phone: String(user.phone || "").trim(),
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null
  };
}

function notificationTargetUsers() {
  return users()
    .filter((user) => user.role === "admin" || userIsApproved(user))
    .sort((left, right) => {
      const leftLabel = notificationTargetSummary(left).label.toLowerCase();
      const rightLabel = notificationTargetSummary(right).label.toLowerCase();
      return leftLabel.localeCompare(rightLabel);
    });
}

function notificationTargetSummary(user) {
  const member = memberByUserId(user.id);
  return {
    id: user.id,
    username: user.username,
    label: member?.name || prettifyUsername(user.username),
    role: user.role === "admin" ? "Admin" : normalizedPermissionLevel(user)
  };
}

function normalizeNotificationOffsets(offsets) {
  if (!Array.isArray(offsets)) {
    return [];
  }

  return [...new Set(offsets
    .map((offset) => Number.parseInt(String(offset), 10))
    .filter((offset) => Number.isFinite(offset) && offset >= 0 && offset <= 14 * 24 * 60))]
    .sort((left, right) => right - left);
}

function normalizeEventNotifications(payload, existingNotifications = null) {
  const source = payload && typeof payload === "object" ? payload : {};
  const enabled = normalizeBoolean(source.enabled);
  const approvedUserIds = new Set(notificationTargetUsers().map((user) => user.id));
  const targetUserIds = Array.isArray(source.targetUserIds)
    ? [...new Set(source.targetUserIds.map((userId) => String(userId || "").trim()).filter((userId) => approvedUserIds.has(userId)))]
    : [];
  const fallbackOffsets = enabled
    ? existingNotifications?.offsetsMinutes || EVENT_NOTIFICATION_OFFSET_OPTIONS
    : [];
  const offsetsMinutes = normalizeNotificationOffsets(source.offsetsMinutes ?? fallbackOffsets);

  return {
    enabled,
    targetUserIds: enabled ? targetUserIds : [],
    offsetsMinutes: enabled ? offsetsMinutes : []
  };
}

function sanitizeStoredEventNotifications(notifications) {
  return normalizeEventNotifications(notifications, notifications);
}

function upcomingReminderEntriesForUser(user, now = new Date()) {
  if (!user) {
    return [];
  }

  const lookaheadLimit = new Date(now.getTime() + MOBILE_REMINDER_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

  return sortEvents(db.data.events)
    .flatMap((event) => {
      const notifications = sanitizeStoredEventNotifications(event.notifications);
      if (!notifications.enabled || !notifications.targetUserIds.includes(user.id)) {
        return [];
      }

      const eventStart = new Date(event.start);
      if (Number.isNaN(eventStart.getTime())) {
        return [];
      }

      return notifications.offsetsMinutes.flatMap((offsetMinutes) => {
        const triggerAt = new Date(eventStart.getTime() - offsetMinutes * 60 * 1000);
        if (triggerAt < now || triggerAt > lookaheadLimit) {
          return [];
        }

        const title = offsetMinutes === 0 ? `${event.title} starts now` : `${event.title} is coming up`;
        const bodyParts = [formatReminderEventTime(event)];
        if (event.location) {
          bodyParts.push(event.location);
        }
        if (offsetMinutes > 0) {
          bodyParts.unshift(notificationOffsetLabel(offsetMinutes));
        }

        return {
          reminderId: `${event.id}:${user.id}:${offsetMinutes}`,
          eventId: event.id,
          eventTitle: event.title,
          title,
          body: bodyParts.filter(Boolean).join(" | "),
          scheduleAt: triggerAt.toISOString(),
          eventStart: event.start,
          eventEnd: event.end,
          offsetMinutes,
          offsetLabel: notificationOffsetLabel(offsetMinutes),
          location: event.location || "",
          category: event.category || "General",
          allDay: Boolean(event.allDay),
          eventUrl: "/",
          updatedAt: event.updatedAt || event.createdAt || event.start
        };
      });
    })
    .sort((left, right) => new Date(left.scheduleAt).getTime() - new Date(right.scheduleAt).getTime());
}

function formatReminderEventTime(event) {
  const start = new Date(event.start);
  if (Number.isNaN(start.getTime())) {
    return "Upcoming event";
  }

  if (event.allDay) {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(start) + " all day";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(start);
}

function adminManagedUserSummary(user) {
  return {
    ...userSummary(user),
    householdMember: userIsHouseholdMember(user),
    directHouseholdMember: Boolean(user?.householdMember),
    pendingApproval: !userIsApproved(user),
    canEdit: user?.role !== "admin"
  };
}

function sessions() {
  return db.data.security.sessions;
}

function devices() {
  return db.data.security.devices;
}

function mediaViews() {
  return db.data.mediaViews;
}

function mediaViewKey(libraryId, relativePath) {
  return `${libraryId}:${String(relativePath || "").trim().replaceAll("\\", "/")}`;
}

function mediaViewStats(libraryId, relativePath) {
  const entry = mediaViews()[mediaViewKey(libraryId, relativePath)];
  return {
    viewCount: Math.max(0, Number.parseInt(String(entry?.viewCount || "0"), 10) || 0),
    lastViewedAt: entry?.lastViewedAt || null
  };
}

function upsertMediaView(libraryId, relativePath) {
  const key = mediaViewKey(libraryId, relativePath);
  const existing = mediaViews()[key] || { viewCount: 0, lastViewedAt: null };
  const next = {
    viewCount: existing.viewCount + 1,
    lastViewedAt: new Date().toISOString()
  };
  mediaViews()[key] = next;
  return next;
}

function normalizedPermissionLevel(user) {
  if (!user) {
    return "default";
  }

  if (user.role === "admin") {
    return "admin";
  }

  const level = String(user.permissionLevel || "default").trim().toLowerCase();
  return PERMISSION_LEVELS.includes(level) ? level : "default";
}

function userIsApproved(user) {
  return Boolean(user) && (user.role === "admin" || Boolean(user.approved));
}

function userIsHouseholdMember(user) {
  if (!user) {
    return false;
  }

  if (user.role === "admin") {
    return true;
  }

  if (!userIsApproved(user)) {
    return false;
  }

  return normalizedPermissionLevel(user) === "family" || Boolean(user.householdMember);
}

function userVisibilityRank(user) {
  if (!user) {
    return 0;
  }

  if (user.role === "admin") {
    return 3;
  }

  if (!userIsApproved(user)) {
    return 0;
  }

  if (userIsHouseholdMember(user)) {
    return 2;
  }

  if (normalizedPermissionLevel(user) === "trusted") {
    return 1;
  }

  return 0;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${derivedKey}`;
}

function verifyPassword(password, storedHash) {
  if (!password || !storedHash) {
    return false;
  }

  const [algorithm, salt, expectedHex] = String(storedHash).split(":");
  if (algorithm !== "scrypt" || !salt || !expectedHex) {
    return false;
  }

  const derivedKey = scryptSync(password, salt, 64);
  const expectedKey = Buffer.from(expectedHex, "hex");
  if (derivedKey.length !== expectedKey.length) {
    return false;
  }

  return timingSafeEqual(derivedKey, expectedKey);
}

function authSessionTtlMs(remembered = false) {
  return remembered ? AUTH_REMEMBER_TTL_MS : AUTH_SESSION_TTL_MS;
}

async function createAuthSession(userId, { remembered = false } = {}) {
  const token = randomBytes(32).toString("hex");
  const session = {
    token,
    userId,
    remembered: Boolean(remembered),
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + authSessionTtlMs(remembered)).toISOString()
  };
  authSessions.set(token, session);
  sessions().push(session);
  await db.write();
  return token;
}

function cleanupAuthSessions() {
  const now = Date.now();
  for (const [token, session] of authSessions.entries()) {
    if (!session || new Date(session.expiresAt).getTime() <= now) {
      authSessions.delete(token);
    }
  }

  db.data.security.sessions = sessions().filter((session) => new Date(session.expiresAt).getTime() > now);
}

async function removeAuthSession(token) {
  if (!token) {
    return;
  }

  authSessions.delete(token);
  db.data.security.sessions = sessions().filter((session) => session.token !== token);
  await db.write();
}

function authRateLimitKey(scope, request) {
  return `${scope}:${requestClientIp(request) || "unknown"}`;
}

function cleanupAuthRateLimit(scope, request) {
  const key = authRateLimitKey(scope, request);
  const bucket = authRateLimitBuckets.get(key);
  if (bucket && bucket.resetAt <= Date.now()) {
    authRateLimitBuckets.delete(key);
    return null;
  }

  return bucket || null;
}

function authRateLimitStatus(scope, request) {
  const bucket = cleanupAuthRateLimit(scope, request);
  if (!bucket || bucket.count < AUTH_RATE_LIMIT_MAX_ATTEMPTS) {
    return { limited: false, retryAfterMs: 0 };
  }

  return {
    limited: true,
    retryAfterMs: Math.max(bucket.resetAt - Date.now(), 1000)
  };
}

function recordAuthRateLimitFailure(scope, request) {
  const key = authRateLimitKey(scope, request);
  const now = Date.now();
  const bucket = cleanupAuthRateLimit(scope, request);
  if (!bucket) {
    authRateLimitBuckets.set(key, {
      count: 1,
      resetAt: now + AUTH_RATE_LIMIT_WINDOW_MS
    });
    return;
  }

  bucket.count += 1;
  authRateLimitBuckets.set(key, bucket);
}

function clearAuthRateLimit(scope, request) {
  authRateLimitBuckets.delete(authRateLimitKey(scope, request));
}

function readCookies(request) {
  const header = String(request.headers.cookie || "");
  const cookies = {};

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!key) {
      continue;
    }

    cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function forwardedHost(request) {
  if (!TRUST_PROXY_HEADERS) {
    return "";
  }

  const forwarded = String(request.headers["x-forwarded-host"] || "").trim();
  if (!forwarded) {
    return "";
  }

  return forwarded.split(",")[0].trim();
}

function forwardedProto(request) {
  if (!TRUST_PROXY_HEADERS) {
    return "";
  }

  const forwarded = String(request.headers["x-forwarded-proto"] || "").trim();
  if (!forwarded) {
    return "";
  }

  return forwarded.split(",")[0].trim().toLowerCase();
}

function sessionIsValid(token) {
  cleanupAuthSessions();
  const session = authSessions.get(token);
  if (!session || !session.userId) {
    authSessions.delete(token);
    return null;
  }

  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    authSessions.delete(token);
    return null;
  }

  const user = userById(session.userId);
  if (!user) {
    authSessions.delete(token);
    return null;
  }

  return user;
}

function appendSetCookie(response, value) {
  const existing = response.getHeader("Set-Cookie");
  if (!existing) {
    response.setHeader("Set-Cookie", value);
    return;
  }

  if (Array.isArray(existing)) {
    response.setHeader("Set-Cookie", [...existing, value]);
    return;
  }

  response.setHeader("Set-Cookie", [existing, value]);
}

function requestIsSecure(request) {
  const proto = forwardedProto(request);
  if (proto) {
    return proto === "https";
  }

  return Boolean(request.socket?.encrypted);
}

function requestWantsMobileCookies(request) {
  if (String(request.headers["x-hearthboard-mobile-app"] || "").trim() === "1") {
    return true;
  }

  const queryFlag = String(request.query?.mobileApp || request.query?.mobileapp || "").trim().toLowerCase();
  if (queryFlag === "1" || queryFlag === "true") {
    return true;
  }

  const referer = String(request.headers.referer || "").trim();
  if (!referer) {
    return false;
  }

  try {
    const refererUrl = new URL(referer);
    const mobileFlag = String(refererUrl.searchParams.get("mobileApp") || "").trim().toLowerCase();
    return mobileFlag === "1" || mobileFlag === "true";
  } catch {
    return false;
  }
}

function authCookieSameSite(request) {
  if (requestIsSecure(request) && requestWantsMobileCookies(request)) {
    return "None";
  }

  return "Lax";
}

function loginRedirectUrl(request, nextPath) {
  const params = new URLSearchParams();
  params.set("next", nextPath);
  if (requestWantsMobileCookies(request)) {
    params.set("mobileApp", "1");
  }

  return `/login?${params.toString()}`;
}

function setAuthCookie(request, response, token, remembered = false) {
  const parts = [
    `${AUTH_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${authCookieSameSite(request)}`
  ];

  if (remembered) {
    parts.push(`Max-Age=${Math.floor(authSessionTtlMs(true) / 1000)}`);
  }

  if (requestIsSecure(request)) {
    parts.push("Secure");
  }

  appendSetCookie(response, parts.join("; "));
}

function clearAuthCookie(request, response) {
  const parts = [`${AUTH_COOKIE}=`, "Path=/", "HttpOnly", `SameSite=${authCookieSameSite(request)}`, "Max-Age=0"];
  if (requestIsSecure(request)) {
    parts.push("Secure");
  }

  appendSetCookie(response, parts.join("; "));
}

function setDeviceCookie(request, response, deviceId) {
  const parts = [
    `${DEVICE_COOKIE}=${encodeURIComponent(deviceId)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${authCookieSameSite(request)}`,
    `Max-Age=${Math.floor(DEVICE_COOKIE_TTL_MS / 1000)}`
  ];
  if (requestIsSecure(request)) {
    parts.push("Secure");
  }

  appendSetCookie(response, parts.join("; "));
}

async function clearAuthSessionForRequest(request, response) {
  const cookies = readCookies(request);
  const token = cookies[AUTH_COOKIE];
  if (token) {
    await removeAuthSession(token);
  }
  clearAuthCookie(request, response);
}

function requestHostname(request) {
  const hostHeader = forwardedHost(request) || String(request.headers.host || "").trim();
  const withoutPort = hostHeader.startsWith("[") ? hostHeader.slice(1, hostHeader.indexOf("]")) : hostHeader.split(":")[0];
  return withoutPort.toLowerCase();
}

function forwardedClientIp(request) {
  if (!TRUST_PROXY_HEADERS) {
    return "";
  }

  const forwarded = String(request.headers["x-forwarded-for"] || "").trim();
  if (!forwarded) {
    return "";
  }

  return forwarded.split(",")[0].trim().replace(/^::ffff:/, "");
}

function requestClientIp(request) {
  return forwardedClientIp(request) || String(request.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

function hostLooksLocal(hostname) {
  if (!hostname) {
    return false;
  }

  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    (!hostname.includes(".") && !hostname.includes(":")) ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  );
}

function ipLooksPrivate(ip) {
  if (!ip) {
    return false;
  }

  const normalized = ip.replace(/^::ffff:/, "");
  return (
    normalized === "::1" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("10.") ||
    normalized.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)
  );
}

function requestIsLan(request) {
  return hostLooksLocal(requestHostname(request));
}

function requestIsLocalMachine(request) {
  const hostname = requestHostname(request);
  const ip = requestClientIp(request);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || ip === "127.0.0.1" || ip === "::1";
}

function requestCanSelfRegister(request) {
  return requestIsLocalMachine(request) || ipLooksPrivate(requestClientIp(request));
}

function requestUserAgent(request) {
  return String(request.headers["user-agent"] || "").trim();
}

function summarizeUserAgent(userAgent) {
  if (!userAgent) {
    return "Unknown device";
  }

  const patterns = [
    /(iphone|ipad|ipod)/i,
    /(android)/i,
    /(windows)/i,
    /(macintosh|mac os x)/i,
    /(linux)/i
  ];

  for (const pattern of patterns) {
    const match = userAgent.match(pattern);
    if (match) {
      return match[1].replace(/_/g, " ");
    }
  }

  return userAgent.slice(0, 80);
}

function shouldTrackDeviceRequest(request) {
  const requestPath = String(request.path || "");
  if (isAssetPath(requestPath) || requestPath === "/favicon.svg") {
    return false;
  }

  return !(
    requestPath.startsWith("/media/") ||
    requestPath.startsWith("/media-thumb/") ||
    requestPath.startsWith("/media-video/")
  );
}

async function trackDeviceRequest(request, response) {
  if (!shouldTrackDeviceRequest(request)) {
    return;
  }

  const cookies = readCookies(request);
  let deviceId = String(cookies[DEVICE_COOKIE] || "").trim();
  if (!deviceId) {
    deviceId = nanoid();
    setDeviceCookie(request, response, deviceId);
  }

  const user = authenticatedUser(request);
  const now = new Date().toISOString();
  let device = devices().find((entry) => entry.id === deviceId);

  if (!device) {
    device = {
      id: deviceId,
      userAgent: requestUserAgent(request),
      label: summarizeUserAgent(requestUserAgent(request)),
      ip: requestClientIp(request),
      host: requestHostname(request),
      firstSeenAt: now,
      lastSeenAt: now,
      lastPath: request.originalUrl || request.path || "/",
      visitCount: 1,
      authenticatedVisitCount: user ? 1 : 0,
      anonymousVisitCount: user ? 0 : 1,
      usernames: user ? [user.username] : []
    };
    devices().push(device);
    await db.write();
    return;
  }

  const nextUsernames = new Set(Array.isArray(device.usernames) ? device.usernames : []);
  if (user?.username) {
    nextUsernames.add(user.username);
  }

  device.userAgent = requestUserAgent(request) || device.userAgent;
  device.label = device.label || summarizeUserAgent(device.userAgent);
  device.ip = requestClientIp(request);
  device.host = requestHostname(request);
  device.lastSeenAt = now;
  device.lastPath = request.originalUrl || request.path || "/";
  device.visitCount = Math.max(1, Number.parseInt(String(device.visitCount || "0"), 10) || 0) + 1;
  device.authenticatedVisitCount = Math.max(0, Number.parseInt(String(device.authenticatedVisitCount || "0"), 10) || 0) + (user ? 1 : 0);
  device.anonymousVisitCount = Math.max(0, Number.parseInt(String(device.anonymousVisitCount || "0"), 10) || 0) + (user ? 0 : 1);
  device.usernames = [...nextUsernames];

  await db.write();
}

function authenticatedUser(request) {
  const cookies = readCookies(request);
  const token = cookies[AUTH_COOKIE];
  return token ? sessionIsValid(token) : null;
}

function requestIsAuthenticated(request) {
  return Boolean(authenticatedUser(request));
}

function requestIsAdmin(request) {
  return authenticatedUser(request)?.role === "admin";
}

function isAssetPath(requestPath) {
  return /\.(css|js|svg|png|jpe?g|webp|gif|ico|map)$/i.test(requestPath);
}

function isPublicRequestPath(requestPath) {
  return (
    requestPath === "/gallery" ||
    requestPath === "/login" ||
    requestPath === "/access" ||
    requestPath === "/favicon.svg" ||
    requestPath.startsWith("/media/") ||
    requestPath.startsWith("/media-thumb/") ||
    requestPath.startsWith("/media-video/") ||
    requestPath.startsWith("/api/health") ||
    requestPath.startsWith("/api/media/") ||
    requestPath.startsWith("/api/auth/") ||
    requestPath.startsWith("/api/session/") ||
    isAssetPath(requestPath)
  );
}

function requestAudienceScope(request) {
  return requestIsLan(request) ? "lan" : "remote";
}

function visibilityLevelAllows(level, user) {
  const normalized = normalizeVisibilityLevel(level, "public");
  if (normalized === "public") {
    return true;
  }

  if (!user) {
    return false;
  }

  if (normalized === "admin") {
    return user.role === "admin";
  }

  if (normalized === "family") {
    return userVisibilityRank(user) >= 2;
  }

  return userVisibilityRank(user) >= 1;
}

function localAiPolicy() {
  return {
    allowed: db.data.security?.localAi?.allowed !== false,
    updatedAt: db.data.security?.localAi?.updatedAt || null,
    updatedBy: db.data.security?.localAi?.updatedBy || null
  };
}

async function updateLocalAiPolicy(allowed, updatedBy = null) {
  db.data.security.localAi = {
    allowed: allowed !== false,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || null
  };
  await db.write();
  return localAiPolicy();
}

function pageVisibility(pageKey) {
  const defaults = defaultPageVisibility();
  return clampVisibilityRule(db.data.security.pageVisibility?.[pageKey], defaults[pageKey]);
}

function libraryVisibility(library) {
  if (!library) {
    return { lan: "public", remote: "public" };
  }

  return normalizeVisibilityRule(
    db.data.security.libraryVisibility?.[library.id],
    defaultLibraryVisibilityEntry(library)
  );
}

function requestCanAccessPage(request, pageKey) {
  if (pageKey === "account") {
    return requestIsAuthenticated(request);
  }

  const rule = pageVisibility(pageKey);
  return visibilityLevelAllows(rule[requestAudienceScope(request)], authenticatedUser(request));
}

function requestCanAccessMediaLibrary(request, library) {
  if (!library) {
    return false;
  }

  const rule = libraryVisibility(library);
  return visibilityLevelAllows(rule[requestAudienceScope(request)], authenticatedUser(request));
}

function writableMediaLibraries() {
  return mediaLibraries.filter((library) => library.writable);
}

function requestCanMoveMediaLibrary(request, library) {
  if (!library?.writable || !requestIsAdmin(request)) {
    return false;
  }

  return writableMediaLibraries().some((candidate) => candidate.id !== library.id);
}

function accessibleMediaLibrariesForRequest(request) {
  return mediaLibraries.filter((library) => requestCanAccessMediaLibrary(request, library));
}

function requestCanQuarantineLibrary(request, library) {
  return Boolean(library?.quarantinePath) && requestIsAdmin(request);
}

function mediaLibrarySummaryForRequest(request, library) {
  const visibility = libraryVisibility(library);
  return {
    id: library.id,
    label: library.label,
    visibility,
    canQuarantine: requestCanQuarantineLibrary(request, library),
    canMoveMedia: requestCanMoveMediaLibrary(request, library),
    moveTargets: requestIsAdmin(request)
      ? writableMediaLibraries()
          .filter((candidate) => candidate.id !== library.id)
          .map((candidate) => ({ id: candidate.id, label: candidate.label }))
      : []
  };
}

function mediaLibrarySummariesForRequest(request) {
  return accessibleMediaLibrariesForRequest(request).map((library) => mediaLibrarySummaryForRequest(request, library));
}

function denyMediaLibraryAccess(request, response) {
  const user = authenticatedUser(request);
  const authMessage = "This album requires a signed-in approved account.";
  const payload = {
    error: user ? "This album is not available to your current access level." : authMessage,
    requiresLogin: !user,
    requiresAdmin: Boolean(user && user.role === "admin")
  };

  if (request.path.startsWith("/api/")) {
    return response.status(user ? 403 : 401).json(payload);
  }

  return response.status(user ? 403 : 401).send(payload.error);
}

function ensureMediaLibraryAccess(request, response, library) {
  if (requestCanAccessMediaLibrary(request, library)) {
    return true;
  }

  denyMediaLibraryAccess(request, response);
  return false;
}

function mediaTypeForExtension(extension) {
  const normalized = extension.toLowerCase();

  if (imageExtensions.has(normalized)) {
    return "image";
  }

  if (videoExtensions.has(normalized)) {
    return "video";
  }

  if (panoramaExtensions.has(normalized)) {
    return "panorama";
  }

  if (rawExtensions.has(normalized)) {
    return "raw";
  }

  return "other";
}

function normalizeMediaTypeFilter(value) {
  const normalized = String(value || "all").trim().toLowerCase();
  return ["all", "image", "video", "panorama", "raw"].includes(normalized) ? normalized : "all";
}

function normalizePageNumber(value) {
  const parsed = Number.parseInt(String(value || "1"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function normalizePageSize(value) {
  const parsed = Number.parseInt(String(value || DEFAULT_MEDIA_PAGE_SIZE), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MEDIA_PAGE_SIZE;
  }

  return Math.min(parsed, MAX_MEDIA_PAGE_SIZE);
}

function normalizeAssistantMessages(payload) {
  const submittedMessages = Array.isArray(payload?.messages) ? payload.messages : [];
  const normalizedMessages = submittedMessages
    .map((message) => {
      const role = String(message?.role || "").trim().toLowerCase();
      const content = String(message?.content || "")
        .replace(/\r\n/g, "\n")
        .trim()
        .slice(0, ASSISTANT_MAX_MESSAGE_LENGTH);

      if (!["user", "assistant"].includes(role) || !content) {
        return null;
      }

      return { role, content };
    })
    .filter(Boolean);

  if (normalizedMessages.length > 0) {
    return normalizedMessages.slice(-ASSISTANT_MAX_MESSAGES);
  }

  const prompt = String(payload?.prompt || "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, ASSISTANT_MAX_MESSAGE_LENGTH);

  return prompt ? [{ role: "user", content: prompt }] : [];
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function assistantTimeoutMs() {
  if (!Number.isFinite(OLLAMA_TIMEOUT_MS) || OLLAMA_TIMEOUT_MS < 1000) {
    return 120000;
  }

  return OLLAMA_TIMEOUT_MS;
}

function webSearchTimeoutMs() {
  if (!Number.isFinite(WEB_SEARCH_TIMEOUT_MS) || WEB_SEARCH_TIMEOUT_MS < 1000) {
    return 15000;
  }

  return WEB_SEARCH_TIMEOUT_MS;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchOllama(pathname, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), assistantTimeoutMs());

  try {
    return await fetch(`${OLLAMA_BASE_URL}${pathname}`, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractOllamaModelNames(payload) {
  if (!Array.isArray(payload?.models)) {
    return [];
  }

  const names = payload.models
    .map((entry) => String(entry?.model || entry?.name || "").trim())
    .filter(Boolean);

  return [...new Set(names)];
}

function extractRunningOllamaModels(payload) {
  if (!Array.isArray(payload?.models)) {
    return [];
  }

  return payload.models
    .map((entry) => ({
      name: String(entry?.name || entry?.model || "").trim(),
      model: String(entry?.model || entry?.name || "").trim(),
      sizeVram: Number(entry?.size_vram || 0),
      contextLength: Number(entry?.context_length || 0),
      expiresAt: entry?.expires_at || null
    }))
    .filter((entry) => entry.model);
}

function webSearchStatus() {
  return {
    enabled: true,
    provider: BRAVE_SEARCH_API_KEY ? "brave" : "duckduckgo",
    mode: BRAVE_SEARCH_API_KEY ? "api-key" : "best-effort",
    resultLimit: WEB_SEARCH_RESULT_LIMIT,
    contextLimit: WEB_SEARCH_CONTEXT_LIMIT
  };
}

function latestUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user" && messages[index]?.content) {
      return messages[index].content;
    }
  }

  return "";
}

function decodeHtmlEntities(input) {
  return String(input || "")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtml(html) {
  const cleaned = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  return decodeHtmlEntities(cleaned).replace(/\s+/g, " ").trim();
}

function normalizeSearchResultUrl(url) {
  const trimmed = String(url || "").trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }

    const hostname = parsed.hostname.toLowerCase();
    if (!ALLOW_PRIVATE_WEB_FETCH) {
      if (
        hostname === "localhost" ||
        hostname === "host.docker.internal" ||
        hostname.endsWith(".local") ||
        hostname === "::1" ||
        hostname === "[::1]" ||
        hostname.startsWith("127.") ||
        hostname.startsWith("10.") ||
        hostname.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
      ) {
        return null;
      }

      if (hostname.startsWith("fc") || hostname.startsWith("fd")) {
        return null;
      }
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

function duckDuckGoResolvedUrl(href) {
  const normalized = normalizeSearchResultUrl(href);
  if (normalized && !normalized.includes("duckduckgo.com/l/?")) {
    return normalized;
  }

  try {
    const parsed = new URL(href.startsWith("//") ? `https:${href}` : href, "https://duckduckgo.com");
    const redirect = parsed.searchParams.get("uddg");
    return redirect ? normalizeSearchResultUrl(decodeURIComponent(redirect)) : normalizeSearchResultUrl(parsed.toString());
  } catch {
    return null;
  }
}

function parseDuckDuckGoResults(html) {
  const matches = [...String(html || "").matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const results = [];

  for (const match of matches) {
    const href = match[1];
    const title = stripHtml(match[2]);
    const url = duckDuckGoResolvedUrl(href);
    if (!url || !title) {
      continue;
    }

    const snippetWindow = String(html || "").slice(match.index, match.index + 1600);
    const snippetMatch = snippetWindow.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)/i);
    const snippet = stripHtml(snippetMatch?.[1] || "");

    results.push({ title, url, snippet });
    if (results.length >= WEB_SEARCH_RESULT_LIMIT) {
      break;
    }
  }

  return results;
}

async function searchWebBrave(query) {
  const url = new URL(BRAVE_SEARCH_BASE_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(WEB_SEARCH_RESULT_LIMIT));
  url.searchParams.set("safesearch", "moderate");
  url.searchParams.set("search_lang", "en");
  url.searchParams.set("country", "us");
  url.searchParams.set("text_decorations", "false");

  const response = await fetchWithTimeout(
    url.toString(),
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": BRAVE_SEARCH_API_KEY
      }
    },
    webSearchTimeoutMs()
  );

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error || `Brave Search returned ${response.status}.`);
  }

  const payload = await response.json();
  const results = Array.isArray(payload?.web?.results) ? payload.web.results : [];
  return results
    .map((entry) => ({
      title: String(entry?.title || "").trim(),
      url: normalizeSearchResultUrl(entry?.url || ""),
      snippet: String(entry?.description || entry?.snippet || "").trim()
    }))
    .filter((entry) => entry.title && entry.url)
    .slice(0, WEB_SEARCH_RESULT_LIMIT);
}

async function searchWebDuckDuckGo(query) {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  url.searchParams.set("kl", "us-en");
  url.searchParams.set("kp", "-1");

  const response = await fetchWithTimeout(
    url.toString(),
    {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (compatible; Hearthboard/1.0; +https://localhost)"
      }
    },
    webSearchTimeoutMs()
  );

  if (!response.ok) {
    throw new Error(`DuckDuckGo returned ${response.status}.`);
  }

  return parseDuckDuckGoResults(await response.text());
}

async function fetchWebPageContext(source) {
  if (!source?.url) {
    return null;
  }

  try {
    const response = await fetchWithTimeout(
      source.url,
      {
        headers: {
          Accept: "text/html,application/xhtml+xml"
        }
      },
      webSearchTimeoutMs()
    );

    if (!response.ok) {
      return null;
    }

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html")) {
      return null;
    }

    const html = await response.text();
    const text = stripHtml(html).slice(0, WEB_SEARCH_PAGE_CHAR_LIMIT);
    if (!text) {
      return null;
    }

    return {
      ...source,
      pageText: text
    };
  } catch {
    return null;
  }
}

async function gatherWebSearchContext(query) {
  const provider = BRAVE_SEARCH_API_KEY ? "brave" : "duckduckgo";
  const rawResults = provider === "brave" ? await searchWebBrave(query) : await searchWebDuckDuckGo(query);
  const sources = rawResults.slice(0, WEB_SEARCH_RESULT_LIMIT);
  const enrichedResults = await Promise.all(sources.slice(0, WEB_SEARCH_CONTEXT_LIMIT).map((source) => fetchWebPageContext(source)));
  const contextSources = [];

  sources.forEach((source, index) => {
    const enriched = enrichedResults[index] || null;
    contextSources.push({
      ...source,
      pageText: enriched?.pageText || ""
    });
  });

  return {
    provider,
    sources: contextSources
  };
}

function buildWebSearchPrompt(query, searchContext) {
  const sourceLines = searchContext.sources
    .map((source, index) => {
      const parts = [
        `[${index + 1}] ${source.title}`,
        `URL: ${source.url}`
      ];

      if (source.snippet) {
        parts.push(`Snippet: ${source.snippet}`);
      }

      if (source.pageText) {
        parts.push(`Page extract: ${source.pageText}`);
      }

      return parts.join("\n");
    })
    .join("\n\n");

  return [
    `Web search query: ${query}`,
    "Use these sources when relevant and cite them inline like [1] or [2].",
    sourceLines
  ].join("\n\n");
}

async function readAssistantRuntimeStatus() {
  const policy = localAiPolicy();
  try {
    const [tagsResponse, psResponse] = await Promise.all([
      fetchOllama("/api/tags"),
      fetchOllama("/api/ps").catch(() => null)
    ]);

    if (!tagsResponse.ok) {
      let errorMessage = `Ollama responded with ${tagsResponse.status}.`;
      try {
        const payload = await tagsResponse.json();
        if (payload?.error) {
          errorMessage = String(payload.error);
        }
      } catch {}

      return {
        name: JODY_AI_NAME,
        reachable: false,
        ready: false,
        configuredModel: OLLAMA_MODEL,
        fallbackModel: OLLAMA_FALLBACK_MODEL,
        activeModel: null,
        availableModels: [],
        runningModels: [],
        loaded: false,
        loadedModel: null,
        keepAlive: OLLAMA_KEEP_ALIVE,
        awakeKeepAlive: OLLAMA_AWAKE_KEEP_ALIVE,
        localAiAllowed: policy.allowed,
        localAiPolicy: policy,
        webSearch: webSearchStatus(),
        error: errorMessage
      };
    }

    const payload = await tagsResponse.json();
    const availableModels = extractOllamaModelNames(payload);
    const activeModel = availableModels.includes(OLLAMA_MODEL)
      ? OLLAMA_MODEL
      : availableModels.includes(OLLAMA_FALLBACK_MODEL)
        ? OLLAMA_FALLBACK_MODEL
        : null;
    let runningModels = [];

    if (psResponse?.ok) {
      const psPayload = await psResponse.json().catch(() => ({}));
      runningModels = extractRunningOllamaModels(psPayload);
    }

    const loadedModel =
      runningModels.find((entry) => entry.model === activeModel)?.model ||
      runningModels.find((entry) => entry.model === OLLAMA_MODEL)?.model ||
      runningModels.find((entry) => entry.model === OLLAMA_FALLBACK_MODEL)?.model ||
      null;

    return {
      name: JODY_AI_NAME,
      reachable: true,
      ready: Boolean(activeModel),
      configuredModel: OLLAMA_MODEL,
      fallbackModel: OLLAMA_FALLBACK_MODEL,
      activeModel,
      loaded: Boolean(loadedModel),
      loadedModel,
      availableModels,
      runningModels,
      keepAlive: OLLAMA_KEEP_ALIVE,
      awakeKeepAlive: OLLAMA_AWAKE_KEEP_ALIVE,
      localAiAllowed: policy.allowed,
      localAiPolicy: policy,
      webSearch: webSearchStatus(),
      error: activeModel ? null : `No compatible local model found yet. Run .\\scripts\\setup-hearthboard-ai.ps1 after installing Ollama.`
    };
  } catch (error) {
    return {
      name: JODY_AI_NAME,
      reachable: false,
      ready: false,
      configuredModel: OLLAMA_MODEL,
      fallbackModel: OLLAMA_FALLBACK_MODEL,
      activeModel: null,
      loaded: false,
      loadedModel: null,
      availableModels: [],
      runningModels: [],
      keepAlive: OLLAMA_KEEP_ALIVE,
      awakeKeepAlive: OLLAMA_AWAKE_KEEP_ALIVE,
      localAiAllowed: policy.allowed,
      localAiPolicy: policy,
      webSearch: webSearchStatus(),
      error: `Could not reach Ollama at ${OLLAMA_BASE_URL}.`
    };
  }
}

async function setAssistantPower(action, runtimeStatus) {
  if (action === "wake" && !localAiPolicy().allowed) {
    return {
      error: `${JODY_AI_NAME} is currently restricted on this PC.`,
      status: 423
    };
  }

  if (!runtimeStatus.reachable) {
    return { error: `${JODY_AI_NAME} is offline on this PC right now.`, status: 503 };
  }

  if (!runtimeStatus.activeModel) {
    return {
      error: `No compatible local model is installed yet. Run .\\scripts\\setup-hearthboard-ai.ps1 after the local runtime is installed.`,
      status: 503
    };
  }

  const keepAlive = action === "wake" ? OLLAMA_AWAKE_KEEP_ALIVE : 0;

  let response;
  try {
    response = await fetchOllama("/api/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: runtimeStatus.activeModel,
        prompt: "",
        stream: false,
        keep_alive: keepAlive
      })
    });
  } catch (error) {
    const isAbortError = error?.name === "AbortError";
    return {
      error: isAbortError ? `${JODY_AI_NAME} took too long to respond.` : `Could not reach ${JODY_AI_NAME} right now.`,
      status: isAbortError ? 504 : 503
    };
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      error: payload?.error || `${JODY_AI_NAME} could not change power state.`,
      status: response.status || 502
    };
  }

  return {
    ok: true,
    action,
    keepAlive,
    payload
  };
}

async function waitForAssistantLoadedState(expectedLoaded, timeoutMs = 4000, pollMs = 150) {
  const startedAt = Date.now();
  let latestStatus = await readAssistantRuntimeStatus();

  while (Date.now() - startedAt < timeoutMs) {
    if (Boolean(latestStatus.loaded) === expectedLoaded) {
      return latestStatus;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
    latestStatus = await readAssistantRuntimeStatus();
  }

  return latestStatus;
}

function normalizeVideoQuality(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["720p"].includes(normalized) ? normalized : null;
}

function isServableMediaExtension(extension) {
  const normalized = extension.toLowerCase();
  return (
    imageExtensions.has(normalized) ||
    videoExtensions.has(normalized) ||
    panoramaExtensions.has(normalized) ||
    rawExtensions.has(normalized) ||
    supportExtensions.has(normalized)
  );
}

function getMediaLibrary(libraryId) {
  return mediaLibraryMap.get(String(libraryId || "").trim()) || null;
}

function invalidateMediaLibraryCache(libraryId) {
  mediaIndexCache.delete(libraryId);
  pendingMediaIndexJobs.delete(libraryId);
}

function relativePathFromLibrary(library, absolutePath) {
  return path.relative(library.path, absolutePath).split(path.sep).join("/");
}

function isExcludedRelativePath(library, relativePath = "") {
  const normalizedRelativePath = String(relativePath || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalizedRelativePath) {
    return false;
  }

  return library.excludePaths.some((excludedPath) => normalizedRelativePath === excludedPath || normalizedRelativePath.startsWith(`${excludedPath}/`));
}

function resolveMediaPath(library, relativePath = "") {
  const requestedPath = String(relativePath || "").replaceAll("\\", "/");
  const segments = requestedPath
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  const resolved = path.resolve(library.path, ...segments);
  const relativeToRoot = path.relative(library.path, resolved);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    return null;
  }

  if (isExcludedRelativePath(library, relativeToRoot)) {
    return null;
  }

  return resolved;
}

const relativeMediaPath = relativePathFromLibrary;

function buildMediaUrl(libraryId, relativePath) {
  const encodedPath = relativePath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `/media/${encodeURIComponent(libraryId)}${encodedPath ? `/${encodedPath}` : ""}`;
}

function buildThumbnailUrl(libraryId, relativePath) {
  const encodedPath = relativePath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `/media-thumb/${encodeURIComponent(libraryId)}${encodedPath ? `/${encodedPath}` : ""}`;
}

function buildVideoVariantUrl(libraryId, quality, relativePath) {
  const encodedPath = relativePath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `/media-video/${encodeURIComponent(quality)}/${encodeURIComponent(libraryId)}${encodedPath ? `/${encodedPath}` : ""}`;
}

function thumbnailCachePath(library, relativePath, fileStat) {
  const hash = createHash("sha1")
    .update(`${library.id}:${relativePath}:${fileStat.size}:${fileStat.mtimeMs}`)
    .digest("hex");

  return path.join(THUMBNAIL_DIR, `${library.id}-${hash}.jpg`);
}

function videoVariantCachePath(library, relativePath, fileStat, quality) {
  const hash = createHash("sha1")
    .update(`${library.id}:${relativePath}:${quality}:${fileStat.size}:${fileStat.mtimeMs}`)
    .digest("hex");

  return path.join(VIDEO_PROXY_DIR, `${library.id}-${quality}-${hash}.mp4`);
}

async function fileExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function getMediaFileForRequest(library, relativePath = "") {
  const resolvedPath = resolveMediaPath(library, relativePath);
  if (!resolvedPath) {
    return { error: "Invalid media path.", status: 400 };
  }

  let fileStat;
  try {
    fileStat = await stat(resolvedPath);
  } catch {
    return { error: "Media file not found.", status: 404 };
  }

  if (!fileStat.isFile()) {
    return { error: "Media file not found.", status: 404 };
  }

  const mediaType = mediaTypeForExtension(path.extname(resolvedPath));
  return { resolvedPath, fileStat, mediaType };
}

function quarantineRelativePath(library, relativePath = "") {
  if (!library?.quarantinePath) {
    return null;
  }

  const requestedPath = String(relativePath || "").replaceAll("\\", "/");
  const segments = requestedPath
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  const resolved = path.resolve(library.quarantinePath, ...segments);
  const relativeToRoot = path.relative(library.quarantinePath, resolved);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    return null;
  }

  return resolved;
}

async function moveFilePreservingContents(sourcePath, destinationPath) {
  try {
    await rename(sourcePath, destinationPath);
    return;
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }
  }

  await copyFile(sourcePath, destinationPath);
  await unlink(sourcePath);
}

async function uniqueDestinationPath(destinationPath) {
  if (!(await fileExists(destinationPath))) {
    return destinationPath;
  }

  const directory = path.dirname(destinationPath);
  const extension = path.extname(destinationPath);
  const basename = path.basename(destinationPath, extension);
  let counter = 1;

  while (true) {
    const candidate = path.join(directory, `${basename}__quarantine_${counter}${extension}`);
    if (!(await fileExists(candidate))) {
      return candidate;
    }
    counter += 1;
  }
}

async function pruneEmptyDirectories(startDirectory, rootDirectory) {
  let currentDirectory = startDirectory;
  const normalizedRoot = path.resolve(rootDirectory);

  while (currentDirectory && path.resolve(currentDirectory).startsWith(normalizedRoot) && path.resolve(currentDirectory) !== normalizedRoot) {
    const entries = await readdir(currentDirectory).catch(() => null);
    if (!entries || entries.length > 0) {
      break;
    }

    await rm(currentDirectory).catch(() => {});
    currentDirectory = path.dirname(currentDirectory);
  }
}

async function quarantineMediaFile(library, relativePath) {
  const file = await getMediaFileForRequest(library, relativePath);
  if (file.error) {
    return file;
  }

  if (!library.quarantinePath) {
    return { error: "This library does not support quarantining media.", status: 400 };
  }

  const destinationBase = quarantineRelativePath(library, relativePath);
  if (!destinationBase) {
    return { error: "Invalid quarantine path.", status: 400 };
  }

  await mkdir(path.dirname(destinationBase), { recursive: true });
  const destinationPath = await uniqueDestinationPath(destinationBase);
  await moveFilePreservingContents(file.resolvedPath, destinationPath);
  await pruneEmptyDirectories(path.dirname(file.resolvedPath), library.path);
  invalidateMediaLibraryCache(library.id);

  return {
    ok: true,
    mediaType: file.mediaType,
    sourcePath: relativePath,
    quarantinedPath: path.relative(library.quarantinePath, destinationPath).split(path.sep).join("/")
  };
}

function runFfmpegThumbnail(inputPath, outputPath, mediaType) {
  const filter =
    mediaType === "video"
      ? "thumbnail=120,scale=1280:720:force_original_aspect_ratio=decrease"
      : "scale=1280:720:force_original_aspect_ratio=decrease";
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-vf",
      filter,
      "-frames:v",
      "1",
      "-q:v",
      "4",
      "-y",
      outputPath
    ];

    const process = spawn(FFMPEG_BIN, args, { stdio: "ignore" });
    process.once("error", reject);
    process.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

function runFfmpegVideoVariant(inputPath, outputPath, quality) {
  const videoScale = quality === "720p" ? "scale='min(1280,iw)':-2" : "scale=iw:ih";

  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-vf",
      videoScale,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "30",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-threads",
      "0",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-y",
      outputPath
    ];

    const process = spawn(FFMPEG_BIN, args, { stdio: "ignore" });
    process.once("error", reject);
    process.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

async function ensureMediaThumbnail(library, resolvedPath, relativePath, fileStat, mediaType) {
  const cachePath = thumbnailCachePath(library, relativePath, fileStat);
  if (await fileExists(cachePath)) {
    return cachePath;
  }

  if (pendingThumbnailJobs.has(cachePath)) {
    return pendingThumbnailJobs.get(cachePath);
  }

  const job = (async () => {
    const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp.jpg`;

    try {
      await runFfmpegThumbnail(resolvedPath, tempPath, mediaType);
      try {
        await rename(tempPath, cachePath);
      } catch {
        if (!(await fileExists(cachePath))) {
          throw new Error("Thumbnail cache move failed.");
        }
      }
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }

    return cachePath;
  })();

  pendingThumbnailJobs.set(cachePath, job);

  try {
    return await job;
  } finally {
    pendingThumbnailJobs.delete(cachePath);
  }
}

async function ensureVideoVariant(library, resolvedPath, relativePath, fileStat, quality) {
  const cachePath = videoVariantCachePath(library, relativePath, fileStat, quality);
  if (await fileExists(cachePath)) {
    return cachePath;
  }

  if (pendingVideoVariantJobs.has(cachePath)) {
    return pendingVideoVariantJobs.get(cachePath);
  }

  const job = (async () => {
    const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp.mp4`;

    try {
      await runFfmpegVideoVariant(resolvedPath, tempPath, quality);
      try {
        await rename(tempPath, cachePath);
      } catch {
        if (!(await fileExists(cachePath))) {
          throw new Error("Video proxy cache move failed.");
        }
      }
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }

    return cachePath;
  })();

  pendingVideoVariantJobs.set(cachePath, job);

  try {
    return await job;
  } finally {
    pendingVideoVariantJobs.delete(cachePath);
  }
}

function buildIndexedMediaEntry(library, fullPath, fileStat, mediaType, extension) {
  const relativePath = relativeMediaPath(library, fullPath);
  const lastSeparatorIndex = relativePath.lastIndexOf("/");
  const directoryPath = lastSeparatorIndex >= 0 ? relativePath.slice(0, lastSeparatorIndex) : "";

  return {
    name: path.basename(fullPath),
    path: relativePath,
    directoryPath,
    mediaType,
    extension,
    size: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
    modifiedTimeMs: fileStat.mtimeMs,
    url: buildMediaUrl(library.id, relativePath),
    thumbnailUrl: mediaType === "image" || mediaType === "video" ? buildThumbnailUrl(library.id, relativePath) : null,
    videoVariants:
      mediaType === "video"
        ? {
            original: buildMediaUrl(library.id, relativePath),
            p720: buildVideoVariantUrl(library.id, "720p", relativePath)
          }
        : null
  };
}

function enrichMediaEntry(library, entry) {
  const views = mediaViewStats(library.id, entry.path);
  return {
    ...entry,
    viewCount: views.viewCount,
    lastViewedAt: views.lastViewedAt
  };
}

async function buildMediaIndex(library) {
  const matches = [];
  const queue = [library.path];

  while (queue.length > 0) {
    const currentDirectory = queue.shift();
    const entries = await readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDirectory, entry.name);
      const relativePath = relativeMediaPath(library, fullPath);

      if (isExcludedRelativePath(library, relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name);
      const mediaType = mediaTypeForExtension(extension);
      if (mediaType === "other") {
        continue;
      }

      const fileStat = await stat(fullPath);
      matches.push(buildIndexedMediaEntry(library, fullPath, fileStat, mediaType, extension));
    }
  }

  matches.sort((left, right) => new Date(right.modifiedAt).getTime() - new Date(left.modifiedAt).getTime());
  return matches;
}

async function getMediaIndex(library) {
  const cached = mediaIndexCache.get(library.id);
  if (cached && Date.now() - cached.builtAt < MEDIA_INDEX_TTL_MS) {
    return cached.files;
  }

  if (pendingMediaIndexJobs.has(library.id)) {
    return pendingMediaIndexJobs.get(library.id);
  }

  const job = (async () => {
    const files = await buildMediaIndex(library);
    mediaIndexCache.set(library.id, { builtAt: Date.now(), files });
    return files;
  })();

  pendingMediaIndexJobs.set(library.id, job);

  try {
    return await job;
  } finally {
    pendingMediaIndexJobs.delete(library.id);
  }
}

function warmMediaIndexes() {
  for (const library of mediaLibraries) {
    getMediaIndex(library).catch(() => {});
  }
}

async function describeDirectory(library, directoryPath) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const directories = [];

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    const relativePath = relativeMediaPath(library, fullPath);

    if (isExcludedRelativePath(library, relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      directories.push({
        name: entry.name,
        path: relativePath
      });
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }
  }

  directories.sort((left, right) => left.name.localeCompare(right.name));
  return { directories };
}

async function collectMediaFiles(library, startPath, { query = "", type = "all" } = {}) {
  const indexedFiles = await getMediaIndex(library);
  const lowered = query.toLowerCase();
  const normalizedType = normalizeMediaTypeFilter(type);
  const relativeStartPath = relativeMediaPath(library, startPath);
  const scopedPrefix = relativeStartPath ? `${relativeStartPath}/` : "";

  return indexedFiles.filter((entry) => {
    if (scopedPrefix && !entry.path.startsWith(scopedPrefix)) {
      return false;
    }

    if (normalizedType !== "all" && entry.mediaType !== normalizedType) {
      return false;
    }

    if (lowered && !entry.path.toLowerCase().includes(lowered)) {
      return false;
    }

    return true;
  });
}

function paginateMedia(files, page, pageSize) {
  const totalMatches = files.length;
  const totalPages = totalMatches === 0 ? 1 : Math.ceil(totalMatches / pageSize);
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = startIndex + pageSize;

  return {
    files: files.slice(startIndex, endIndex),
    totalMatches,
    totalPages,
    currentPage,
    pageSize,
    hasPreviousPage: currentPage > 1,
    hasNextPage: currentPage < totalPages,
    startIndex,
    endIndex: Math.min(endIndex, totalMatches)
  };
}

function requestGuardForPath(request) {
  const requestPath = request.path || "/";
  if (isPublicRequestPath(requestPath)) {
    return null;
  }

  if (requestPath === "/account" || requestPath.startsWith("/api/account/")) {
    return {
      kind: "authenticated",
      message: "Sign in to open your account page."
    };
  }

  if (requestPath.startsWith("/api/mobile/")) {
    return {
      kind: "authenticated",
      message: "Sign in to sync mobile reminders."
    };
  }

  if (requestPath.startsWith("/api/admin/")) {
    return {
      kind: "admin",
      message: "Only the admin account can use this control."
    };
  }

  if (requestPath === "/assistant" || requestPath.startsWith("/api/assistant/")) {
    return {
      kind: "page",
      pageKey: "assistant",
      message: "You need access to Jody AI to open this page."
    };
  }

  if (requestPath === "/gallery") {
    return {
      kind: "page",
      pageKey: "gallery",
      message: "You need access to the gallery to open this page."
    };
  }

  if (
    requestPath === "/" ||
    requestPath.startsWith("/api/bootstrap") ||
    requestPath.startsWith("/api/members") ||
    requestPath.startsWith("/api/events") ||
    requestPath.startsWith("/api/bulletins")
  ) {
    return {
      kind: "page",
      pageKey: "calendar",
      message: "You need access to the calendar to open this page."
    };
  }

  if (request.method === "GET" && !requestPath.startsWith("/api/")) {
    return {
      kind: "page",
      pageKey: "calendar",
      message: "You need access to the calendar to open this page."
    };
  }

  return null;
}

function requestSatisfiesGuard(request, guard) {
  if (!guard) {
    return true;
  }

  if (guard.kind === "authenticated") {
    return requestIsAuthenticated(request);
  }

  if (guard.kind === "admin") {
    return requestIsAdmin(request);
  }

  return requestCanAccessPage(request, guard.pageKey);
}

app.use(express.json({ limit: "1mb" }));
app.use(async (request, response, next) => {
  try {
    await trackDeviceRequest(request, response);
  } catch {}

  const guard = requestGuardForPath(request);
  if (!guard) {
    return next();
  }

  if (requestSatisfiesGuard(request, guard)) {
    return next();
  }

  if (request.path.startsWith("/api/")) {
    const signedIn = requestIsAuthenticated(request);
    return response.status(signedIn ? 403 : 401).json({
      error: guard.message,
      requiresLogin: !signedIn,
      requiresAdmin: signedIn && guard.kind === "admin"
    });
  }

  const nextPath = `${request.path}${request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : ""}`;
  return response.redirect(loginRedirectUrl(request, nextPath));
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.json({ ok: true, service: "hearthboard" });
});

app.get("/api/session", (request, response) => {
  response.json({
    localNetwork: requestIsLan(request),
    localMachine: requestIsLocalMachine(request),
    canSelfRegister: requestCanSelfRegister(request),
    authenticated: requestIsAuthenticated(request),
    user: userSummary(authenticatedUser(request))
  });
});

app.post("/api/session/register", async (request, response) => {
  if (!requestCanSelfRegister(request)) {
    return response.status(403).json({
      error: "New account registration is only allowed from your local network."
    });
  }

  const rateLimit = authRateLimitStatus("register", request);
  if (rateLimit.limited) {
    response.setHeader("Retry-After", String(Math.ceil(rateLimit.retryAfterMs / 1000)));
    return response.status(429).json({ error: "Too many signup attempts. Try again in a few minutes." });
  }

  const username = normalizeUsername(request.body?.username);
  const password = String(request.body?.password || "").trim();
  const rememberMe = normalizeBoolean(request.body?.rememberMe);

  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return response.status(400).json({ error: "Choose a username with 3-32 letters, numbers, dots, dashes, or underscores." });
  }

  if (username === ADMIN_USERNAME) {
    return response.status(409).json({ error: "That username is reserved." });
  }

  if (findUserByUsername(username)) {
    return response.status(409).json({ error: "That username is already taken." });
  }

  if (password.length < 8) {
    recordAuthRateLimitFailure("register", request);
    return response.status(400).json({ error: "Choose a password with at least 8 characters." });
  }

  const user = {
    id: nanoid(),
    username,
    role: "user",
    permissionLevel: "default",
    approved: false,
    householdMember: false,
    email: "",
    phone: "",
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  users().push(user);
  synchronizeMembersWithUsers();
  await db.write();

  const sessionToken = await createAuthSession(user.id, { remembered: rememberMe });
  clearAuthRateLimit("register", request);
  setAuthCookie(request, response, sessionToken, rememberMe);
  return response.status(201).json({
    ok: true,
    user: userSummary(user)
  });
});

app.post("/api/session/login", async (request, response) => {
  const rateLimit = authRateLimitStatus("login", request);
  if (rateLimit.limited) {
    response.setHeader("Retry-After", String(Math.ceil(rateLimit.retryAfterMs / 1000)));
    return response.status(429).json({ error: "Too many login attempts. Try again in a few minutes." });
  }

  const username = normalizeUsername(request.body?.username);
  const password = String(request.body?.password || "");
  const rememberMe = normalizeBoolean(request.body?.rememberMe);
  const user = findUserByUsername(username);

  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    recordAuthRateLimitFailure("login", request);
    return response.status(401).json({ error: "That username and password did not match." });
  }

  const sessionToken = await createAuthSession(user.id, { remembered: rememberMe });
  clearAuthRateLimit("login", request);
  setAuthCookie(request, response, sessionToken, rememberMe);
  return response.json({
    ok: true,
    user: userSummary(user)
  });
});

app.post("/api/session/logout", async (request, response) => {
  await clearAuthSessionForRequest(request, response);
  return response.status(204).send();
});

app.get("/api/account", (request, response) => {
  const user = authenticatedUser(request);
  if (!user) {
    return response.status(401).json({ error: "Sign in to open your account page." });
  }

  response.json({
    user: userSummary(user),
    isAdmin: user.role === "admin",
    pageVisibility: user.role === "admin" ? Object.fromEntries(PAGE_KEYS.map((pageKey) => [pageKey, pageVisibility(pageKey)])) : null,
    libraryVisibility: user.role === "admin"
      ? Object.fromEntries(mediaLibraries.map((library) => [library.id, libraryVisibility(library)]))
      : null,
    devices: user.role === "admin"
      ? [...devices()]
          .sort((left, right) => new Date(right.lastSeenAt).getTime() - new Date(left.lastSeenAt).getTime())
      : null,
    users: user.role === "admin"
      ? users()
          .map((entry) => adminManagedUserSummary(entry))
          .sort((left, right) => {
            if (left.role !== right.role) {
              return left.role === "admin" ? -1 : 1;
            }

            if (left.pendingApproval !== right.pendingApproval) {
              return left.pendingApproval ? -1 : 1;
            }

            return left.username.localeCompare(right.username);
          })
      : null,
    libraries: mediaLibraries.map((library) => ({
      id: library.id,
      label: library.label,
      writable: Boolean(library.writable),
      visibility: libraryVisibility(library)
    }))
  });
});

app.patch("/api/account/profile", async (request, response) => {
  const user = authenticatedUser(request);
  if (!user) {
    return response.status(401).json({ error: "Sign in to update your profile." });
  }

  user.email = String(request.body?.email || "").trim();
  user.phone = String(request.body?.phone || "").trim();
  user.updatedAt = new Date().toISOString();
  await db.write();

  return response.json({
    ok: true,
    user: userSummary(user)
  });
});

app.patch("/api/account/password", async (request, response) => {
  const user = authenticatedUser(request);
  if (!user) {
    return response.status(401).json({ error: "Sign in to change your password." });
  }

  const currentPassword = String(request.body?.currentPassword || "");
  const nextPassword = String(request.body?.newPassword || "").trim();

  if (user.passwordHash && !verifyPassword(currentPassword, user.passwordHash)) {
    return response.status(401).json({ error: "Your current password did not match." });
  }

  if (nextPassword.length < 8) {
    return response.status(400).json({ error: "Choose a password with at least 8 characters." });
  }

  user.passwordHash = hashPassword(nextPassword);
  user.updatedAt = new Date().toISOString();

  if (user.username === ADMIN_USERNAME) {
    remoteAccessConfig().passwordHash = user.passwordHash;
  }

  await db.write();
  return response.json({ ok: true });
});

app.patch("/api/admin/visibility", async (request, response) => {
  if (!requestIsAdmin(request)) {
    return response.status(403).json({ error: "Only the admin account can change visibility settings." });
  }

  const nextPages = request.body?.pageVisibility;
  const nextLibraries = request.body?.libraryVisibility;

  if (nextPages && typeof nextPages === "object") {
    for (const pageKey of PAGE_KEYS) {
      db.data.security.pageVisibility[pageKey] = clampVisibilityRule(
        nextPages[pageKey],
        defaultPageVisibility()[pageKey]
      );
    }
  }

  if (nextLibraries && typeof nextLibraries === "object") {
    for (const library of mediaLibraries) {
      db.data.security.libraryVisibility[library.id] = normalizeVisibilityRule(
        nextLibraries[library.id],
        libraryVisibility(library)
      );
    }
  }

  await db.write();
  return response.json({
    ok: true,
    pageVisibility: Object.fromEntries(PAGE_KEYS.map((pageKey) => [pageKey, pageVisibility(pageKey)])),
    libraryVisibility: Object.fromEntries(mediaLibraries.map((library) => [library.id, libraryVisibility(library)]))
  });
});

app.patch("/api/admin/users/:userId", async (request, response) => {
  if (!requestIsAdmin(request)) {
    return response.status(403).json({ error: "Only the admin account can manage users." });
  }

  const targetUser = userById(request.params.userId);
  if (!targetUser) {
    return response.status(404).json({ error: "User not found." });
  }

  if (targetUser.role === "admin") {
    return response.status(400).json({ error: "The admin account is managed separately." });
  }

  const requestedPermission = String(request.body?.permissionLevel || targetUser.permissionLevel || "default").trim().toLowerCase();
  if (!["default", "trusted", "family"].includes(requestedPermission)) {
    return response.status(400).json({ error: "Permission level must be default, trusted friend, or family." });
  }

  targetUser.permissionLevel = requestedPermission;
  targetUser.approved = normalizeBoolean(request.body?.approved);
  targetUser.householdMember = requestedPermission === "family"
    ? true
    : normalizeBoolean(request.body?.householdMember);
  targetUser.updatedAt = new Date().toISOString();

  synchronizeMembersWithUsers();
  await db.write();

  return response.json({
    ok: true,
    user: adminManagedUserSummary(targetUser)
  });
});

app.get("/api/auth/status", (request, response) => {
  response.json({
    localNetwork: requestIsLan(request),
    localMachine: requestIsLocalMachine(request),
    authenticated: requestIsAuthenticated(request),
    user: userSummary(authenticatedUser(request)),
    passwordConfigured: passwordConfigured(),
    protectedPages: remoteAccessConfig().protectedPages
  });
});

app.post("/api/auth/login", async (request, response) => {
  const rateLimit = authRateLimitStatus("admin-login", request);
  if (rateLimit.limited) {
    response.setHeader("Retry-After", String(Math.ceil(rateLimit.retryAfterMs / 1000)));
    return response.status(429).json({ error: "Too many login attempts. Try again in a few minutes." });
  }

  const user = adminUserAccount();
  const password = String(request.body?.password || "");
  const rememberMe = normalizeBoolean(request.body?.rememberMe);
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    recordAuthRateLimitFailure("admin-login", request);
    return response.status(401).json({ error: "That password did not match." });
  }

  const sessionToken = await createAuthSession(user.id, { remembered: rememberMe });
  clearAuthRateLimit("admin-login", request);
  setAuthCookie(request, response, sessionToken, rememberMe);
  return response.json({
    ok: true,
    user: userSummary(user)
  });
});

app.post("/api/auth/logout", async (request, response) => {
  await clearAuthSessionForRequest(request, response);
  return response.status(204).send();
});

app.post("/api/auth/password", async (request, response) => {
  if (!requestIsLocalMachine(request)) {
    return response.status(403).json({ error: "This password can only be configured from this machine." });
  }

  const password = String(request.body?.password || "").trim();
  if (password.length < 8) {
    return response.status(400).json({ error: "Choose a password with at least 8 characters." });
  }

  const admin = adminUserAccount();
  admin.passwordHash = hashPassword(password);
  admin.updatedAt = new Date().toISOString();
  remoteAccessConfig().passwordHash = admin.passwordHash;
  await db.write();
  return response.json({ ok: true });
});

app.get("/api/bootstrap", (request, response) => {
  response.json(snapshot(request));
});

app.get("/api/mobile/reminders", (request, response) => {
  const user = authenticatedUser(request);
  if (!user) {
    return response.status(401).json({ error: "Sign in to sync mobile reminders." });
  }

  response.json({
    generatedAt: new Date().toISOString(),
    user: notificationTargetSummary(user),
    reminders: upcomingReminderEntriesForUser(user)
  });
});

app.get("/api/media/libraries", (request, response) => {
  const accessibleLibraries = accessibleMediaLibrariesForRequest(request);
  response.json({
    libraries: accessibleLibraries.map((library) => mediaLibrarySummaryForRequest(request, library)),
    authenticated: requestIsAuthenticated(request),
    user: userSummary(authenticatedUser(request)),
    lockedLibraryCount: Math.max(mediaLibraries.length - accessibleLibraries.length, 0)
  });
});

app.get("/api/media/browse", async (request, response) => {
  const library = getMediaLibrary(request.query.library);
  if (!library) {
    return response.status(404).json({ error: "Media library not found." });
  }

  if (!ensureMediaLibraryAccess(request, response, library)) {
    return;
  }

  const requestedPath = String(request.query.path || "");
  const resolvedPath = resolveMediaPath(library, requestedPath);
  if (!resolvedPath) {
    return response.status(400).json({ error: "Invalid media path." });
  }

  const mediaType = normalizeMediaTypeFilter(request.query.type);
  const page = normalizePageNumber(request.query.page);
  const pageSize = normalizePageSize(request.query.pageSize);
  let directoryStat;
  try {
    directoryStat = await stat(resolvedPath);
  } catch {
    return response.status(404).json({ error: "Folder not found." });
  }

  if (!directoryStat.isDirectory()) {
    return response.status(400).json({ error: "Requested path is not a folder." });
  }

  const listing = await describeDirectory(library, resolvedPath);
  const collectedFiles = await collectMediaFiles(library, resolvedPath, { type: mediaType });
  const paginatedFiles = paginateMedia(collectedFiles, page, pageSize);
  const relativePath = relativeMediaPath(library, resolvedPath);
  const breadcrumbSegments = relativePath ? relativePath.split("/") : [];
  const breadcrumbs = [{ name: library.label, path: "" }];

  for (let index = 0; index < breadcrumbSegments.length; index += 1) {
    breadcrumbs.push({
      name: breadcrumbSegments[index],
      path: breadcrumbSegments.slice(0, index + 1).join("/")
    });
  }

  return response.json({
    library: mediaLibrarySummaryForRequest(request, library),
    currentPath: relativePath,
    mediaType,
    breadcrumbs,
    directories: listing.directories,
    files: paginatedFiles.files.map((entry) => enrichMediaEntry(library, entry)),
    pagination: {
      currentPage: paginatedFiles.currentPage,
      pageSize: paginatedFiles.pageSize,
      totalPages: paginatedFiles.totalPages,
      totalMatches: paginatedFiles.totalMatches,
      hasPreviousPage: paginatedFiles.hasPreviousPage,
      hasNextPage: paginatedFiles.hasNextPage,
      startIndex: paginatedFiles.startIndex,
      endIndex: paginatedFiles.endIndex
    }
  });
});

app.get("/api/media/search", async (request, response) => {
  const library = getMediaLibrary(request.query.library);
  if (!library) {
    return response.status(404).json({ error: "Media library not found." });
  }

  if (!ensureMediaLibraryAccess(request, response, library)) {
    return;
  }

  const query = String(request.query.q || "").trim();
  const mediaType = normalizeMediaTypeFilter(request.query.type);
  const page = normalizePageNumber(request.query.page);
  const pageSize = normalizePageSize(request.query.pageSize);
  const requestedPath = String(request.query.path || "");
  const resolvedPath = resolveMediaPath(library, requestedPath);
  if (!resolvedPath) {
    return response.status(400).json({ error: "Invalid media path." });
  }

  const results = await collectMediaFiles(library, resolvedPath, { query, type: mediaType });
  const paginatedResults = paginateMedia(results, page, pageSize);
  return response.json({
    library: mediaLibrarySummaryForRequest(request, library),
    query,
    currentPath: relativeMediaPath(library, resolvedPath),
    mediaType,
    results: paginatedResults.files.map((entry) => enrichMediaEntry(library, entry)),
    pagination: {
      currentPage: paginatedResults.currentPage,
      pageSize: paginatedResults.pageSize,
      totalPages: paginatedResults.totalPages,
      totalMatches: paginatedResults.totalMatches,
      hasPreviousPage: paginatedResults.hasPreviousPage,
      hasNextPage: paginatedResults.hasNextPage,
      startIndex: paginatedResults.startIndex,
      endIndex: paginatedResults.endIndex
    }
  });
});

app.post("/api/media/view", async (request, response) => {
  const library = getMediaLibrary(request.body?.library);
  if (!library) {
    return response.status(404).json({ error: "Media library not found." });
  }

  if (!ensureMediaLibraryAccess(request, response, library)) {
    return;
  }

  const relativePath = String(request.body?.path || "");
  const resolvedPath = resolveMediaPath(library, relativePath);
  if (!resolvedPath) {
    return response.status(400).json({ error: "Invalid media path." });
  }

  let fileStat;
  try {
    fileStat = await stat(resolvedPath);
  } catch {
    return response.status(404).json({ error: "Media file not found." });
  }

  if (!fileStat.isFile()) {
    return response.status(404).json({ error: "Media file not found." });
  }

  const next = upsertMediaView(library.id, relativeMediaPath(library, resolvedPath));
  await db.write();
  return response.json({
    ok: true,
    viewCount: next.viewCount,
    lastViewedAt: next.lastViewedAt
  });
});

app.get("/api/local-ai/status", async (request, response) => {
  if (!requestIsLocalMachine(request)) {
    return response.status(403).json({ error: "This control is only available from this PC." });
  }

  response.json(await readAssistantRuntimeStatus());
});

app.post("/api/local-ai/policy", async (request, response) => {
  if (!requestIsLocalMachine(request)) {
    return response.status(403).json({ error: "This control is only available from this PC." });
  }

  const allowed = normalizeBoolean(request.body?.allowed);
  const policy = await updateLocalAiPolicy(allowed, "local-tray");
  let status = await readAssistantRuntimeStatus();

  if (!policy.allowed && status.loaded) {
    const sleepResult = await setAssistantPower("sleep", status);
    if (sleepResult.ok) {
      status = await waitForAssistantLoadedState(false);
    } else {
      status = await readAssistantRuntimeStatus();
    }
  }

  return response.json({
    ok: true,
    policy,
    status
  });
});

app.get("/api/assistant/status", async (_request, response) => {
  response.json(await readAssistantRuntimeStatus());
});

app.post("/api/assistant/power", async (request, response) => {
  const action = String(request.body?.action || "").trim().toLowerCase();
  if (!["wake", "sleep"].includes(action)) {
    return response.status(400).json({ error: "Power action must be wake or sleep." });
  }

  const runtimeStatus = await readAssistantRuntimeStatus();
  const result = await setAssistantPower(action, runtimeStatus);
  if (!result.ok) {
    return response.status(result.status || 500).json({ error: result.error });
  }

  const updatedStatus = await waitForAssistantLoadedState(action === "wake");
  return response.json({
    ok: true,
    action,
    status: updatedStatus
  });
});

app.post("/api/assistant/chat", async (request, response) => {
  const messages = normalizeAssistantMessages(request.body);
  const useWeb = normalizeBoolean(request.body?.useWeb);
  if (messages.length === 0) {
    return response.status(400).json({ error: "Ask the assistant something first." });
  }

  const runtimeStatus = await readAssistantRuntimeStatus();
  if (!runtimeStatus.localAiAllowed) {
    return response.status(423).json({
      error: "Jody AI is currently restricted on this PC."
    });
  }

  if (!runtimeStatus.reachable) {
    return response.status(503).json({
      error: runtimeStatus.error || "Local AI runtime is not reachable right now."
    });
  }

  if (!runtimeStatus.activeModel) {
    return response.status(503).json({
      error: "No compatible local model is installed yet. Run .\\scripts\\setup-hearthboard-ai.ps1 after Ollama is installed."
    });
  }

  const systemMessages = [];
  if (runtimeStatus.activeModel !== OLLAMA_MODEL) {
    systemMessages.push({ role: "system", content: ASSISTANT_SYSTEM_PROMPT });
  }

  let sources = [];
  if (useWeb) {
    const query = latestUserMessage(messages);
    try {
      const searchContext = await gatherWebSearchContext(query);
      sources = searchContext.sources.map(({ title, url, snippet }) => ({ title, url, snippet }));
      systemMessages.push({ role: "system", content: WEB_SEARCH_SYSTEM_PROMPT });
      systemMessages.push({ role: "system", content: buildWebSearchPrompt(query, searchContext) });
    } catch (error) {
      return response.status(502).json({
        error: `Web search failed: ${error.message}`
      });
    }
  }

  const outboundMessages = [...systemMessages, ...messages];
  const keepAlive = runtimeStatus.loaded ? runtimeStatus.awakeKeepAlive || OLLAMA_AWAKE_KEEP_ALIVE : OLLAMA_KEEP_ALIVE;

  let ollamaResponse;
  try {
    ollamaResponse = await fetchOllama("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: runtimeStatus.activeModel,
        stream: false,
        keep_alive: keepAlive,
        messages: outboundMessages
      })
    });
  } catch (error) {
    const isAbortError = error?.name === "AbortError";
    return response.status(isAbortError ? 504 : 503).json({
      error: isAbortError
        ? "The local model took too long to answer."
        : "Could not reach the local AI runtime."
    });
  }

  const payload = await ollamaResponse.json().catch(() => ({}));
  if (!ollamaResponse.ok) {
    return response.status(ollamaResponse.status || 502).json({
      error: payload?.error || "The local AI runtime returned an error."
    });
  }

  return response.json({
    activeModel: runtimeStatus.activeModel,
    configuredModel: runtimeStatus.configuredModel,
    keepAlive,
    usedWebSearch: useWeb,
    sources,
    message: {
      role: payload?.message?.role || "assistant",
      content: String(payload?.message?.content || "").trim()
    },
    done: Boolean(payload?.done),
    doneReason: payload?.done_reason || null,
    totalDuration: payload?.total_duration || null,
    loadDuration: payload?.load_duration || null
  });
});

app.post("/api/members", async (request, response) => {
  return response.status(403).json({ error: "Household roster entries are tied to accounts now. Create a user account instead." });
});

app.patch("/api/members/:memberId", async (request, response) => {
  return response.status(403).json({ error: "Household roster entries are tied to accounts now." });
});

app.delete("/api/members/:memberId", async (request, response) => {
  return response.status(403).json({ error: "Household roster entries are tied to accounts now." });
});

app.post("/api/events", async (request, response) => {
  const result = normalizeEventPayload(request.body);
  if (result.error) {
    return response.status(400).json({ error: result.error });
  }

  db.data.events.push(result.data);
  await db.write();
  return response.status(201).json(result.data);
});

app.patch("/api/events/:eventId", async (request, response) => {
  const event = db.data.events.find((entry) => entry.id === request.params.eventId);
  if (!event) {
    return response.status(404).json({ error: "Event not found." });
  }

  const result = normalizeEventPayload(request.body, event);
  if (result.error) {
    return response.status(400).json({ error: result.error });
  }

  Object.assign(event, result.data);
  await db.write();
  return response.json(event);
});

app.delete("/api/events/:eventId", async (request, response) => {
  const originalLength = db.data.events.length;
  db.data.events = db.data.events.filter((event) => event.id !== request.params.eventId);
  if (db.data.events.length === originalLength) {
    return response.status(404).json({ error: "Event not found." });
  }

  await db.write();
  return response.status(204).send();
});

app.post("/api/bulletins", async (request, response) => {
  const result = normalizeBulletinPayload(request.body);
  if (result.error) {
    return response.status(400).json({ error: result.error });
  }

  db.data.bulletins.push(result.data);
  await db.write();
  return response.status(201).json(result.data);
});

app.patch("/api/bulletins/:bulletinId", async (request, response) => {
  const bulletin = db.data.bulletins.find((entry) => entry.id === request.params.bulletinId);
  if (!bulletin) {
    return response.status(404).json({ error: "Bulletin not found." });
  }

  const result = normalizeBulletinPayload(request.body, bulletin);
  if (result.error) {
    return response.status(400).json({ error: result.error });
  }

  Object.assign(bulletin, result.data);
  await db.write();
  return response.json(bulletin);
});

app.delete("/api/bulletins/:bulletinId", async (request, response) => {
  const originalLength = db.data.bulletins.length;
  db.data.bulletins = db.data.bulletins.filter((bulletin) => bulletin.id !== request.params.bulletinId);
  if (db.data.bulletins.length === originalLength) {
    return response.status(404).json({ error: "Bulletin not found." });
  }

  await db.write();
  return response.status(204).send();
});

app.get("/api/media/video-proxy-status", async (request, response) => {
  const library = getMediaLibrary(request.query.library);
  if (!library) {
    return response.status(404).json({ error: "Media library not found." });
  }

  if (!ensureMediaLibraryAccess(request, response, library)) {
    return;
  }

  const quality = normalizeVideoQuality(request.query.quality);
  if (!quality) {
    return response.status(400).json({ error: "Unsupported video quality." });
  }

  const relativePath = String(request.query.path || "");
  const file = await getMediaFileForRequest(library, relativePath);
  if (file.error) {
    return response.status(file.status).json({ error: file.error });
  }

  if (file.mediaType !== "video") {
    return response.status(400).json({ error: "Requested media is not a video." });
  }

  const cachePath = videoVariantCachePath(library, relativePath, file.fileStat, quality);
  return response.json({
    quality,
    ready: await fileExists(cachePath),
    url: buildVideoVariantUrl(library.id, quality, relativePath)
  });
});

app.post("/api/media/video-proxy", async (request, response) => {
  const library = getMediaLibrary(request.body?.library);
  if (!library) {
    return response.status(404).json({ error: "Media library not found." });
  }

  if (!ensureMediaLibraryAccess(request, response, library)) {
    return;
  }

  const quality = normalizeVideoQuality(request.body?.quality);
  if (!quality) {
    return response.status(400).json({ error: "Unsupported video quality." });
  }

  const relativePath = String(request.body?.path || "");
  const file = await getMediaFileForRequest(library, relativePath);
  if (file.error) {
    return response.status(file.status).json({ error: file.error });
  }

  if (file.mediaType !== "video") {
    return response.status(400).json({ error: "Requested media is not a video." });
  }

  const cachePath = videoVariantCachePath(library, relativePath, file.fileStat, quality);
  const ready = await fileExists(cachePath);

  if (!ready) {
    ensureVideoVariant(library, file.resolvedPath, relativePath, file.fileStat, quality).catch(() => {});
  }

  return response.status(ready ? 200 : 202).json({
    quality,
    ready,
    url: buildVideoVariantUrl(library.id, quality, relativePath)
  });
});

app.post("/api/media/quarantine", async (request, response) => {
  if (!requestIsAdmin(request)) {
    return response.status(requestIsAuthenticated(request) ? 403 : 401).json({
      error: requestIsAuthenticated(request)
        ? "Only the admin account can quarantine media."
        : "Sign in as the admin account before quarantining media.",
      requiresLogin: !requestIsAuthenticated(request),
      requiresAdmin: requestIsAuthenticated(request)
    });
  }

  const library = getMediaLibrary(request.body?.library);
  if (!library) {
    return response.status(404).json({ error: "Media library not found." });
  }

  if (!requestCanAccessMediaLibrary(request, library)) {
    return response.status(403).json({ error: "You do not have access to that gallery." });
  }

  if (!requestCanQuarantineLibrary(request, library)) {
    return response.status(403).json({ error: "This library does not support admin quarantine actions." });
  }

  const relativePath = String(request.body?.path || "");
  const result = await quarantineMediaFile(library, relativePath);
  if (result.error) {
    return response.status(result.status || 400).json({ error: result.error });
  }

  return response.json(result);
});

app.post("/api/media/move", async (request, response) => {
  if (!requestIsAdmin(request)) {
    return response.status(requestIsAuthenticated(request) ? 403 : 401).json({
      error: requestIsAuthenticated(request)
        ? "Only the admin account can move media between galleries."
        : "Sign in as the admin account before moving media.",
      requiresLogin: !requestIsAuthenticated(request),
      requiresAdmin: requestIsAuthenticated(request)
    });
  }

  const sourceLibrary = getMediaLibrary(request.body?.sourceLibrary);
  const targetLibrary = getMediaLibrary(request.body?.targetLibrary);
  if (!sourceLibrary || !targetLibrary) {
    return response.status(404).json({ error: "Source or destination gallery was not found." });
  }

  if (!requestCanAccessMediaLibrary(request, sourceLibrary) || !requestCanAccessMediaLibrary(request, targetLibrary)) {
    return response.status(403).json({ error: "You do not have access to one of those galleries." });
  }

  if (!sourceLibrary.writable || !targetLibrary.writable) {
    return response.status(400).json({ error: "Both galleries must be writable before media can be moved between them." });
  }

  if (sourceLibrary.id === targetLibrary.id) {
    return response.status(400).json({ error: "Choose a different destination gallery." });
  }

  const relativePath = String(request.body?.path || "");
  const file = await getMediaFileForRequest(sourceLibrary, relativePath);
  if (file.error) {
    return response.status(file.status).json({ error: file.error });
  }

  const destinationBase = resolveMediaPath(targetLibrary, relativePath);
  if (!destinationBase) {
    return response.status(400).json({ error: "The destination path is not valid." });
  }

  await mkdir(path.dirname(destinationBase), { recursive: true });
  const destinationPath = await uniqueDestinationPath(destinationBase);
  await moveFilePreservingContents(file.resolvedPath, destinationPath);
  await pruneEmptyDirectories(path.dirname(file.resolvedPath), sourceLibrary.path);
  invalidateMediaLibraryCache(sourceLibrary.id);
  invalidateMediaLibraryCache(targetLibrary.id);

  return response.json({
    ok: true,
    sourceLibrary: sourceLibrary.id,
    targetLibrary: targetLibrary.id,
    sourcePath: relativePath,
    targetPath: path.relative(targetLibrary.path, destinationPath).split(path.sep).join("/")
  });
});

app.get(/^\/media\/([^/]+)(?:\/(.*))?$/, async (request, response) => {
  const library = getMediaLibrary(request.params[0]);
  if (!library) {
    return response.status(404).send("Media library not found.");
  }

  if (!ensureMediaLibraryAccess(request, response, library)) {
    return;
  }

  const resolvedPath = resolveMediaPath(library, request.params[1] || "");
  if (!resolvedPath) {
    return response.status(400).send("Invalid media path.");
  }

  let fileStat;
  try {
    fileStat = await stat(resolvedPath);
  } catch {
    return response.status(404).send("Media file not found.");
  }

  if (!fileStat.isFile()) {
    return response.status(404).send("Media file not found.");
  }

  const mediaType = mediaTypeForExtension(path.extname(resolvedPath));
  if (!isServableMediaExtension(path.extname(resolvedPath))) {
    return response.status(403).send("File type is not exposed.");
  }

  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "private, max-age=3600");
  if (mediaType === "panorama") {
    response.setHeader("Content-Security-Policy", "default-src 'self' data: blob: https:; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; frame-ancestors 'self'; sandbox allow-scripts allow-same-origin");
  }

  return response.sendFile(resolvedPath);
});

app.get(/^\/media-thumb\/([^/]+)(?:\/(.*))?$/, async (request, response) => {
  const library = getMediaLibrary(request.params[0]);
  if (!library) {
    return response.status(404).send("Media library not found.");
  }

  if (!ensureMediaLibraryAccess(request, response, library)) {
    return;
  }

  const relativePath = request.params[1] || "";
  const resolvedPath = resolveMediaPath(library, relativePath);
  if (!resolvedPath) {
    return response.status(400).send("Invalid media path.");
  }

  let fileStat;
  try {
    fileStat = await stat(resolvedPath);
  } catch {
    return response.status(404).send("Media file not found.");
  }

  if (!fileStat.isFile()) {
    return response.status(404).send("Media thumbnail not found.");
  }

  const mediaType = mediaTypeForExtension(path.extname(resolvedPath));
  if (!["image", "video"].includes(mediaType)) {
    return response.status(404).send("Media thumbnail not found.");
  }

  let cachePath;
  try {
    cachePath = await ensureMediaThumbnail(library, resolvedPath, relativePath, fileStat, mediaType);
  } catch {
    return response.status(503).send("Media thumbnails are not available right now.");
  }

  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "private, max-age=86400");
  response.type("image/jpeg");
  return response.sendFile(cachePath);
});

app.get(/^\/media-video\/([^/]+)\/([^/]+)(?:\/(.*))?$/, async (request, response) => {
  const quality = String(request.params[0] || "").trim().toLowerCase();
  if (!["720p"].includes(quality)) {
    return response.status(404).send("Video quality not found.");
  }

  const library = getMediaLibrary(request.params[1]);
  if (!library) {
    return response.status(404).send("Media library not found.");
  }

  if (!ensureMediaLibraryAccess(request, response, library)) {
    return;
  }

  const relativePath = request.params[2] || "";
  const file = await getMediaFileForRequest(library, relativePath);
  if (file.error) {
    return response.status(file.status).send(file.error);
  }

  if (file.mediaType !== "video") {
    return response.status(404).send("Video variant not found.");
  }

  let cachePath;
  try {
    cachePath = await ensureVideoVariant(library, file.resolvedPath, relativePath, file.fileStat, quality);
  } catch {
    return response.status(503).send("Video proxy is not available right now.");
  }

  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "private, max-age=86400");
  response.type("video/mp4");
  return response.sendFile(cachePath);
});

app.get("/gallery", (_request, response) => {
  response.sendFile(path.join(__dirname, "public", "gallery.html"));
});

app.get("/login", (_request, response) => {
  response.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/access", (request, response) => {
  const nextPath = String(request.query?.next || "/");
  response.redirect(loginRedirectUrl(request, nextPath));
});

app.get("/assistant", (_request, response) => {
  response.sendFile(path.join(__dirname, "public", "assistant.html"));
});

app.get("/account", (_request, response) => {
  response.sendFile(path.join(__dirname, "public", "account.html"));
});

app.use((request, response, next) => {
  if (request.path.startsWith("/api/") || request.method !== "GET") {
    return next();
  }

  return response.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, HOST, () => {
  console.log(`Hearthboard is running on http://${HOST}:${PORT}`);
  warmMediaIndexes();
});
