import express from "express";
import { mkdir } from "node:fs/promises";
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

const palette = ["#f97316", "#14b8a6", "#8b5cf6", "#ef4444", "#2563eb", "#ca8a04"];

function seedMembers() {
  return [{ id: nanoid(), name: "Jody", role: "", color: "#2473eb" }];
}

function defaultData() {
  const members = seedMembers();
  return {
    householdName: HOUSEHOLD_NAME,
    timezone: APP_TIMEZONE,
    members,
    events: []
  };
}

await mkdir(DATA_DIR, { recursive: true });
const db = await JSONFilePreset(DB_FILE, defaultData());

function sortEvents(events) {
  return [...events].sort((left, right) => {
    const startDiff = new Date(left.start).getTime() - new Date(right.start).getTime();
    if (startDiff !== 0) {
      return startDiff;
    }
    return left.title.localeCompare(right.title);
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

function snapshot() {
  return {
    householdName: db.data.householdName,
    timezone: db.data.timezone,
    members: db.data.members,
    events: sortEvents(db.data.events)
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

app.use((request, response, next) => {
  if (request.path.startsWith("/api/") || request.method !== "GET") {
    return next();
  }

  return response.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, HOST, () => {
  console.log(`Hearthboard is running on http://${HOST}:${PORT}`);
});
