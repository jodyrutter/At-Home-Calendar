import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  await writeFile(path.join(mediaDir, "Clearwater", "2023-07-01", "DJI_0001.JPG"), "fake-jpg");
  await writeFile(path.join(mediaDir, "Clearwater", "2023-07-01", "Pano.html"), "<html><body>panorama</body></html>");

  const port = 42112;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      MEDIA_LIBRARY_ROOTS: JSON.stringify([{ id: "drone", label: "Drone pictures", path: mediaDir }])
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
  assert.equal(browsePayload.files.length, 2);
  assert.ok(browsePayload.files.some((file) => file.mediaType === "image"));
  assert.ok(browsePayload.files.some((file) => file.mediaType === "panorama"));

  const searchResponse = await fetch(`http://127.0.0.1:${port}/api/media/search?library=drone&q=${encodeURIComponent("pano")}`);
  assert.equal(searchResponse.status, 200);
  const searchPayload = await searchResponse.json();
  assert.equal(searchPayload.results.length, 1);
  assert.equal(searchPayload.results[0].mediaType, "panorama");

  const filteredBrowseResponse = await fetch(`http://127.0.0.1:${port}/api/media/browse?library=drone&path=${encodeURIComponent("Clearwater/2023-07-01")}&type=video`);
  assert.equal(filteredBrowseResponse.status, 200);
  const filteredBrowsePayload = await filteredBrowseResponse.json();
  assert.equal(filteredBrowsePayload.files.length, 0);

  const blockedTraversal = await fetch(`http://127.0.0.1:${port}/api/media/browse?library=drone&path=${encodeURIComponent("../")}`);
  assert.equal(blockedTraversal.status, 400);
});
