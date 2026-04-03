// run with `npm run dev:logs-dashboard` to start a local server that serves a dashboard for viewing logs from the SQLite database used by Mission Control. 
// The dashboard is accessible at http://localhost:8083 by default, and it reads from the database file specified by the MISSION_CONTROL_DB_PATH or 
// SQLITE_DB_PATH environment variable (or defaults to /root/.openclaw/mission-control/events.db).
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const PORT = Number(process.env.LOGS_DASHBOARD_PORT || 8083);
const HOST = process.env.LOGS_DASHBOARD_HOST || "127.0.0.1";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const htmlPath = path.join(__dirname, "logs-dashboard.html");

function resolveDbPath() {
  const fromEnv = (process.env.MISSION_CONTROL_DB_PATH || process.env.SQLITE_DB_PATH || "").trim();
  if (fromEnv) return path.resolve(fromEnv);
  return "/root/.openclaw/mission-control/events.db";
}

const dbPath = resolveDbPath();
let db = null;

function openDb() {
  if (db) return db;
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database file not found at ${dbPath}`);
  }
  db = new Database(dbPath, { fileMustExist: true, readonly: true });
  return db;
}

function safeQuery(sql) {
  try {
    return openDb().prepare(sql).all();
  } catch (error) {
    return { __error: error instanceof Error ? error.message : String(error) };
  }
}

function readLogs() {
  const tasks = safeQuery(
    `SELECT t.id, t.runId, t.sessionKey, t.agentId, t.status, t.title, t.description, t.prompt, t.response, t.error, t.source, t.timestamp, t.createdAt
     FROM tasks t
     INNER JOIN (
       SELECT runId, MAX(id) AS latestId
       FROM tasks
       GROUP BY runId
     ) latest ON latest.latestId = t.id
     ORDER BY t.id DESC
     LIMIT 120`
  );

  const events = safeQuery(
    `SELECT id, runId, sessionKey, eventType, action, title, description, message, data, timestamp, createdAt
     FROM events
     ORDER BY id DESC
     LIMIT 240`
  );

  const documents = safeQuery(
    `SELECT id, runId, sessionKey, agentId, title, description, content, type, path, eventType, timestamp, createdAt
     FROM documents
     ORDER BY id DESC
     LIMIT 120`
  );

  // Index events and documents by runId for efficient lookup
  const eventsByRunId = new Map();
  const documentsByRunId = new Map();

  for (const event of Array.isArray(events) && !events.__error ? events : []) {
    if (!eventsByRunId.has(event.runId)) {
      eventsByRunId.set(event.runId, []);
    }
    eventsByRunId.get(event.runId).push(event);
  }

  for (const doc of Array.isArray(documents) && !documents.__error ? documents : []) {
    if (!documentsByRunId.has(doc.runId)) {
      documentsByRunId.set(doc.runId, []);
    }
    documentsByRunId.get(doc.runId).push(doc);
  }

  // Attach related events and documents to each task
  const enrichedTasks = (Array.isArray(tasks) && !tasks.__error ? tasks : []).map(task => ({
    ...task,
    events: eventsByRunId.get(task.runId) || [],
    documents: documentsByRunId.get(task.runId) || [],
  }));

  return {
    dbPath,
    generatedAt: new Date().toISOString(),
    tasks: enrichedTasks,
    events,
    documents,
  };
}

function sendJson(res, body, statusCode = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readDashboardHtml() {
  if (!fs.existsSync(htmlPath)) {
    return "<h1>Missing logs-dashboard.html</h1>";
  }
  return fs.readFileSync(htmlPath, "utf8");
}

const server = http.createServer((req, res) => {
  const url = req.url || "/";

  const normalized =
    url === "/logs" || url.startsWith("/logs?")
      ? "/"
      : url === "/logs/" || url.startsWith("/logs/?")
        ? "/"
        : url.startsWith("/logs/api/logs")
          ? "/api/logs"
          : url;

  if (normalized === "/health" || url === "/logs/health") {
    sendJson(res, { ok: true, service: "logs-dashboard", dbPath });
    return;
  }

  if (normalized === "/api/logs") {
    try {
      const payload = readLogs();
      if (payload.tasks && payload.tasks.__error) {
        sendJson(
          res,
          {
            error: `Unable to query logs: ${payload.tasks.__error}`,
            dbPath,
          },
          500
        );
        return;
      }

      sendJson(res, payload);
      return;
    } catch (error) {
      sendJson(
        res,
        {
          error: error instanceof Error ? error.message : String(error),
          dbPath,
        },
        500
      );
      return;
    }
  }

  if (normalized === "/" || normalized === "/index.html" || normalized.startsWith("/?") || normalized.startsWith("/index.html?")) {
    const html = readDashboardHtml();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (normalized === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

server.listen(PORT, HOST, () => {
  console.log(`Mission Control logs dashboard is running at http://${HOST}:${PORT}`);
  console.log(`Reading SQLite logs from: ${dbPath}`);
});