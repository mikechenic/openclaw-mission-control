import fs from "node:fs";
import path from "node:path";
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
 * Cron API endpoint catalog + middleware for OpenClaw Gateway.
 *
 * Assumptions from deployment:
 * - Repo checkout: /opt/openclaw/moltbot
 * - State dir: /root/.openclaw
 * - Gateway port: 18789 (default)
 */

export const GATEWAY_HOST = "127.0.0.1";
export const GATEWAY_PORT = 18789;

export const GATEWAY_HTTP_BASE = `http://${GATEWAY_HOST}:${GATEWAY_PORT}`;
export const GATEWAY_WS_BASE = `ws://${GATEWAY_HOST}:${GATEWAY_PORT}`;

/** Gateway WebSocket endpoint used by the dashboard/client. */
export const GATEWAY_RPC_WS_ENDPOINT = `${GATEWAY_WS_BASE}/ws`;

export const CRON_STORAGE = {
  stateDir: "/root/.openclaw",
  jobsFile: "/root/.openclaw/cron/jobs.json",
  runsDir: "/root/.openclaw/cron/runs",
};

export const CRON_RPC_METHODS = {
  list: "cron.list",
  status: "cron.status",
  add: "cron.add",
  update: "cron.update",
  remove: "cron.remove",
  run: "cron.run",
  runs: "cron.runs",
  wake: "wake",
} as const;

export type CronRpcMethod = (typeof CRON_RPC_METHODS)[keyof typeof CRON_RPC_METHODS];

export type CronRpcRequest<TParams = unknown> = {
  type: "req";
  id: string | number;
  method: CronRpcMethod;
  params: TParams;
};

type CronRunLogEntry = {
  ts?: number;
  jobId?: string;
  action?: string;
  status?: string;
  error?: string;
  summary?: string;
  sessionKey?: string;
};

type CronJobsStore = {
  version?: number;
  jobs?: unknown[];
};

function readJsonFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function listCronJobs() {
  if (!fs.existsSync(CRON_STORAGE.jobsFile)) {
    return {
      exists: false,
      file: CRON_STORAGE.jobsFile,
      jobs: [] as unknown[],
    };
  }

  const parsed = readJsonFile(CRON_STORAGE.jobsFile) as CronJobsStore;
  const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  return {
    exists: true,
    file: CRON_STORAGE.jobsFile,
    version: parsed.version,
    total: jobs.length,
    jobs,
  };
}

function findCronJobById(jobId: string) {
  const store = listCronJobs();
  if (!store.exists || !Array.isArray(store.jobs)) {
    return null;
  }
  return store.jobs.find((job) => {
    if (!job || typeof job !== "object") {
      return false;
    }
    const candidateId = typeof (job as { id?: unknown }).id === "string" ? (job as { id: string }).id : "";
    return candidateId === jobId;
  }) ?? null;
}

function splitCronJobRoute(normalized: string) {
  if (!normalized.startsWith("/jobs/")) {
    return null;
  }
  const remainder = normalized.slice("/jobs/".length).trim();
  if (!remainder) {
    return null;
  }
  const parts = remainder.split("/").filter(Boolean);
  if (!parts.length) {
    return null;
  }
  return {
    jobId: decodeURIComponent(parts[0] || "").trim(),
    tail: parts.slice(1).join("/"),
  };
}

function parseRunLogFile(filePath: string, limit: number): CronRunLogEntry[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw
    .split("\n")
    .map((line: string) => line.trim())
    .filter(Boolean);
  const out: CronRunLogEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const parsed = JSON.parse(lines[i] as string) as CronRunLogEntry;
      out.push(parsed);
    } catch {
      // Ignore malformed lines.
    }
  }
  return out;
}

function listCronRuns(jobId: string | null, limit: number) {
  const runsDir = CRON_STORAGE.runsDir;
  if (!fs.existsSync(runsDir)) {
    return {
      exists: false,
      dir: runsDir,
      totalFiles: 0,
      runs: [] as CronRunLogEntry[],
    };
  }

  const fileNames = fs
    .readdirSync(runsDir)
    .filter((name: string) => name.endsWith(".jsonl"))
    .filter((name: string) => (jobId ? name === `${jobId}.jsonl` : true));

  const runs: CronRunLogEntry[] = [];
  for (const name of fileNames) {
    const filePath = path.join(runsDir, name);
    const entries = parseRunLogFile(filePath, limit);
    runs.push(...entries);
  }

  runs.sort((a, b) => (Number(b.ts ?? 0) || 0) - (Number(a.ts ?? 0) || 0));

  return {
    exists: true,
    dir: runsDir,
    totalFiles: fileNames.length,
    runs: runs.slice(0, limit),
  };
}

export function buildCronRpcRequest<TParams>(
  id: string | number,
  method: CronRpcMethod,
  params: TParams,
): CronRpcRequest<TParams> {
  return {
    type: "req",
    id,
    method,
    params,
  };
}

export function cronMethodList(): CronRpcMethod[] {
  return Object.values(CRON_RPC_METHODS);
}

async function readJsonRequestBody<T = Record<string, unknown>>(req: HttpRequestLike): Promise<T> {
  const rawBody = await readRequestBody(req);
  if (!rawBody.trim()) {
    return {} as T;
  }
  return parseJsonBody(rawBody) as T;
}

async function proxyCronMethod(res: HttpResponseLike, method: CronRpcMethod, params: unknown) {
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
 * Registers cron helper endpoints and write-through action proxies:
 * - GET  /api/cron/health
 * - GET  /api/cron/methods
 * - GET  /api/cron/storage
 * - GET  /api/cron/jobs
 * - GET  /api/cron/jobs/<jobId>
 * - PATCH /api/cron/jobs/<jobId>
 * - PUT   /api/cron/jobs/<jobId>
 * - DELETE /api/cron/jobs/<jobId>
 * - GET  /api/cron/runs?jobId=<id>&limit=200
 * - POST /api/cron/jobs            -> cron.add
 * - PATCH /api/cron/jobs           -> cron.update
 * - DELETE /api/cron/jobs          -> cron.remove
 * - POST /api/cron/jobs/<jobId>/run -> cron.run
 * - POST /api/cron/run-now         -> cron.run with mode=force
 * - POST /api/cron/wake            -> wake
 * - POST /api/cron/rpc             -> generic method proxy
 */
export function registerCronApi(server: ViteDevServerLike) {
  const handler = async (req: HttpRequestLike, res: HttpResponseLike) => {
    const requestUrl = req.url || "/";
    const parsed = new URL(requestUrl, "http://localhost");
    const pathname = parsed.pathname;
    const normalized = pathname.replace(/^\/apis\/cron/, "").replace(/^\/api\/cron/, "") || "/";
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
          service: "cron",
          gateway: {
            http: GATEWAY_HTTP_BASE,
            ws: GATEWAY_RPC_WS_ENDPOINT,
          },
        });
        return;
      }

      if (normalized === "/methods") {
        sendJson(res, {
          methods: CRON_RPC_METHODS,
          list: cronMethodList(),
        });
        return;
      }

      if (normalized === "/storage") {
        sendJson(res, {
          storage: CRON_STORAGE,
          exists: {
            stateDir: fs.existsSync(CRON_STORAGE.stateDir),
            jobsFile: fs.existsSync(CRON_STORAGE.jobsFile),
            runsDir: fs.existsSync(CRON_STORAGE.runsDir),
          },
        });
        return;
      }

      if (normalized === "/jobs" && method === "GET") {
        sendJson(res, listCronJobs());
        return;
      }

      const jobRoute = splitCronJobRoute(normalized);
      if (jobRoute) {
        if (!jobRoute.jobId) {
          sendJson(res, { error: "Missing cron job id" }, 400);
          return;
        }

        if (jobRoute.tail === "") {
          if (method === "GET") {
            const job = findCronJobById(jobRoute.jobId);
            if (!job) {
              sendJson(res, { error: `Cron job '${jobRoute.jobId}' not found` }, 404);
              return;
            }
            sendJson(res, { ok: true, job });
            return;
          }

          if (method === "PATCH" || method === "PUT") {
            const body = await readJsonRequestBody<Record<string, unknown>>(req);
            await proxyCronMethod(res, CRON_RPC_METHODS.update, {
              id: jobRoute.jobId,
              ...body,
            });
            return;
          }

          if (method === "DELETE") {
            await proxyCronMethod(res, CRON_RPC_METHODS.remove, {
              id: jobRoute.jobId,
            });
            return;
          }
        }

        if (jobRoute.tail === "run" && method === "POST") {
          const body = await readJsonRequestBody<Record<string, unknown>>(req);
          await proxyCronMethod(res, CRON_RPC_METHODS.run, {
            id: jobRoute.jobId,
            ...body,
            mode: typeof body.mode === "string" ? body.mode : "force",
          });
          return;
        }

        sendJson(res, { error: "Not Found" }, 404);
        return;
      }

      if (normalized === "/runs" && method === "GET") {
        const requestedJobId = (parsed.searchParams.get("jobId") || "").trim();
        const requestedLimitRaw = Number.parseInt(parsed.searchParams.get("limit") || "200", 10);
        const limit = Number.isFinite(requestedLimitRaw)
          ? Math.max(1, Math.min(5000, requestedLimitRaw))
          : 200;
        sendJson(res, listCronRuns(requestedJobId || null, limit));
        return;
      }

      if (normalized === "/jobs" && method === "POST") {
        await proxyCronMethod(res, CRON_RPC_METHODS.add, await readJsonRequestBody(req));
        return;
      }

      if (normalized === "/jobs" && (method === "PATCH" || method === "PUT")) {
        await proxyCronMethod(res, CRON_RPC_METHODS.update, await readJsonRequestBody(req));
        return;
      }

      if (normalized === "/jobs" && method === "DELETE") {
        await proxyCronMethod(res, CRON_RPC_METHODS.remove, await readJsonRequestBody(req));
        return;
      }

      if (normalized === "/add" && method === "POST") {
        await proxyCronMethod(res, CRON_RPC_METHODS.add, await readJsonRequestBody(req));
        return;
      }

      if ((normalized === "/update" || normalized === "/patch") && (method === "POST" || method === "PATCH" || method === "PUT")) {
        await proxyCronMethod(res, CRON_RPC_METHODS.update, await readJsonRequestBody(req));
        return;
      }

      if ((normalized === "/delete" || normalized === "/remove") && (method === "POST" || method === "DELETE")) {
        await proxyCronMethod(res, CRON_RPC_METHODS.remove, await readJsonRequestBody(req));
        return;
      }

      if ((normalized === "/run-now" || normalized === "/run") && method === "POST") {
        const params = await readJsonRequestBody<Record<string, unknown>>(req);
        await proxyCronMethod(res, CRON_RPC_METHODS.run, {
          ...params,
          mode: typeof params.mode === "string" ? params.mode : "force",
        });
        return;
      }

      if (normalized === "/wake" && method === "POST") {
        await proxyCronMethod(res, CRON_RPC_METHODS.wake, await readJsonRequestBody(req));
        return;
      }

      if (normalized === "/rpc" && method === "POST") {
        const body = await readJsonRequestBody<Record<string, unknown>>(req);
        const requestMethod = typeof body.method === "string" ? body.method : "";
        if (!Object.values(CRON_RPC_METHODS).includes(requestMethod as CronRpcMethod)) {
          sendJson(res, { error: "Unsupported cron method", method: requestMethod }, 400);
          return;
        }
        await proxyCronMethod(res, requestMethod as CronRpcMethod, body.params);
        return;
      }

      if (
        normalized === "/jobs" ||
        normalized === "/add" ||
        normalized === "/update" ||
        normalized === "/patch" ||
        normalized === "/delete" ||
        normalized === "/remove" ||
        normalized === "/run-now" ||
        normalized === "/run" ||
        normalized === "/wake" ||
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
          storage: CRON_STORAGE,
        },
        500,
      );
    }
  };

  server.middlewares.use("/api/cron", handler);
  server.middlewares.use("/apis/cron", handler);
}
