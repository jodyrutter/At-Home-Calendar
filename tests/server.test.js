import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

async function waitForServer(port) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 10000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  throw new Error("Server did not become ready in time.");
}

function remoteHeaders() {
  return {
    "X-Forwarded-Host": "203.0.113.10:42069",
    "X-Forwarded-For": "203.0.113.10",
    "X-Forwarded-Proto": "https"
  };
}

function cookieFromResponse(response, cookieName) {
  return String(response.headers.get("set-cookie") || "")
    .split(",")
    .find((entry) => entry.includes(`${cookieName}=`))
    ?.split(";")[0]
    ?.trim() || "";
}

async function setAdminPasswordAndLogin(baseUrl, headers = {}) {
  const setPassword = await fetch(`${baseUrl}/api/auth/password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      password: "supersecret123"
    })
  });
  assert.equal(setPassword.status, 200);

  const login = await fetch(`${baseUrl}/api/session/login`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: "jodyrutter",
      password: "supersecret123"
    })
  });
  assert.equal(login.status, 200);
  return cookieFromResponse(login, "hearthboard_session");
}

async function startFakeOllama({ models = ["qwen2.5:7b"], reply = "Stubbed local answer.", delayedUnloadMs = 0 } = {}) {
  let lastChatRequest = null;
  let lastGenerateRequest = null;
  const loadedModels = new Set();
  const server = http.createServer(async (request, response) => {
    if (request.url === "/api/tags") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ models: models.map((model) => ({ model, name: model })) }));
      return;
    }

    if (request.url === "/api/ps") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          models: [...loadedModels].map((model) => ({
            model,
            name: model,
            size_vram: 4700000000,
            context_length: 4096
          }))
        })
      );
      return;
    }

    if (request.url === "/api/generate" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        lastGenerateRequest = JSON.parse(body);
        if (String(lastGenerateRequest.keep_alive) !== "0") {
          loadedModels.add(lastGenerateRequest.model);
        }
        if (String(lastGenerateRequest.keep_alive) === "0") {
          if (delayedUnloadMs > 0) {
            setTimeout(() => {
              loadedModels.delete(lastGenerateRequest.model);
            }, delayedUnloadMs);
          } else {
            loadedModels.delete(lastGenerateRequest.model);
          }
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            model: lastGenerateRequest.model,
            response: "",
            done: true,
            done_reason: "stop"
          })
        );
      });
      return;
    }

    if (request.url === "/api/chat" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        lastChatRequest = JSON.parse(body);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            model: lastChatRequest.model,
            message: {
              role: "assistant",
              content: reply
            },
            done: true,
            done_reason: "stop",
            total_duration: 125000000,
            load_duration: 25000000
          })
        );
      });
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
    lastChatRequest: () => lastChatRequest,
    lastGenerateRequest: () => lastGenerateRequest
  };
}

async function startFakeWebSearchServer() {
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith("/search")) {
      const url = new URL(request.url, "http://127.0.0.1");
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          web: {
            results: [
              {
                title: `Result for ${url.searchParams.get("q")}`,
                url: `${baseUrl}/article-one`,
                description: "First source snippet."
              },
              {
                title: "Second source",
                url: `${baseUrl}/article-two`,
                description: "Second source snippet."
              }
            ]
          }
        })
      );
      return;
    }

    if (request.url === "/article-one") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<html><head><title>Article One</title></head><body><main>Local test article one with web facts and useful details.</main></body></html>");
      return;
    }

    if (request.url === "/article-two") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<html><body><article>Local test article two with extra context.</article></body></html>");
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found");
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    searchUrl: `http://127.0.0.1:${port}/search`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      })
  };
}

test("bootstrap endpoint returns a clean household with only Jody seeded", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const port = 42110;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      HOUSEHOLD_NAME: "Test House"
    },
    stdio: "inherit"
  });

  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  const adminCookie = await setAdminPasswordAndLogin(`http://127.0.0.1:${port}`);

  const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, {
    headers: {
      Cookie: adminCookie
    }
  });
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.householdName, "Test House");
  assert.equal(Array.isArray(payload.members), true);
  assert.equal(Array.isArray(payload.events), true);
  assert.equal(Array.isArray(payload.bulletins), true);
  assert.equal(payload.members.length, 1);
  assert.equal(payload.members[0].name, "Jody");
  assert.equal(payload.events.length, 0);
  assert.equal(payload.bulletins.length, 0);
});

test("bulletins can be created and returned in bootstrap", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const port = 42111;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      HOUSEHOLD_NAME: "Test House"
    },
    stdio: "inherit"
  });

  t.after(() => {
    server.kill();
  });

  await waitForServer(port);
  const adminCookie = await setAdminPasswordAndLogin(`http://127.0.0.1:${port}`);

  const createResponse = await fetch(`http://127.0.0.1:${port}/api/bulletins`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie
    },
    body: JSON.stringify({
      title: "Groceries tonight",
      message: "Please grab milk, tortillas, and limes.",
      author: "Jody",
      tone: "Reminder",
      pinned: true
    })
  });

  assert.equal(createResponse.status, 201);

  const bootstrapResponse = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, {
    headers: {
      Cookie: adminCookie
    }
  });
  assert.equal(bootstrapResponse.status, 200);

  const payload = await bootstrapResponse.json();
  assert.equal(payload.bulletins.length, 1);
  assert.equal(payload.bulletins[0].title, "Groceries tonight");
  assert.equal(payload.bulletins[0].pinned, true);
});

test("media library browse and search stay read-only and scoped to configured roots", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const mediaDir = await mkdtemp(path.join(tmpdir(), "hearthboard-media-"));
  await mkdir(path.join(mediaDir, "Clearwater", "2023-07-01"), { recursive: true });
  await mkdir(path.join(mediaDir, "Pretty Pictures"), { recursive: true });
  await writeFile(path.join(mediaDir, "Clearwater", "2023-07-01", "DJI_0001.JPG"), "fake-jpg");
  await writeFile(path.join(mediaDir, "Clearwater", "2023-07-01", "DJI_0002.MP4"), "fake-mp4");
  await writeFile(path.join(mediaDir, "Clearwater", "2023-07-01", "Pano.html"), "<html><body>panorama</body></html>");
  await writeFile(path.join(mediaDir, "Pretty Pictures", "secret.jpg"), "hidden");

  const port = 42112;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      MEDIA_LIBRARY_ROOTS: JSON.stringify([{ id: "drone", label: "Drone pictures", path: mediaDir, excludePaths: ["Pretty Pictures"] }])
    },
    stdio: "inherit"
  });

  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  const browseResponse = await fetch(`http://127.0.0.1:${port}/api/media/browse?library=drone&path=${encodeURIComponent("Clearwater/2023-07-01")}`);
  assert.equal(browseResponse.status, 200);
  const browsePayload = await browseResponse.json();
  assert.equal(browsePayload.files.length, 3);
  assert.equal(browsePayload.pagination.totalMatches, 3);
  assert.equal(browsePayload.pagination.currentPage, 1);
  assert.ok(browsePayload.files.some((file) => file.mediaType === "image"));
  const videoFile = browsePayload.files.find((file) => file.mediaType === "video");
  assert.ok(videoFile);
  assert.match(videoFile.thumbnailUrl, /^\/media-thumb\/drone\//);
  assert.equal(typeof videoFile.videoVariants?.original, "string");
  assert.equal(typeof videoFile.videoVariants?.p720, "string");
  assert.match(videoFile.videoVariants.original, /^\/media\/drone\//);
  assert.match(videoFile.videoVariants.p720, /^\/media-video\/720p\/drone\//);
  assert.ok(browsePayload.files.some((file) => file.mediaType === "panorama"));

  const pagedBrowseResponse = await fetch(`http://127.0.0.1:${port}/api/media/browse?library=drone&path=${encodeURIComponent("Clearwater/2023-07-01")}&page=2&pageSize=2`);
  assert.equal(pagedBrowseResponse.status, 200);
  const pagedBrowsePayload = await pagedBrowseResponse.json();
  assert.equal(pagedBrowsePayload.files.length, 1);
  assert.equal(pagedBrowsePayload.pagination.totalMatches, 3);
  assert.equal(pagedBrowsePayload.pagination.currentPage, 2);
  assert.equal(pagedBrowsePayload.pagination.totalPages, 2);
  assert.equal(pagedBrowsePayload.pagination.hasPreviousPage, true);
  assert.equal(pagedBrowsePayload.pagination.hasNextPage, false);

  const searchResponse = await fetch(`http://127.0.0.1:${port}/api/media/search?library=drone&q=${encodeURIComponent("pano")}`);
  assert.equal(searchResponse.status, 200);
  const searchPayload = await searchResponse.json();
  assert.equal(searchPayload.results.length, 1);
  assert.equal(searchPayload.results[0].mediaType, "panorama");
  assert.equal(searchPayload.pagination.totalMatches, 1);

  const filteredBrowseResponse = await fetch(`http://127.0.0.1:${port}/api/media/browse?library=drone&path=${encodeURIComponent("Clearwater/2023-07-01")}&type=video`);
  assert.equal(filteredBrowseResponse.status, 200);
  const filteredBrowsePayload = await filteredBrowseResponse.json();
  assert.equal(filteredBrowsePayload.files.length, 1);
  assert.equal(filteredBrowsePayload.files[0].mediaType, "video");

  const blockedTraversal = await fetch(`http://127.0.0.1:${port}/api/media/browse?library=drone&path=${encodeURIComponent("../")}`);
  assert.equal(blockedTraversal.status, 400);

  const excludedFolderBrowse = await fetch(`http://127.0.0.1:${port}/api/media/browse?library=drone&path=${encodeURIComponent("Pretty Pictures")}`);
  assert.equal(excludedFolderBrowse.status, 400);

  const rootBrowse = await fetch(`http://127.0.0.1:${port}/api/media/browse?library=drone&path=`);
  assert.equal(rootBrowse.status, 200);
  const rootPayload = await rootBrowse.json();
  assert.equal(rootPayload.directories.some((directory) => directory.name === "Pretty Pictures"), false);

  const blockedMedia = await fetch(`http://127.0.0.1:${port}/media/drone/${encodeURIComponent("Pretty Pictures")}/secret.jpg`);
  assert.equal(blockedMedia.status, 400);
});

test("assistant status reports fallback model readiness through Ollama", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const fakeOllama = await startFakeOllama({ models: ["qwen2.5:7b"] });
  const port = 42113;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      OLLAMA_BASE_URL: fakeOllama.baseUrl,
      OLLAMA_MODEL: "hearthboard-assistant",
      OLLAMA_FALLBACK_MODEL: "qwen2.5:7b"
    },
    stdio: "inherit"
  });

  t.after(async () => {
    server.kill();
    await fakeOllama.close();
  });

  await waitForServer(port);
  const adminCookie = await setAdminPasswordAndLogin(`http://127.0.0.1:${port}`);

  const response = await fetch(`http://127.0.0.1:${port}/api/assistant/status`, {
    headers: {
      Cookie: adminCookie
    }
  });
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.reachable, true);
  assert.equal(payload.ready, true);
  assert.equal(payload.activeModel, "qwen2.5:7b");
  assert.equal(payload.loaded, false);
  assert.equal(payload.configuredModel, "hearthboard-assistant");
  assert.equal(payload.fallbackModel, "qwen2.5:7b");
});

test("assistant stays behind login even if legacy visibility was saved as public", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  await writeFile(
    path.join(dataDir, "store.json"),
    JSON.stringify(
      {
        householdName: "Test House",
        timezone: "America/Port-au-Prince",
        members: [{ id: "seed-jody", name: "Jody", role: "", color: "#2473eb" }],
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
          pageVisibility: {
            calendar: { lan: "public", remote: "public" },
            gallery: { lan: "public", remote: "public" },
            assistant: { lan: "public", remote: "public" }
          },
          libraryVisibility: {}
        }
      },
      null,
      2
    )
  );

  const port = 42129;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir
    },
    stdio: "inherit"
  });

  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  const pageResponse = await fetch(`http://127.0.0.1:${port}/assistant`, {
    redirect: "manual"
  });
  assert.equal(pageResponse.status, 302);
  assert.match(String(pageResponse.headers.get("location") || ""), /^\/login\?next=/);

  const apiResponse = await fetch(`http://127.0.0.1:${port}/api/assistant/status`);
  assert.equal(apiResponse.status, 401);
});

test("assistant can be woken and put to sleep from the web API", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const fakeOllama = await startFakeOllama({ models: ["qwen2.5:7b"], delayedUnloadMs: 300 });
  const port = 42115;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      OLLAMA_BASE_URL: fakeOllama.baseUrl,
      OLLAMA_MODEL: "hearthboard-assistant",
      OLLAMA_FALLBACK_MODEL: "qwen2.5:7b",
      OLLAMA_KEEP_ALIVE: "0"
    },
    stdio: "inherit"
  });

  t.after(async () => {
    server.kill();
    await fakeOllama.close();
  });

  await waitForServer(port);
  const adminCookie = await setAdminPasswordAndLogin(`http://127.0.0.1:${port}`);

  const wakeResponse = await fetch(`http://127.0.0.1:${port}/api/assistant/power`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie
    },
    body: JSON.stringify({ action: "wake" })
  });

  assert.equal(wakeResponse.status, 200);
  const wakePayload = await wakeResponse.json();
  assert.equal(wakePayload.status.loaded, true);
  assert.equal(wakePayload.status.loadedModel, "qwen2.5:7b");
  assert.equal(fakeOllama.lastGenerateRequest().keep_alive, "5m");

  const sleepResponse = await fetch(`http://127.0.0.1:${port}/api/assistant/power`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie
    },
    body: JSON.stringify({ action: "sleep" })
  });

  assert.equal(sleepResponse.status, 200);
  const sleepPayload = await sleepResponse.json();
  assert.equal(sleepPayload.status.loaded, false);
  assert.equal(fakeOllama.lastGenerateRequest().keep_alive, 0);
});

test("local AI policy can restrict wakeups from the local tray endpoint", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const fakeOllama = await startFakeOllama({ models: ["qwen2.5:7b"] });
  const port = 42130;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      OLLAMA_BASE_URL: fakeOllama.baseUrl,
      OLLAMA_MODEL: "hearthboard-assistant",
      OLLAMA_FALLBACK_MODEL: "qwen2.5:7b",
      OLLAMA_KEEP_ALIVE: "0"
    },
    stdio: "inherit"
  });

  t.after(async () => {
    server.kill();
    await fakeOllama.close();
  });

  await waitForServer(port);
  const adminCookie = await setAdminPasswordAndLogin(`http://127.0.0.1:${port}`);

  const wakeResponse = await fetch(`http://127.0.0.1:${port}/api/assistant/power`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie
    },
    body: JSON.stringify({ action: "wake" })
  });
  assert.equal(wakeResponse.status, 200);

  const restrictResponse = await fetch(`http://127.0.0.1:${port}/api/local-ai/policy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ allowed: false })
  });
  assert.equal(restrictResponse.status, 200);
  const restrictPayload = await restrictResponse.json();
  assert.equal(restrictPayload.policy.allowed, false);
  assert.equal(restrictPayload.status.localAiAllowed, false);
  assert.equal(restrictPayload.status.loaded, false);
  assert.equal(fakeOllama.lastGenerateRequest().keep_alive, 0);

  const blockedWake = await fetch(`http://127.0.0.1:${port}/api/assistant/power`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie
    },
    body: JSON.stringify({ action: "wake" })
  });
  assert.equal(blockedWake.status, 423);

  const allowResponse = await fetch(`http://127.0.0.1:${port}/api/local-ai/policy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ allowed: true })
  });
  assert.equal(allowResponse.status, 200);
  const allowPayload = await allowResponse.json();
  assert.equal(allowPayload.policy.allowed, true);
});

test("local AI restriction resets to allowed on startup", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  await writeFile(
    path.join(dataDir, "store.json"),
    JSON.stringify(
      {
        householdName: "Test House",
        timezone: "America/Port-au-Prince",
        members: [{ id: "seed-jody", name: "Jody", role: "", color: "#2473eb" }],
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
            allowed: false,
            updatedAt: "2026-04-18T00:00:00.000Z",
            updatedBy: "local-tray"
          },
          pageVisibility: {
            calendar: { lan: "family", remote: "family" },
            gallery: { lan: "public", remote: "public" },
            assistant: { lan: "trusted", remote: "trusted" }
          },
          libraryVisibility: {}
        }
      },
      null,
      2
    )
  );

  const port = 42131;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir
    },
    stdio: "inherit"
  });

  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  const response = await fetch(`http://127.0.0.1:${port}/api/local-ai/status`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.localAiAllowed, true);
  assert.equal(payload.localAiPolicy.updatedBy, "startup");
});

test("assistant chat proxies to Ollama and requests immediate unload", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const fakeOllama = await startFakeOllama({ models: ["qwen2.5:7b"] });
  const port = 42114;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      OLLAMA_BASE_URL: fakeOllama.baseUrl,
      OLLAMA_MODEL: "hearthboard-assistant",
      OLLAMA_FALLBACK_MODEL: "qwen2.5:7b",
      OLLAMA_KEEP_ALIVE: "0"
    },
    stdio: "inherit"
  });

  t.after(async () => {
    server.kill();
    await fakeOllama.close();
  });

  await waitForServer(port);
  const adminCookie = await setAdminPasswordAndLogin(`http://127.0.0.1:${port}`);

  const response = await fetch(`http://127.0.0.1:${port}/api/assistant/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: "Help me plan dinner." }]
    })
  });

  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.activeModel, "qwen2.5:7b");
  assert.equal(payload.message.content, "Stubbed local answer.");

  const proxiedRequest = fakeOllama.lastChatRequest();
  assert.equal(proxiedRequest.model, "qwen2.5:7b");
  assert.equal(proxiedRequest.keep_alive, "0");
  assert.equal(proxiedRequest.stream, false);
  assert.equal(proxiedRequest.messages[0].role, "system");
  assert.equal(proxiedRequest.messages.at(-1).content, "Help me plan dinner.");
});

test("assistant chat refreshes the 5 minute sleep timer when it is awake", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const fakeOllama = await startFakeOllama({ models: ["qwen2.5:7b"] });
  const port = 42117;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      OLLAMA_BASE_URL: fakeOllama.baseUrl,
      OLLAMA_MODEL: "hearthboard-assistant",
      OLLAMA_FALLBACK_MODEL: "qwen2.5:7b",
      OLLAMA_KEEP_ALIVE: "0",
      OLLAMA_AWAKE_KEEP_ALIVE: "5m"
    },
    stdio: "inherit"
  });

  t.after(async () => {
    server.kill();
    await fakeOllama.close();
  });

  await waitForServer(port);
  const adminCookie = await setAdminPasswordAndLogin(`http://127.0.0.1:${port}`);

  const wakeResponse = await fetch(`http://127.0.0.1:${port}/api/assistant/power`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie
    },
    body: JSON.stringify({ action: "wake" })
  });
  assert.equal(wakeResponse.status, 200);

  const response = await fetch(`http://127.0.0.1:${port}/api/assistant/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: "Stay awake a bit longer." }]
    })
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.keepAlive, "5m");
  const proxiedRequest = fakeOllama.lastChatRequest();
  assert.equal(proxiedRequest.keep_alive, "5m");
});

test("assistant can search the web and return cited sources", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const fakeOllama = await startFakeOllama({ models: ["qwen2.5:7b"], reply: "Here is a web-grounded answer [1]." });
  const fakeWeb = await startFakeWebSearchServer();
  const port = 42116;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      OLLAMA_BASE_URL: fakeOllama.baseUrl,
      OLLAMA_MODEL: "hearthboard-assistant",
      OLLAMA_FALLBACK_MODEL: "qwen2.5:7b",
      OLLAMA_KEEP_ALIVE: "0",
      BRAVE_SEARCH_API_KEY: "test-key",
      BRAVE_SEARCH_BASE_URL: fakeWeb.searchUrl,
      ALLOW_PRIVATE_WEB_FETCH: "true"
    },
    stdio: "inherit"
  });

  t.after(async () => {
    server.kill();
    await fakeOllama.close();
    await fakeWeb.close();
  });

  await waitForServer(port);
  const adminCookie = await setAdminPasswordAndLogin(`http://127.0.0.1:${port}`);

  const response = await fetch(`http://127.0.0.1:${port}/api/assistant/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: "What is happening on the web?" }],
      useWeb: true
    })
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.usedWebSearch, true);
  assert.equal(payload.sources.length, 2);
  assert.equal(payload.sources[0].title, "Result for What is happening on the web?");
  assert.match(payload.message.content, /\[1\]/);

  const proxiedRequest = fakeOllama.lastChatRequest();
  assert.ok(proxiedRequest.messages.some((message) => String(message.content).includes("Web search query: What is happening on the web?")));
});

test("remote access protection redirects calendar to login but leaves gallery public", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const port = 42118;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      TRUST_PROXY_HEADERS: "true"
    },
    stdio: "inherit"
  });

  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  const setPassword = await fetch(`http://127.0.0.1:${port}/api/auth/password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      password: "supersecret123"
    })
  });
  assert.equal(setPassword.status, 200);

  const protectedPage = await fetch(`http://127.0.0.1:${port}/`, {
    headers: remoteHeaders(),
    redirect: "manual"
  });
  assert.equal(protectedPage.status, 302);
  assert.match(String(protectedPage.headers.get("location") || ""), /^\/login\?next=/);

  const protectedApi = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, {
    headers: remoteHeaders()
  });
  assert.equal(protectedApi.status, 401);

  const publicGallery = await fetch(`http://127.0.0.1:${port}/gallery`, {
    headers: remoteHeaders()
  });
  assert.equal(publicGallery.status, 200);
});

test("local network calendar bootstrap and event creation stay available without signing in", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const port = 42135;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir
    },
    stdio: "inherit"
  });

  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  const bootstrap = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
  assert.equal(bootstrap.status, 200);
  const bootstrapPayload = await bootstrap.json();
  assert.equal(bootstrapPayload.currentUser, null);

  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const createEvent = await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title: "LAN event",
      category: "General",
      location: "Kitchen",
      description: "Shared LAN save still works.",
      allDay: false,
      memberIds: [],
      notifications: {
        enabled: false,
        targetUserIds: [],
        offsetsMinutes: []
      },
      start: start.toISOString(),
      end: end.toISOString()
    })
  });
  assert.equal(createEvent.status, 201);
});

test("remote users cannot self-register accounts", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const port = 42124;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      TRUST_PROXY_HEADERS: "true"
    },
    stdio: "inherit"
  });

  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  const registerResponse = await fetch(`http://127.0.0.1:${port}/api/session/register`, {
    method: "POST",
    headers: {
      ...remoteHeaders(),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: "remoteuser",
      password: "supersecret123"
    })
  });

  assert.equal(registerResponse.status, 403);
});

test("admin account is migrated from the legacy password and can sign in", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const port = 42119;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      TRUST_PROXY_HEADERS: "true"
    },
    stdio: "inherit"
  });

  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  await fetch(`http://127.0.0.1:${port}/api/auth/password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      password: "supersecret123"
    })
  });

  const login = await fetch(`http://127.0.0.1:${port}/api/session/login`, {
    method: "POST",
    headers: {
      ...remoteHeaders(),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: "jodyrutter",
      password: "supersecret123"
    })
  });

  assert.equal(login.status, 200);
  assert.match(String(login.headers.get("set-cookie") || ""), /;\s*Secure/i);
  const cookie = cookieFromResponse(login, "hearthboard_session");
  assert.match(cookie, /^hearthboard_session=/);

  const account = await fetch(`http://127.0.0.1:${port}/api/account`, {
    headers: {
      ...remoteHeaders(),
      Cookie: cookie
    }
  });
  assert.equal(account.status, 200);
  const payload = await account.json();
  assert.equal(payload.user.username, "jodyrutter");
  assert.equal(payload.user.role, "admin");
});

test("remembered sessions survive a server restart", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const port = 42125;
  let server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir
    },
    stdio: "inherit"
  });

  await waitForServer(port);

  const register = await fetch(`http://127.0.0.1:${port}/api/session/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: "mom",
      password: "household123",
      rememberMe: true
    })
  });
  assert.equal(register.status, 201);
  assert.match(String(register.headers.get("set-cookie") || ""), /Max-Age=/);
  const authCookie = cookieFromResponse(register, "hearthboard_session");
  assert.ok(authCookie);

  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 250));

  server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir
    },
    stdio: "inherit"
  });

  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  const account = await fetch(`http://127.0.0.1:${port}/api/account`, {
    headers: {
      Cookie: authCookie
    }
  });
  assert.equal(account.status, 200);
  const payload = await account.json();
  assert.equal(payload.user.username, "mom");
});

test("new accounts stay out of the household roster until the admin approves household access", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const port = 42126;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir
    },
    stdio: "inherit"
  });

  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  const register = await fetch(`http://127.0.0.1:${port}/api/session/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: "girlfriend",
      password: "household123"
    })
  });
  assert.equal(register.status, 201);

  const adminCookie = await setAdminPasswordAndLogin(`http://127.0.0.1:${port}`);

  const initialBootstrap = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, {
    headers: {
      Cookie: adminCookie
    }
  });
  assert.equal(initialBootstrap.status, 200);
  const initialPayload = await initialBootstrap.json();
  assert.equal(initialPayload.members.length, 1);

  const account = await fetch(`http://127.0.0.1:${port}/api/account`, {
    headers: {
      Cookie: adminCookie
    }
  });
  const accountPayload = await account.json();
  const targetUser = accountPayload.users.find((user) => user.username === "girlfriend");
  assert.ok(targetUser);
  assert.equal(targetUser.pendingApproval, true);

  const updateResponse = await fetch(`http://127.0.0.1:${port}/api/admin/users/${targetUser.id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie
    },
    body: JSON.stringify({
      approved: true,
      permissionLevel: "family",
      householdMember: true
    })
  });
  assert.equal(updateResponse.status, 200);

  const bootstrap = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, {
    headers: {
      Cookie: adminCookie
    }
  });
  assert.equal(bootstrap.status, 200);
  const payload = await bootstrap.json();
  assert.equal(payload.members.length, 2);
  assert.ok(payload.members.some((member) => member.username === "girlfriend"));
});

test("event reminder targets sync upcoming mobile reminders for the selected account", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const port = 42132;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir
    },
    stdio: "inherit"
  });

  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  const register = await fetch(`http://127.0.0.1:${port}/api/session/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: "jodygf",
      password: "household123"
    })
  });
  assert.equal(register.status, 201);

  const adminCookie = await setAdminPasswordAndLogin(`http://127.0.0.1:${port}`);
  const account = await fetch(`http://127.0.0.1:${port}/api/account`, {
    headers: {
      Cookie: adminCookie
    }
  });
  const accountPayload = await account.json();
  const targetUser = accountPayload.users.find((user) => user.username === "jodygf");
  assert.ok(targetUser);

  const approve = await fetch(`http://127.0.0.1:${port}/api/admin/users/${targetUser.id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie
    },
    body: JSON.stringify({
      approved: true,
      permissionLevel: "family",
      householdMember: true
    })
  });
  assert.equal(approve.status, 200);

  const start = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const createEvent = await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie
    },
    body: JSON.stringify({
      title: "Dinner reminder",
      category: "Meals",
      location: "Kitchen",
      description: "Do not forget pasta night.",
      allDay: false,
      memberIds: [],
      notifications: {
        enabled: true,
        targetUserIds: [targetUser.id],
        offsetsMinutes: [60, 10, 0]
      },
      start: start.toISOString(),
      end: end.toISOString()
    })
  });
  assert.equal(createEvent.status, 201);
  const createdEvent = await createEvent.json();
  assert.deepEqual(createdEvent.notifications.targetUserIds, [targetUser.id]);

  const targetLogin = await fetch(`http://127.0.0.1:${port}/api/session/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: "jodygf",
      password: "household123"
    })
  });
  assert.equal(targetLogin.status, 200);
  const targetCookie = cookieFromResponse(targetLogin, "hearthboard_session");

  const reminderResponse = await fetch(`http://127.0.0.1:${port}/api/mobile/reminders`, {
    headers: {
      Cookie: targetCookie
    }
  });
  assert.equal(reminderResponse.status, 200);
  const reminderPayload = await reminderResponse.json();
  assert.equal(reminderPayload.user.username, "jodygf");
  assert.equal(reminderPayload.reminders.length, 3);
  assert.ok(reminderPayload.reminders.every((reminder) => reminder.eventId === createdEvent.id));
  assert.ok(reminderPayload.reminders.every((reminder) => typeof reminder.scheduleAt === "string"));
});

test("annoy mode expands a single reminder into repeated upcoming nudges", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const port = 42136;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir
    },
    stdio: "inherit"
  });

  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  const register = await fetch(`http://127.0.0.1:${port}/api/session/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: "annoyed",
      password: "household123"
    })
  });
  assert.equal(register.status, 201);

  const adminCookie = await setAdminPasswordAndLogin(`http://127.0.0.1:${port}`);
  const account = await fetch(`http://127.0.0.1:${port}/api/account`, {
    headers: {
      Cookie: adminCookie
    }
  });
  const accountPayload = await account.json();
  const targetUser = accountPayload.users.find((user) => user.username === "annoyed");
  assert.ok(targetUser);

  const approve = await fetch(`http://127.0.0.1:${port}/api/admin/users/${targetUser.id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie
    },
    body: JSON.stringify({
      approved: true,
      permissionLevel: "family",
      householdMember: true
    })
  });
  assert.equal(approve.status, 200);

  const start = new Date(Date.now() + 35 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const createEvent = await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie
    },
    body: JSON.stringify({
      title: "Annoying event",
      category: "General",
      location: "",
      description: "",
      allDay: false,
      memberIds: [],
      notifications: {
        enabled: true,
        targetUserIds: [targetUser.id],
        offsetsMinutes: [30],
        annoyMode: true,
        annoyIntervalMinutes: 10
      },
      start: start.toISOString(),
      end: end.toISOString()
    })
  });
  assert.equal(createEvent.status, 201);

  const targetLogin = await fetch(`http://127.0.0.1:${port}/api/session/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: "annoyed",
      password: "household123"
    })
  });
  assert.equal(targetLogin.status, 200);
  const targetCookie = cookieFromResponse(targetLogin, "hearthboard_session");

  const reminderResponse = await fetch(`http://127.0.0.1:${port}/api/mobile/reminders`, {
    headers: {
      Cookie: targetCookie
    }
  });
  assert.equal(reminderResponse.status, 200);
  const reminderPayload = await reminderResponse.json();
  assert.equal(reminderPayload.reminders.length, 4);
  assert.deepEqual(
    reminderPayload.reminders.map((reminder) => reminder.offsetMinutes),
    [30, 20, 10, 0]
  );
  assert.ok(reminderPayload.reminders.every((reminder) => reminder.eventTitle === "Annoying event"));
});

test("remote gallery hides authenticated libraries until a user signs in", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const publicMediaDir = await mkdtemp(path.join(tmpdir(), "hearthboard-public-media-"));
  const phoneMediaDir = await mkdtemp(path.join(tmpdir(), "hearthboard-phone-media-"));
  await mkdir(path.join(publicMediaDir, "Family"), { recursive: true });
  await mkdir(path.join(phoneMediaDir, "2018-10-26"), { recursive: true });
  await writeFile(path.join(publicMediaDir, "Family", "public.jpg"), "public");
  await writeFile(path.join(phoneMediaDir, "2018-10-26", "private.jpg"), "private");

  const port = 42120;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      TRUST_PROXY_HEADERS: "true",
      MEDIA_LIBRARY_ROOTS: JSON.stringify([
        { id: "general", label: "General", path: publicMediaDir },
        { id: "phone", label: "Phone", path: phoneMediaDir, authMode: "always", writable: true }
      ])
    },
    stdio: "inherit"
  });

  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  await fetch(`http://127.0.0.1:${port}/api/auth/password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      password: "supersecret123"
    })
  });

  const librariesResponse = await fetch(`http://127.0.0.1:${port}/api/media/libraries`, {
    headers: remoteHeaders()
  });
  assert.equal(librariesResponse.status, 200);
  const librariesPayload = await librariesResponse.json();
  assert.deepEqual(
    librariesPayload.libraries.map((library) => library.id),
    ["general"]
  );
  assert.equal(librariesPayload.lockedLibraryCount, 1);

  const privateBrowse = await fetch(`http://127.0.0.1:${port}/api/media/browse?library=phone&path=`, {
    headers: remoteHeaders()
  });
  assert.equal(privateBrowse.status, 401);

  const login = await fetch(`http://127.0.0.1:${port}/api/session/login`, {
    method: "POST",
    headers: {
      ...remoteHeaders(),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: "jodyrutter",
      password: "supersecret123"
    })
  });
  const cookie = cookieFromResponse(login, "hearthboard_session");

  const unlockedLibrariesResponse = await fetch(`http://127.0.0.1:${port}/api/media/libraries`, {
    headers: {
      ...remoteHeaders(),
      Cookie: cookie
    }
  });
  assert.equal(unlockedLibrariesResponse.status, 200);
  const unlockedLibrariesPayload = await unlockedLibrariesResponse.json();
  assert.deepEqual(
    unlockedLibrariesPayload.libraries.map((library) => library.id),
    ["general", "phone"]
  );
});

test("admin account shows tracked devices in the account panel payload", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const port = 42127;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      TRUST_PROXY_HEADERS: "true"
    },
    stdio: "inherit"
  });

  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  await fetch(`http://127.0.0.1:${port}/gallery`, {
    headers: {
      ...remoteHeaders(),
      "User-Agent": "Test Browser 1.0"
    }
  });

  await fetch(`http://127.0.0.1:${port}/api/auth/password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      password: "supersecret123"
    })
  });

  const login = await fetch(`http://127.0.0.1:${port}/api/session/login`, {
    method: "POST",
    headers: {
      ...remoteHeaders(),
      "Content-Type": "application/json",
      "User-Agent": "Test Browser 1.0"
    },
    body: JSON.stringify({
      username: "jodyrutter",
      password: "supersecret123",
      rememberMe: true
    })
  });
  const deviceCookie = cookieFromResponse(login, "hearthboard_device");
  const authCookie = cookieFromResponse(login, "hearthboard_session");
  assert.ok(deviceCookie);
  assert.ok(authCookie);

  const account = await fetch(`http://127.0.0.1:${port}/api/account`, {
    headers: {
      ...remoteHeaders(),
      "User-Agent": "Test Browser 1.0",
      Cookie: `${deviceCookie}; ${authCookie}`
    }
  });
  assert.equal(account.status, 200);
  const payload = await account.json();
  assert.ok(Array.isArray(payload.devices));
  assert.ok(payload.deviceSummary.totalKnownIps >= 1);
  assert.ok(payload.devices.some((group) => group.ip === "203.0.113.10"));
  assert.ok(payload.devices[0].identities.length >= 1);
});

test("embedded mobile login sets a cross-site session cookie", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const port = 42133;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      TRUST_PROXY_HEADERS: "true"
    },
    stdio: "inherit"
  });

  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  await fetch(`http://127.0.0.1:${port}/api/auth/password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      password: "supersecret123"
    })
  });

  const login = await fetch(`http://127.0.0.1:${port}/api/session/login`, {
    method: "POST",
    headers: {
      ...remoteHeaders(),
      "Content-Type": "application/json",
      "X-Hearthboard-Mobile-App": "1"
    },
    body: JSON.stringify({
      username: "jodyrutter",
      password: "supersecret123",
      rememberMe: true
    })
  });
  assert.equal(login.status, 200);
  const setCookie = String(login.headers.get("set-cookie") || "");
  assert.match(setCookie, /hearthboard_session=/);
  assert.match(setCookie, /SameSite=None/);
  assert.match(setCookie, /Secure/);
});

test("mobile app shell requests get a cross-site device cookie", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const port = 42134;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      TRUST_PROXY_HEADERS: "true"
    },
    stdio: "inherit"
  });

  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  const page = await fetch(`http://127.0.0.1:${port}/?mobileApp=1`, {
    headers: remoteHeaders()
  });
  assert.equal(page.status, 200);
  const setCookie = String(page.headers.get("set-cookie") || "");
  assert.match(setCookie, /hearthboard_device=/);
  assert.match(setCookie, /SameSite=None/);
  assert.match(setCookie, /Secure/);
});

test("gallery view counts increase when media is opened", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const mediaDir = await mkdtemp(path.join(tmpdir(), "hearthboard-media-"));
  await mkdir(path.join(mediaDir, "Shots"), { recursive: true });
  await writeFile(path.join(mediaDir, "Shots", "test.jpg"), "image");

  const port = 42128;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      MEDIA_LIBRARY_ROOTS: JSON.stringify([
        { id: "general", label: "General", path: mediaDir }
      ])
    },
    stdio: "inherit"
  });

  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  const initialBrowse = await fetch(`http://127.0.0.1:${port}/api/media/browse?library=general&path=&type=all&page=1&pageSize=48`);
  const initialPayload = await initialBrowse.json();
  assert.equal(initialPayload.files[0].viewCount, 0);

  const viewResponse = await fetch(`http://127.0.0.1:${port}/api/media/view`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      library: "general",
      path: "Shots/test.jpg"
    })
  });
  assert.equal(viewResponse.status, 200);
  const viewPayload = await viewResponse.json();
  assert.equal(viewPayload.viewCount, 1);

  const nextBrowse = await fetch(`http://127.0.0.1:${port}/api/media/browse?library=general&path=&type=all&page=1&pageSize=48`);
  const nextPayload = await nextBrowse.json();
  assert.equal(nextPayload.files[0].viewCount, 1);
});

test("non-admin users cannot quarantine phone media, but the admin can", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const phoneMediaDir = await mkdtemp(path.join(tmpdir(), "hearthboard-phone-media-"));
  const phoneQuarantineDir = await mkdtemp(path.join(tmpdir(), "hearthboard-phone-quarantine-"));
  await mkdir(path.join(phoneMediaDir, "2020-01-01"), { recursive: true });
  await writeFile(path.join(phoneMediaDir, "2020-01-01", "hide-me.jpg"), "private");

  const port = 42123;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      MEDIA_LIBRARY_ROOTS: JSON.stringify([
        { id: "phone", label: "Phone", path: phoneMediaDir, authMode: "always", quarantinePath: phoneQuarantineDir, writable: true }
      ])
    },
    stdio: "inherit"
  });

  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  await fetch(`http://127.0.0.1:${port}/api/auth/password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      password: "supersecret123"
    })
  });

  const memberRegister = await fetch(`http://127.0.0.1:${port}/api/session/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: "mom",
      password: "household123"
    })
  });
  assert.equal(memberRegister.status, 201);
  const memberCookie = cookieFromResponse(memberRegister, "hearthboard_session");

  const memberQuarantine = await fetch(`http://127.0.0.1:${port}/api/media/quarantine`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: memberCookie
    },
    body: JSON.stringify({
      library: "phone",
      path: "2020-01-01/hide-me.jpg"
    })
  });
  assert.equal(memberQuarantine.status, 403);

  const adminLogin = await fetch(`http://127.0.0.1:${port}/api/session/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: "jodyrutter",
      password: "supersecret123"
    })
  });
  assert.equal(adminLogin.status, 200);
  const adminCookie = cookieFromResponse(adminLogin, "hearthboard_session");

  const quarantineResponse = await fetch(`http://127.0.0.1:${port}/api/media/quarantine`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie
    },
    body: JSON.stringify({
      library: "phone",
      path: "2020-01-01/hide-me.jpg"
    })
  });
  assert.equal(quarantineResponse.status, 200);
  const quarantinePayload = await quarantineResponse.json();
  assert.equal(quarantinePayload.ok, true);
  assert.equal(quarantinePayload.sourcePath, "2020-01-01/hide-me.jpg");

  const hiddenSource = await stat(path.join(phoneMediaDir, "2020-01-01", "hide-me.jpg")).then(() => true).catch(() => false);
  const movedDestination = await stat(path.join(phoneQuarantineDir, "2020-01-01", "hide-me.jpg")).then(() => true).catch(() => false);
  assert.equal(hiddenSource, false);
  assert.equal(movedDestination, true);
});
