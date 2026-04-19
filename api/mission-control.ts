/// <reference path="../better-sqlite3.d.ts" />

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import Database from "better-sqlite3";
import type { ViteDevServer } from "vite";

interface TaskRow {
  id: number;
  runId: string;
  sessionKey: string;
  sessionId: string | null;
  agentId: string;
  status: string;
  title: string | null;
  description: string | null;
  prompt: string | null;
  response: string | null;
  error: string | null;
  source: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  estimatedCostUsd: number | null;
  responseUsage: string | null;
  timestamp: string;
  createdAt: string;
}

interface EventRow {
  id: number;
  runId: string;
  sessionKey: string;
  sessionId: string | null;
  eventType: string;
  action: string;
  title: string | null;
  description: string | null;
  message: string | null;
  data: string | null;
  timestamp: string;
  createdAt: string;
}

interface DocumentRow {
  id: number;
  runId: string;
  sessionKey: string;
  sessionId: string | null;
  agentId: string;
  title: string | null;
  description: string | null;
  content: string | null;
  type: string | null;
  path: string | null;
  eventType: string | null;
  timestamp: string;
  createdAt: string;
}

interface LogsQueryOptions {
  page: number;
  pageSize: number;
  status?: string;
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  source?: string;
  q?: string;
  timeFrom?: string;
  timeTo?: string;
  outcome?: "success" | "failed";
  eventType?: string;
  action?: string;
  includeEvents: boolean;
  includeDocuments: boolean;
  eventsLimit: number;
  documentsLimit: number;
}

function resolveDbPath() {
  const fromEnv = (process.env.MISSION_CONTROL_DB_PATH || process.env.SQLITE_DB_PATH || "").trim();
  if (fromEnv) return path.resolve(fromEnv);
  return "/root/.openclaw/mission-control/events.db";
}

const dbPath = resolveDbPath();
let db: any | null = null;

function openDb() {
  if (db) return db;
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database file not found at ${dbPath}`);
  }
  db = new Database(dbPath, { fileMustExist: true, readonly: true });
  return db;
}

function safeQuery<T extends object>(sql: string, params?: Record<string, unknown>): T[] | { __error: string } {
  try {
    return openDb().prepare(sql).all(params ?? {}) as T[];
  } catch (error) {
    return { __error: error instanceof Error ? error.message : String(error) };
  }
}

function parseBooleanParam(value: string | null, defaultValue: boolean) {
  if (value === null) return defaultValue;
  const normalized = value.toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return defaultValue;
}

function parsePositiveInt(value: string | null, defaultValue: number, maxValue: number) {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultValue;
  return Math.min(parsed, maxValue);
}

function parseJsonValue(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function buildTaskFilters(options: LogsQueryOptions) {
  const where: string[] = [];
  const bindings: Record<string, unknown> = {};

  if (options.status) {
    where.push("t.status = @status");
    bindings.status = options.status;
  }

  if (options.agentId) {
    where.push("t.agentId = @agentId");
    bindings.agentId = options.agentId;
  }

  if (options.sessionKey) {
    where.push("t.sessionKey = @sessionKey");
    bindings.sessionKey = options.sessionKey;
  }

  if (options.runId) {
    where.push("t.runId = @runId");
    bindings.runId = options.runId;
  }

  if (options.source) {
    where.push("COALESCE(t.source, '') = @source");
    bindings.source = options.source;
  }

  if (options.q) {
    where.push(`(
      COALESCE(t.runId, '') LIKE @q OR
      COALESCE(t.sessionKey, '') LIKE @q OR
      COALESCE(t.agentId, '') LIKE @q OR
      COALESCE(t.status, '') LIKE @q OR
      COALESCE(t.title, '') LIKE @q OR
      COALESCE(t.description, '') LIKE @q OR
      COALESCE(t.prompt, '') LIKE @q OR
      COALESCE(t.response, '') LIKE @q OR
      COALESCE(t.error, '') LIKE @q OR
      COALESCE(t.source, '') LIKE @q
    )`);
    bindings.q = `%${options.q}%`;
  }

  if (options.timeFrom) {
    where.push("COALESCE(t.timestamp, t.createdAt, '') >= @timeFrom");
    bindings.timeFrom = options.timeFrom;
  }

  if (options.timeTo) {
    where.push("COALESCE(t.timestamp, t.createdAt, '') <= @timeTo");
    bindings.timeTo = options.timeTo;
  }

  if (options.outcome === "success") {
    where.push("LOWER(COALESCE(t.status, '')) IN ('end', 'ok', 'success', 'completed', 'done')");
  }

  if (options.outcome === "failed") {
    where.push("(LOWER(COALESCE(t.status, '')) IN ('error', 'failed', 'abort', 'aborted') OR COALESCE(t.error, '') <> '')");
  }

  return {
    sql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    bindings,
  };
}

function appendRunIdBindings(baseBindings: Record<string, unknown>, runIds: string[], prefix: string) {
  const bindings = { ...baseBindings };
  const placeholders: string[] = [];

  runIds.forEach((runId, index) => {
    const key = `${prefix}${index}`;
    placeholders.push(`@${key}`);
    bindings[key] = runId;
  });

  return {
    bindings,
    inClause: placeholders.join(", "),
  };
}

function readLogs(options: LogsQueryOptions) {
  const page = Math.max(1, options.page);
  const pageSize = Math.max(1, options.pageSize);
  const offset = (page - 1) * pageSize;
  const taskFilters = buildTaskFilters(options);

  const countRows = safeQuery<{ total: number }>(
    `SELECT COUNT(*) AS total
     FROM tasks t
     INNER JOIN (
       SELECT runId, MAX(id) AS latestId
       FROM tasks
       GROUP BY runId
     ) latest ON latest.latestId = t.id
     ${taskFilters.sql}`,
    taskFilters.bindings
  );

  if ("__error" in countRows) {
    throw new Error(countRows.__error);
  }

  const total = countRows[0]?.total ?? 0;

  const tasks = safeQuery<TaskRow>(
    `SELECT t.id, t.runId, t.sessionKey, t.agentId, t.status, t.title, t.description,
          t.sessionId,
          t.inputTokens, t.outputTokens, t.cacheReadTokens, t.cacheWriteTokens,
          t.totalTokens, t.estimatedCostUsd, t.responseUsage,
            COALESCE(
              t.prompt,
              (
                SELECT ts.prompt
                FROM tasks ts
                WHERE ts.runId = t.runId
                  AND ts.status = 'start'
                  AND ts.prompt IS NOT NULL
                ORDER BY ts.id DESC
                LIMIT 1
              )
            ) AS prompt,
            t.response, t.error, t.source, t.timestamp, t.createdAt
     FROM tasks t
     INNER JOIN (
       SELECT runId, MAX(id) AS latestId
       FROM tasks
       GROUP BY runId
     ) latest ON latest.latestId = t.id
     ${taskFilters.sql}
     ORDER BY t.id DESC
     LIMIT @limit OFFSET @offset`,
    {
      ...taskFilters.bindings,
      limit: pageSize,
      offset,
    }
  );

  if ("__error" in tasks) {
    throw new Error(tasks.__error);
  }

  const runIds = Array.from(new Set(tasks.map((task) => task.runId).filter(Boolean)));
  let eventRows: EventRow[] = [];
  let documentRows: DocumentRow[] = [];

  if (runIds.length && options.includeEvents) {
    const runIdBindings = appendRunIdBindings({}, runIds, "eventRunId");
    const eventFilterClauses = [`runId IN (${runIdBindings.inClause})`];
    const eventBindings: Record<string, unknown> = {
      ...runIdBindings.bindings,
      eventsLimit: options.eventsLimit,
    };

    if (options.eventType) {
      eventFilterClauses.push("eventType = @eventType");
      eventBindings.eventType = options.eventType;
    }

    if (options.action) {
      eventFilterClauses.push("action = @action");
      eventBindings.action = options.action;
    }

    const events = safeQuery<EventRow>(
      `SELECT id, runId, sessionKey, sessionId, eventType, action, title, description, message, data, timestamp, createdAt
       FROM events
       WHERE ${eventFilterClauses.join(" AND ")}
       ORDER BY id DESC
       LIMIT @eventsLimit`,
      eventBindings
    );

    if (!("__error" in events)) {
      eventRows = events;
    }
  }

  if (runIds.length && options.includeDocuments) {
    const runIdBindings = appendRunIdBindings({}, runIds, "docRunId");
    const documents = safeQuery<DocumentRow>(
      `SELECT id, runId, sessionKey, sessionId, agentId, title, description, content, type, path, eventType, timestamp, createdAt
       FROM documents
       WHERE runId IN (${runIdBindings.inClause})
       ORDER BY id DESC
       LIMIT @documentsLimit`,
      {
        ...runIdBindings.bindings,
        documentsLimit: options.documentsLimit,
      }
    );

    if (!("__error" in documents)) {
      documentRows = documents;
    }
  }

  const eventsByRunId = new Map<string, EventRow[]>();
  const documentsByRunId = new Map<string, DocumentRow[]>();

  for (const event of eventRows) {
    if (!eventsByRunId.has(event.runId)) {
      eventsByRunId.set(event.runId, []);
    }
    eventsByRunId.get(event.runId)!.push(event);
  }

  for (const document of documentRows) {
    if (!documentsByRunId.has(document.runId)) {
      documentsByRunId.set(document.runId, []);
    }
    documentsByRunId.get(document.runId)!.push(document);
  }

  return {
    dbPath,
    generatedAt: new Date().toISOString(),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: total > 0 ? Math.ceil(total / pageSize) : 0,
      hasPrev: page > 1,
      hasNext: offset + tasks.length < total,
    },
    filters: {
      status: options.status ?? null,
      agentId: options.agentId ?? null,
      sessionKey: options.sessionKey ?? null,
      runId: options.runId ?? null,
      source: options.source ?? null,
      q: options.q ?? null,
      timeFrom: options.timeFrom ?? null,
      timeTo: options.timeTo ?? null,
      outcome: options.outcome ?? null,
      eventType: options.eventType ?? null,
      action: options.action ?? null,
      includeEvents: options.includeEvents,
      includeDocuments: options.includeDocuments,
      eventsLimit: options.eventsLimit,
      documentsLimit: options.documentsLimit,
    },
    tasks: tasks.map((task) => ({
      ...task,
      responseUsage: parseJsonValue(task.responseUsage),
      events: eventsByRunId.get(task.runId) || [],
      documents: documentsByRunId.get(task.runId) || [],
    })),
    events: eventRows,
    documents: documentRows,
  };
}

function sendJson(res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void }, body: unknown, statusCode = 200) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export function registerMissionControlApi(server: ViteDevServer) {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = req.url || "/";
    const parsed = new URL(requestUrl, "http://localhost");
    const pathname = parsed.pathname;

    const normalized = pathname
      .replace(/^\/apis\/mission-control/, "")
      .replace(/^\/api\/mission-control/, "") || "/";

    if (normalized === "/health") {
      sendJson(res, { ok: true, service: "mission-control", dbPath });
      return;
    }

    if (normalized === "/logs") {
      try {
        const params = parsed.searchParams;
        const payload = readLogs({
          page: parsePositiveInt(params.get("page"), 1, 100000),
          pageSize: parsePositiveInt(params.get("pageSize"), 120, 500),
          status: params.get("status") || undefined,
          agentId: params.get("agentId") || undefined,
          sessionKey: params.get("sessionKey") || undefined,
          runId: params.get("runId") || undefined,
          source: params.get("source") || undefined,
          q: params.get("q") || undefined,
          timeFrom: params.get("timeFrom") || undefined,
          timeTo: params.get("timeTo") || undefined,
          outcome: (() => {
            const value = params.get("outcome") || "";
            return value === "success" || value === "failed" ? value : undefined;
          })(),
          eventType: params.get("eventType") || undefined,
          action: params.get("action") || undefined,
          includeEvents: parseBooleanParam(params.get("includeEvents"), true),
          includeDocuments: parseBooleanParam(params.get("includeDocuments"), true),
          eventsLimit: parsePositiveInt(params.get("eventsLimit"), 240, 2000),
          documentsLimit: parsePositiveInt(params.get("documentsLimit"), 120, 2000),
        });
        sendJson(res, payload);
      } catch (error) {
        sendJson(
          res,
          {
            error: error instanceof Error ? error.message : String(error),
            dbPath,
          },
          500
        );
      }
      return;
    }

    sendJson(res, { error: "Not Found" }, 404);
  };

  server.middlewares.use("/api/mission-control", handler);
  server.middlewares.use("/apis/mission-control", handler);
}
