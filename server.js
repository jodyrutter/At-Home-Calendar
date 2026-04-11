import express from "express";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
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
const APP_TIMEZONE = process.env.APP_TIMEZONE || "America/Port-au-Prince";
const HOUSEHOLD_NAME = process.env.HOUSEHOLD_NAME || "Hearthboard Household";
const MEDIA_LIBRARY_ROOTS = process.env.MEDIA_LIBRARY_ROOTS || "";

const palette = ["#f97316", "#14b8a6", "#8b5cf6", "#ef4444", "#2563eb", "#ca8a04"];
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const videoExtensions = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const panoramaExtensions = new Set([".html", ".htm"]);
const rawExtensions = new Set([".dng"]);
const supportExtensions = new Set([".txt", ".gz", ".json", ".js", ".css"]);

function defaultMediaLibraries() {
  if (process.platform === "win32") {
    return [{ id: "drone", label: "Drone pictures", path: "E:\\Drone" }];
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
        path: String(entry.path || "").trim()
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
const db = await JSONFilePreset(DB_FILE, defaultData());

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

  return resolved;
}

function relativeMediaPath(library, absolutePath) {
  return path.relative(library.path, absolutePath).split(path.sep).join("/");
}

function buildMediaUrl(libraryId, relativePath) {
  const encodedPath = relativePath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `/media/${encodeURIComponent(libraryId)}${encodedPath ? `/${encodedPath}` : ""}`;
}

async function describeDirectory(library, directoryPath) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const directories = [];

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    const relativePath = relativeMediaPath(library, fullPath);

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

async function collectMediaFiles(library, startPath, { query = "", type = "all", limit = 250 } = {}) {
  const matches = [];
  const lowered = query.toLowerCase();
  const normalizedType = normalizeMediaTypeFilter(type);
  const queue = [startPath];
  let truncated = false;

  while (queue.length > 0 && matches.length < limit) {
    const currentDirectory = queue.shift();
    const entries = await readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDirectory, entry.name);

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

      if (normalizedType !== "all" && mediaType !== normalizedType) {
        continue;
      }

      const relativePath = relativeMediaPath(library, fullPath);
      if (lowered && !relativePath.toLowerCase().includes(lowered)) {
        continue;
      }

      const fileStat = await stat(fullPath);
      matches.push({
        name: entry.name,
        path: relativePath,
        mediaType,
        extension,
        size: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
        url: buildMediaUrl(library.id, relativePath)
      });

      if (matches.length >= limit) {
        truncated = true;
        break;
      }
    }
  }

  matches.sort((left, right) => new Date(right.modifiedAt).getTime() - new Date(left.modifiedAt).getTime());
  return { files: matches, truncated };
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
  const collectedFiles = await collectMediaFiles(library, resolvedPath, {
    type: mediaType,
    limit: mediaType === "all" ? 250 : 800
  });
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
    files: collectedFiles.files,
    truncated: collectedFiles.truncated
  });
});

app.get("/api/media/search", async (request, response) => {
  const library = getMediaLibrary(request.query.library);
  if (!library) {
    return response.status(404).json({ error: "Media library not found." });
  }

  const query = String(request.query.q || "").trim();
  const mediaType = normalizeMediaTypeFilter(request.query.type);
  const requestedPath = String(request.query.path || "");
  const resolvedPath = resolveMediaPath(library, requestedPath);
  if (!resolvedPath) {
    return response.status(400).json({ error: "Invalid media path." });
  }

  const results = await collectMediaFiles(library, resolvedPath, {
    query,
    type: mediaType,
    limit: mediaType === "all" ? (query ? 400 : 250) : 800
  });
  return response.json({
    library: { id: library.id, label: library.label },
    query,
    currentPath: relativeMediaPath(library, resolvedPath),
    mediaType,
    results: results.files,
    truncated: results.truncated
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

app.get("/gallery", (_request, response) => {
  response.sendFile(path.join(__dirname, "public", "gallery.html"));
});

app.use((request, response, next) => {
  if (request.path.startsWith("/api/") || request.method !== "GET") {
    return next();
  }

  return response.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, HOST, () => {
  console.log(`Hearthboard is running on http://${HOST}:${PORT}`);
});
