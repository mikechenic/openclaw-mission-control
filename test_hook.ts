import fs from "node:fs";
import os from "node:os";
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
  resolveUrl: (cfg?: Record<string, unknown>) => string | undefined;
};

let tempDir = "";
let dbPath = "";

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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-control-hook-test-"));
  dbPath = path.join(tempDir, "events.db");
});

afterEach(() => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("mission-control handler sqlite integration", () => {
  test("creates the database and expected tables on gateway startup", async () => {
    const mod = await loadFreshHandlerModule();

    await mod.default({
      type: "gateway",
      action: "startup",
      sessionKey: "session-create-db",
      timestamp: new Date(),
      messages: [],
      context: { cfg: buildHookCfg(dbPath) },
    });

    expect(fs.existsSync(dbPath)).toBe(true);

    const db = new Database(dbPath, { readonly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks', 'events', 'documents') ORDER BY name")
      .all() as Array<{ name: string }>;
    db.close();

    expect(tables.map(t => t.name)).toEqual(["documents", "events", "tasks"]);
  });

  test("writes and reads task, event, and document rows", async () => {
    const mod = await loadFreshHandlerModule();

    await mod.default({
      type: "gateway",
      action: "startup",
      sessionKey: "session-write-read",
      timestamp: new Date(),
      messages: [],
      context: { cfg: buildHookCfg(dbPath) },
    });

    await mod.postToMissionControl({
      runId: "run-1",
      action: "start",
      sessionKey: "session-write-read",
      timestamp: new Date().toISOString(),
      prompt: "Build me a report",
      source: "webchat",
      eventType: "lifecycle:start",
    });

    await mod.postToMissionControl({
      runId: "run-1",
      action: "progress",
      sessionKey: "session-write-read",
      timestamp: new Date().toISOString(),
      message: "Using tool: write",
      eventType: "tool:start",
    });

    await mod.postToMissionControl({
      runId: "run-1",
      action: "document",
      sessionKey: "session-write-read",
      timestamp: new Date().toISOString(),
      eventType: "tool:write",
      document: {
        title: "report.md",
        content: "# Report\nAll systems nominal.",
        type: "markdown",
        path: "/tmp/report.md",
      },
    });

    const db = new Database(dbPath, { readonly: true });
    const task = db
      .prepare("SELECT runId, status, prompt, source FROM tasks WHERE runId = ? ORDER BY id DESC LIMIT 1")
      .get("run-1") as { runId: string; status: string; prompt: string; source: string } | undefined;
    const eventRow = db
      .prepare("SELECT runId, eventType, action, message FROM events WHERE runId = ? ORDER BY id DESC LIMIT 1")
      .get("run-1") as { runId: string; eventType: string; action: string; message: string } | undefined;
    const doc = db
      .prepare("SELECT runId, title, type, path FROM documents WHERE runId = ? ORDER BY id DESC LIMIT 1")
      .get("run-1") as { runId: string; title: string; type: string; path: string } | undefined;
    db.close();

    expect(task).toMatchObject({
      runId: "run-1",
      status: "start",
      prompt: "Build me a report",
      source: "webchat",
    });
    expect(eventRow).toMatchObject({
      runId: "run-1",
      eventType: "tool:start",
      action: "progress",
      message: "Using tool: write",
    });
    expect(doc).toMatchObject({
      runId: "run-1",
      title: "report.md",
      type: "markdown",
      path: "/tmp/report.md",
    });
  });

  test("resolveUrl returns configured sqlite path", async () => {
    const mod = await loadFreshHandlerModule();
    const resolved = mod.resolveUrl(buildHookCfg("/root/.openclaw/mission-control/events.db"));

    expect(resolved).toBe("/root/.openclaw/mission-control/events.db");
  });
});