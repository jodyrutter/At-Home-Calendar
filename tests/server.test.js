import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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

test("bootstrap endpoint returns seeded household data", async (t) => {
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
  assert.ok(payload.members.length >= 3);
  assert.ok(payload.events.length >= 3);
});
