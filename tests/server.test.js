import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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

async function startFakeOllama({ models = ["qwen2.5:7b"], reply = "Stubbed local answer." } = {}) {
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
        if (String(lastGenerateRequest.keep_alive) === "-1") {
          loadedModels.add(lastGenerateRequest.model);
        }
        if (String(lastGenerateRequest.keep_alive) === "0") {
          loadedModels.delete(lastGenerateRequest.model);
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

  const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
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

  const createResponse = await fetch(`http://127.0.0.1:${port}/api/bulletins`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
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

  const bootstrapResponse = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
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

  const response = await fetch(`http://127.0.0.1:${port}/api/assistant/status`);
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.reachable, true);
  assert.equal(payload.ready, true);
  assert.equal(payload.activeModel, "qwen2.5:7b");
  assert.equal(payload.loaded, false);
  assert.equal(payload.configuredModel, "hearthboard-assistant");
  assert.equal(payload.fallbackModel, "qwen2.5:7b");
});

test("assistant can be woken and put to sleep from the web API", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hearthboard-"));
  const fakeOllama = await startFakeOllama({ models: ["qwen2.5:7b"] });
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

  const wakeResponse = await fetch(`http://127.0.0.1:${port}/api/assistant/power`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ action: "wake" })
  });

  assert.equal(wakeResponse.status, 200);
  const wakePayload = await wakeResponse.json();
  assert.equal(wakePayload.status.loaded, true);
  assert.equal(wakePayload.status.loadedModel, "qwen2.5:7b");
  assert.equal(fakeOllama.lastGenerateRequest().keep_alive, -1);

  const sleepResponse = await fetch(`http://127.0.0.1:${port}/api/assistant/power`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ action: "sleep" })
  });

  assert.equal(sleepResponse.status, 200);
  const sleepPayload = await sleepResponse.json();
  assert.equal(sleepPayload.status.loaded, false);
  assert.equal(fakeOllama.lastGenerateRequest().keep_alive, 0);
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

  const response = await fetch(`http://127.0.0.1:${port}/api/assistant/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
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
