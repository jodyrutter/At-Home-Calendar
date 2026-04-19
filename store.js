import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { JSONFilePreset } from "lowdb/node";

const { Pool } = pg;
const STORE_PRIMARY_KEY = "primary";

async function loadLegacyJson(filePath, fallbackFactory) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // Fall back to a fresh default store.
  }

  return fallbackFactory();
}

async function createPostgresStore({
  dataDir,
  filePath,
  defaultFactory,
  databaseUrl
}) {
  await mkdir(dataDir, { recursive: true });
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 4
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hearthboard_state (
      store_id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const result = await pool.query(
    "SELECT data FROM hearthboard_state WHERE store_id = $1",
    [STORE_PRIMARY_KEY]
  );

  let data;
  if (result.rowCount > 0) {
    data = result.rows[0].data;
  } else {
    data = await loadLegacyJson(filePath, defaultFactory);
    await pool.query(
      `
        INSERT INTO hearthboard_state (store_id, data, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (store_id)
        DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
      `,
      [STORE_PRIMARY_KEY, JSON.stringify(data)]
    );
  }

  return {
    driver: "postgres",
    data,
    async write() {
      await pool.query(
        `
          INSERT INTO hearthboard_state (store_id, data, updated_at)
          VALUES ($1, $2::jsonb, NOW())
          ON CONFLICT (store_id)
          DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
        `,
        [STORE_PRIMARY_KEY, JSON.stringify(this.data)]
      );
    },
    async close() {
      await pool.end();
    }
  };
}

export async function createPersistentStore({
  dataDir,
  fileName = "store.json",
  defaultData,
  databaseUrl = ""
}) {
  const filePath = path.join(dataDir, fileName);
  if (String(databaseUrl || "").trim()) {
    return createPostgresStore({
      dataDir,
      filePath,
      defaultFactory: defaultData,
      databaseUrl: String(databaseUrl).trim()
    });
  }

  await mkdir(dataDir, { recursive: true });
  const jsonStore = await JSONFilePreset(filePath, defaultData());
  return {
    driver: "json",
    data: jsonStore.data,
    async write() {
      await jsonStore.write();
      this.data = jsonStore.data;
    }
  };
}
