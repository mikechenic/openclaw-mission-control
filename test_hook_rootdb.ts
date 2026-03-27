// To run this test, use `npm run test:hook:rootdb`. It verifies that the mission control hook handler can create and write to a 
// SQLite database at the fixed path of /root/.openclaw/mission-control/test.db, which is used for testing purposes. 
// The test loads the handler module, simulates a startup event to initialize the database, then simulates a lifecycle start event to write a task entry. 
// Finally, it reads directly from the SQLite database to confirm that the entry was written correctly.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type HandlerModule = {
  default: (event: {
    type: string;
    action: string;
    sessionKey: string;
    timestamp: Date;
    messages: string[];
    context: Record<string, unknown>;
  }) => Promise<void>;
  postToMissionControl: (payload: Record<string, unknown>) => Promise<void>;
};

const rootDbPath = "/root/.openclaw/mission-control/test.db";
const rootDbDir = path.dirname(rootDbPath);

async function loadFreshHandlerModule(): Promise<HandlerModule> {
  vi.resetModules();
  return (await import("./hooks/mission-control/handler.ts")) as HandlerModule;
}

function buildHookCfg(sqlitePath: string) {
  return {
    hooks: {
      internal: {
        entries: {
          "mission-control": {
            enabled: true,
            env: {
              MISSION_CONTROL_DB_PATH: sqlitePath,
            },
          },
        },
      },
    },
  };
}

beforeEach(() => {
  fs.mkdirSync(rootDbDir, { recursive: true });
  if (fs.existsSync(rootDbPath)) {
    fs.unlinkSync(rootDbPath);
  }
});

afterEach(() => {
  if (fs.existsSync(rootDbPath)) {
    fs.unlinkSync(rootDbPath);
  }
});

describe("mission-control fixed root db integration", () => {
  test("creates and writes to /root/.openclaw/mission-control/test.db", async () => {
    const mod = await loadFreshHandlerModule();

    await mod.default({
      type: "gateway",
      action: "startup",
      sessionKey: "session-root-db",
      timestamp: new Date(),
      messages: [],
      context: { cfg: buildHookCfg(rootDbPath) },
    });

    await mod.postToMissionControl({
      runId: "root-run-1",
      action: "start",
      sessionKey: "session-root-db",
      timestamp: new Date().toISOString(),
      prompt: "root-db-test",
      source: "test",
      eventType: "lifecycle:start",
    });

    expect(fs.existsSync(rootDbPath)).toBe(true);

    const db = new Database(rootDbPath, { readonly: true });
    const row = db
      .prepare("SELECT runId, status, prompt FROM tasks WHERE runId = ? ORDER BY id DESC LIMIT 1")
      .get("root-run-1") as { runId: string; status: string; prompt: string } | undefined;
    db.close();

    expect(row).toMatchObject({
      runId: "root-run-1",
      status: "start",
      prompt: "root-db-test",
    });
  });
});
