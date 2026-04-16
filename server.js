import express from "express";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
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
const OLLAMA_TIMEOUT_MS = Number.parseInt(String(process.env.OLLAMA_TIMEOUT_MS || "120000"), 10);
const JODY_AI_NAME = String(process.env.JODY_AI_NAME || "Jody AI").trim() || "Jody AI";
const ASSISTANT_MAX_MESSAGES = 12;
const ASSISTANT_MAX_MESSAGE_LENGTH = 4000;
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
    return [{ id: "drone", label: "Drone pictures", path: "E:\\Drone", excludePaths: [] }];
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
    bulletins: []
  };
}

await mkdir(DATA_DIR, { recursive: true });
await mkdir(THUMBNAIL_DIR, { recursive: true });
await mkdir(VIDEO_PROXY_DIR, { recursive: true });
const db = await JSONFilePreset(DB_FILE, defaultData());
const pendingThumbnailJobs = new Map();
const pendingVideoVariantJobs = new Map();
const mediaIndexCache = new Map();
const pendingMediaIndexJobs = new Map();

if (!Array.isArray(db.data.bulletins)) {
  db.data.bulletins = [];
  await db.write();
}

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

function normalizeMemberPayload(payload, existingMember = null) {
  const name = String(payload.name || "").trim();
  const role = String(payload.role || "").trim();
  const color = String(payload.color || existingMember?.color || palette[db.data.members.length % palette.length]).trim();

  if (!name) {
    return { error: "Member name is required." };
  }

  return {
    data: {
      id: existingMember?.id || nanoid(),
      name,
      role,
      color
    }
  };
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

  if (!title) {
    return { error: "Event title is required." };
  }

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { error: "Start and end times must be valid." };
  }

  if (end.getTime() < start.getTime()) {
    return { error: "Event end time must be after the start time." };
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

function snapshot() {
  return {
    householdName: db.data.householdName,
    timezone: db.data.timezone,
    members: db.data.members,
    events: sortEvents(db.data.events),
    bulletins: sortBulletins(db.data.bulletins),
    mediaLibraries: mediaLibraries.map((library) => ({ id: library.id, label: library.label }))
  };
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

function assistantTimeoutMs() {
  if (!Number.isFinite(OLLAMA_TIMEOUT_MS) || OLLAMA_TIMEOUT_MS < 1000) {
    return 120000;
  }

  return OLLAMA_TIMEOUT_MS;
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

async function readAssistantRuntimeStatus() {
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
      error: `Could not reach Ollama at ${OLLAMA_BASE_URL}.`
    };
  }
}

async function setAssistantPower(action, runtimeStatus) {
  if (!runtimeStatus.reachable) {
    return { error: `${JODY_AI_NAME} is offline on this PC right now.`, status: 503 };
  }

  if (!runtimeStatus.activeModel) {
    return {
      error: `No compatible local model is installed yet. Run .\\scripts\\setup-hearthboard-ai.ps1 after the local runtime is installed.`,
      status: 503
    };
  }

  const keepAlive = action === "wake" ? -1 : 0;

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

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "hearthboard" });
});

app.get("/api/bootstrap", (_request, response) => {
  response.json(snapshot());
});

app.get("/api/media/libraries", (_request, response) => {
  response.json({
    libraries: mediaLibraries.map((library) => ({ id: library.id, label: library.label }))
  });
});

app.get("/api/media/browse", async (request, response) => {
  const library = getMediaLibrary(request.query.library);
  if (!library) {
    return response.status(404).json({ error: "Media library not found." });
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
    library: { id: library.id, label: library.label },
    currentPath: relativePath,
    mediaType,
    breadcrumbs,
    directories: listing.directories,
    files: paginatedFiles.files,
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
    library: { id: library.id, label: library.label },
    query,
    currentPath: relativeMediaPath(library, resolvedPath),
    mediaType,
    results: paginatedResults.files,
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

  const updatedStatus = await readAssistantRuntimeStatus();
  return response.json({
    ok: true,
    action,
    status: updatedStatus
  });
});

app.post("/api/assistant/chat", async (request, response) => {
  const messages = normalizeAssistantMessages(request.body);
  if (messages.length === 0) {
    return response.status(400).json({ error: "Ask the assistant something first." });
  }

  const runtimeStatus = await readAssistantRuntimeStatus();
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

  const outboundMessages =
    runtimeStatus.activeModel === OLLAMA_MODEL
      ? messages
      : [{ role: "system", content: ASSISTANT_SYSTEM_PROMPT }, ...messages];
  const keepAlive = runtimeStatus.loaded ? -1 : OLLAMA_KEEP_ALIVE;

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
  const result = normalizeMemberPayload(request.body);
  if (result.error) {
    return response.status(400).json({ error: result.error });
  }

  db.data.members.push(result.data);
  await db.write();
  return response.status(201).json(result.data);
});

app.patch("/api/members/:memberId", async (request, response) => {
  const member = db.data.members.find((entry) => entry.id === request.params.memberId);
  if (!member) {
    return response.status(404).json({ error: "Member not found." });
  }

  const result = normalizeMemberPayload(request.body, member);
  if (result.error) {
    return response.status(400).json({ error: result.error });
  }

  Object.assign(member, result.data);
  await db.write();
  return response.json(member);
});

app.delete("/api/members/:memberId", async (request, response) => {
  const hasAssignments = db.data.events.some((event) => event.memberIds.includes(request.params.memberId));
  if (hasAssignments) {
    return response.status(409).json({ error: "Remove this member from scheduled events before deleting them." });
  }

  const originalLength = db.data.members.length;
  db.data.members = db.data.members.filter((member) => member.id !== request.params.memberId);
  if (db.data.members.length === originalLength) {
    return response.status(404).json({ error: "Member not found." });
  }

  await db.write();
  return response.status(204).send();
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

app.get(/^\/media\/([^/]+)(?:\/(.*))?$/, async (request, response) => {
  const library = getMediaLibrary(request.params[0]);
  if (!library) {
    return response.status(404).send("Media library not found.");
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

app.get("/assistant", (_request, response) => {
  response.sendFile(path.join(__dirname, "public", "assistant.html"));
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
