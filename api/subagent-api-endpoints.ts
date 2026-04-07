declare const require: (id: string) => any;

const fs = require("node:fs");
const path = require("node:path");
import {
  invokeGatewayMethod,
  parseJsonBody,
  readRequestBody,
  sendJson,
  type HttpRequestLike,
  type HttpResponseLike,
} from "./gateway-rpc";

type ViteDevServerLike = {
  middlewares: {
    use: (path: string, handler: (req: HttpRequestLike, res: HttpResponseLike) => void) => void;
  };
};

/**
 * Subagent API endpoint catalog + middleware for OpenClaw Gateway.
 *
 * Assumptions from deployment:
 * - Repo checkout: /opt/openclaw/moltbot
 * - State dir: /root/.openclaw
 * - Gateway port: 18789 (default)
 *
 * Important: there is no dedicated public JSON-RPC method named "sessions.spawn".
 * Subagent spawning is performed via the sessions_spawn tool during an agent/chat run.
 */

export const GATEWAY_HOST = "127.0.0.1";
export const GATEWAY_PORT = 18789;

export const GATEWAY_HTTP_BASE = `http://${GATEWAY_HOST}:${GATEWAY_PORT}`;
export const GATEWAY_WS_BASE = `ws://${GATEWAY_HOST}:${GATEWAY_PORT}`;

/** Gateway WebSocket endpoint used by the dashboard/client. */
export const GATEWAY_RPC_WS_ENDPOINT = `${GATEWAY_WS_BASE}/ws`;

export const SUBAGENT_STORAGE = {
  stateDir: "/root/.openclaw",
  subagentRunsFile: "/root/.openclaw/subagents/runs.json",
  taskLedgerSqlite: "/root/.openclaw/tasks/runs.sqlite",
  sessionsDir: "/root/.openclaw/agents",
};

export const SUBAGENT_RPC_METHODS = {
  listSessions: "sessions.list",
  previewSession: "sessions.preview",
  chatHistory: "chat.history",
  send: "sessions.send",
  steer: "sessions.steer",
  abort: "sessions.abort",
  patch: "sessions.patch",
  reset: "sessions.reset",
  deleteSession: "sessions.delete",
  runAgent: "agent",
  runChat: "chat.send",
} as const;

export type SubagentRpcMethod =
  (typeof SUBAGENT_RPC_METHODS)[keyof typeof SUBAGENT_RPC_METHODS];

export type SubagentRpcRequest<TParams = unknown> = {
  type: "req";
  id: string | number;
  method: SubagentRpcMethod;
  params: TParams;
};

/** Tool names relevant to subagent creation/management during an agent run. */
export const SUBAGENT_TOOL_NAMES = {
  spawn: "sessions_spawn",
  list: "subagents",
} as const;

type PersistedSubagentRuns = {
  version?: number;
  runs?: Record<string, unknown>;
};

type SessionsIndexEntry = {
  key: string;
  sessionId?: string;
  label?: string;
  sessionFile?: string;
  [key: string]: unknown;
};

function readJsonFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function readSubagentRuns() {
  const file = SUBAGENT_STORAGE.subagentRunsFile;
  if (!fs.existsSync(file)) {
    return {
      exists: false,
      file,
      total: 0,
      runs: [] as Array<{ runId: string; entry: unknown }>,
    };
  }

  const parsed = readJsonFile(file) as PersistedSubagentRuns;
  const runsRecord = parsed && typeof parsed.runs === "object" && parsed.runs ? parsed.runs : {};
  const runs = Object.entries(runsRecord).map(([runId, entry]) => ({ runId, entry }));
  runs.sort((a, b) => {
    const aTs = Number((a.entry as { startedAt?: unknown })?.startedAt || 0);
    const bTs = Number((b.entry as { startedAt?: unknown })?.startedAt || 0);
    return bTs - aTs;
  });

  return {
    exists: true,
    file,
    version: parsed.version,
    total: runs.length,
    runs,
  };
}

function listSubagentSessions() {
  const baseDir = SUBAGENT_STORAGE.sessionsDir;
  if (!fs.existsSync(baseDir)) {
    return {
      exists: false,
      baseDir,
      total: 0,
      sessions: [] as SessionsIndexEntry[],
    };
  }

  const sessions: SessionsIndexEntry[] = [];
  const agentIds = fs.readdirSync(baseDir, { withFileTypes: true });

  for (const agentDirEnt of agentIds) {
    if (!agentDirEnt.isDirectory()) {
      continue;
    }
    const sessionsFile = path.join(baseDir, agentDirEnt.name, "sessions", "sessions.json");
    if (!fs.existsSync(sessionsFile)) {
      continue;
    }
    try {
      const parsed = readJsonFile(sessionsFile) as Record<string, SessionsIndexEntry>;
      for (const entry of Object.values(parsed)) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const key = typeof entry.key === "string" ? entry.key : "";
        if (!key.includes(":subagent:")) {
          continue;
        }
        sessions.push(entry);
      }
    } catch {
      // Ignore malformed session stores and continue.
    }
  }

  return {
    exists: true,
    baseDir,
    total: sessions.length,
    sessions,
  };
}

export function buildSubagentRpcRequest<TParams>(
  id: string | number,
  method: SubagentRpcMethod,
  params: TParams,
): SubagentRpcRequest<TParams> {
  return {
    type: "req",
    id,
    method,
    params,
  };
}

export function subagentMethodList(): SubagentRpcMethod[] {
  return Object.values(SUBAGENT_RPC_METHODS);
}

async function readJsonRequestBody<T = Record<string, unknown>>(req: HttpRequestLike): Promise<T> {
  const rawBody = await readRequestBody(req);
  if (!rawBody.trim()) {
    return {} as T;
  }
  return parseJsonBody(rawBody) as T;
}

async function proxySubagentMethod(res: HttpResponseLike, method: SubagentRpcMethod, params: unknown) {
  try {
    const response = await invokeGatewayMethod(method, params);
    sendJson(res, {
      ok: response.ok,
      method,
      response,
    });
  } catch (error) {
    sendJson(
      res,
      {
        ok: false,
        method,
        error: error instanceof Error ? error.message : String(error),
      },
      502,
    );
  }
}

/**
 * Registers subagent helper endpoints and write-through action proxies:
 * - GET  /api/subagents/health
 * - GET  /api/subagents/methods
 * - GET  /api/subagents/storage
 * - GET  /api/subagents/runs
 * - GET  /api/subagents/sessions
 * - POST /api/subagents/sessions/send
 * - POST /api/subagents/sessions/steer
 * - POST /api/subagents/sessions/abort
 * - POST /api/subagents/sessions/patch
 * - POST /api/subagents/sessions/reset
 * - DELETE /api/subagents/sessions/delete
 * - POST /api/subagents/agent
 * - POST /api/subagents/chat/send
 * - POST /api/subagents/rpc
 */
export function registerSubagentApi(server: ViteDevServerLike) {
  const handler = async (req: HttpRequestLike, res: HttpResponseLike) => {
    const requestUrl = req.url || "/";
    const parsed = new URL(requestUrl, "http://localhost");
    const pathname = parsed.pathname;
    const normalized =
      pathname.replace(/^\/apis\/subagents/, "").replace(/^\/api\/subagents/, "") || "/";
    const method = (req.method || "GET").toUpperCase();

    if (method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.end("");
      return;
    }

    try {
      if (normalized === "/health") {
        sendJson(res, {
          ok: true,
          service: "subagents",
          gateway: {
            http: GATEWAY_HTTP_BASE,
            ws: GATEWAY_RPC_WS_ENDPOINT,
          },
        });
        return;
      }

      if (normalized === "/methods") {
        sendJson(res, {
          methods: SUBAGENT_RPC_METHODS,
          tools: SUBAGENT_TOOL_NAMES,
          list: subagentMethodList(),
        });
        return;
      }

      if (normalized === "/storage") {
        sendJson(res, {
          storage: SUBAGENT_STORAGE,
          exists: {
            stateDir: fs.existsSync(SUBAGENT_STORAGE.stateDir),
            runsFile: fs.existsSync(SUBAGENT_STORAGE.subagentRunsFile),
            taskLedgerSqlite: fs.existsSync(SUBAGENT_STORAGE.taskLedgerSqlite),
            sessionsDir: fs.existsSync(SUBAGENT_STORAGE.sessionsDir),
          },
        });
        return;
      }

      if (normalized === "/runs" && method === "GET") {
        sendJson(res, readSubagentRuns());
        return;
      }

      if (normalized === "/sessions" && method === "GET") {
        sendJson(res, listSubagentSessions());
        return;
      }

      if ((normalized === "/sessions/send" || normalized === "/send") && method === "POST") {
        await proxySubagentMethod(res, SUBAGENT_RPC_METHODS.send, await readJsonRequestBody(req));
        return;
      }

      if ((normalized === "/sessions/steer" || normalized === "/steer") && method === "POST") {
        await proxySubagentMethod(res, SUBAGENT_RPC_METHODS.steer, await readJsonRequestBody(req));
        return;
      }

      if ((normalized === "/sessions/abort" || normalized === "/abort") && method === "POST") {
        await proxySubagentMethod(res, SUBAGENT_RPC_METHODS.abort, await readJsonRequestBody(req));
        return;
      }

      if ((normalized === "/sessions/patch" || normalized === "/patch") && (method === "POST" || method === "PATCH" || method === "PUT")) {
        await proxySubagentMethod(res, SUBAGENT_RPC_METHODS.patch, await readJsonRequestBody(req));
        return;
      }

      if ((normalized === "/sessions/reset" || normalized === "/reset") && method === "POST") {
        await proxySubagentMethod(res, SUBAGENT_RPC_METHODS.reset, await readJsonRequestBody(req));
        return;
      }

      if ((normalized === "/sessions/delete" || normalized === "/delete") && (method === "POST" || method === "DELETE")) {
        await proxySubagentMethod(res, SUBAGENT_RPC_METHODS.deleteSession, await readJsonRequestBody(req));
        return;
      }

      if ((normalized === "/agent" || normalized === "/run-agent") && method === "POST") {
        await proxySubagentMethod(res, SUBAGENT_RPC_METHODS.runAgent, await readJsonRequestBody(req));
        return;
      }

      if ((normalized === "/chat/send" || normalized === "/run-chat") && method === "POST") {
        await proxySubagentMethod(res, SUBAGENT_RPC_METHODS.runChat, await readJsonRequestBody(req));
        return;
      }

      if (normalized === "/rpc" && method === "POST") {
        const body = await readJsonRequestBody<Record<string, unknown>>(req);
        const requestMethod = typeof body.method === "string" ? body.method : "";
        if (!Object.values(SUBAGENT_RPC_METHODS).includes(requestMethod as SubagentRpcMethod)) {
          sendJson(res, { error: "Unsupported subagent method", method: requestMethod }, 400);
          return;
        }
        await proxySubagentMethod(res, requestMethod as SubagentRpcMethod, body.params);
        return;
      }

      if (
        normalized === "/sessions/send" ||
        normalized === "/send" ||
        normalized === "/sessions/steer" ||
        normalized === "/steer" ||
        normalized === "/sessions/abort" ||
        normalized === "/abort" ||
        normalized === "/sessions/patch" ||
        normalized === "/patch" ||
        normalized === "/sessions/reset" ||
        normalized === "/reset" ||
        normalized === "/sessions/delete" ||
        normalized === "/delete" ||
        normalized === "/agent" ||
        normalized === "/run-agent" ||
        normalized === "/chat/send" ||
        normalized === "/run-chat" ||
        normalized === "/rpc"
      ) {
        sendJson(res, { error: "Method not allowed" }, 405);
        return;
      }

      sendJson(res, { error: "Not Found" }, 404);
    } catch (error) {
      sendJson(
        res,
        {
          error: error instanceof Error ? error.message : String(error),
          storage: SUBAGENT_STORAGE,
        },
        500,
      );
    }
  };

  server.middlewares.use("/api/subagents", handler);
  server.middlewares.use("/apis/subagents", handler);
}
