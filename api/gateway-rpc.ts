declare const require: (id: string) => any;
declare const process: { env: Record<string, string | undefined> };

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const JSON5 = require("json5");

export type HttpRequestLike = {
  url?: string;
  method?: string;
  on?: (event: "data" | "end" | "error", listener: (chunk?: unknown) => void) => void;
};

export type HttpResponseLike = {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: (body: string) => void;
};

export type GatewayRequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

export type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: unknown;
};

export type GatewayEventFrame = {
  type: "event";
  event: string;
  seq?: number;
  payload?: unknown;
};

export type GatewayFrame =
  | GatewayRequestFrame
  | GatewayResponseFrame
  | GatewayEventFrame
  | { type: string; [key: string]: unknown };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

let cachedGatewayAuthToken: string | null | undefined;

function toText(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Uint8Array) {
    return textDecoder.decode(data);
  }
  if (data instanceof ArrayBuffer) {
    return textDecoder.decode(new Uint8Array(data));
  }
  if (Array.isArray(data)) {
    const parts = data.map((chunk) => {
      if (typeof chunk === "string") {
        return textEncoder.encode(chunk);
      }
      if (chunk instanceof Uint8Array) {
        return chunk;
      }
      if (chunk instanceof ArrayBuffer) {
        return new Uint8Array(chunk);
      }
      return textEncoder.encode(String(chunk));
    });
    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    return textDecoder.decode(merged);
  }
  return String(data ?? "");
}

export function sendJson(res: HttpResponseLike, body: unknown, statusCode = 200) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.end(JSON.stringify(body));
}

export function readRequestBody(req: HttpRequestLike): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    if (!req.on) {
      resolve("");
      return;
    }
    req.on("data", (chunk) => {
      if (chunk === undefined || chunk === null) {
        return;
      }
      chunks.push(toText(chunk));
    });
    req.on("end", () => {
      resolve(chunks.join(""));
    });
    req.on("error", (error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export function parseJsonBody<T = unknown>(rawBody: string): T {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return {} as T;
  }
  return JSON5.parse(trimmed) as T;
}

export function resolveGatewayWsUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.OPENCLAW_GATEWAY_URL || env.OPENCLAW_GATEWAY_WS_URL || "").trim();
  if (!raw) {
    return "ws://127.0.0.1:18789/ws";
  }

  const normalized = raw.includes("://") ? new URL(raw) : new URL(`ws://${raw}`);
  if (normalized.protocol === "http:") {
    normalized.protocol = "ws:";
  }
  if (normalized.protocol === "https:") {
    normalized.protocol = "wss:";
  }
  if (!normalized.pathname || normalized.pathname === "/") {
    normalized.pathname = "/ws";
  }
  return normalized.toString();
}

function resolveGatewayConfigPath(env: Record<string, string | undefined> = process.env): string {
  const explicit = (env.OPENCLAW_CONFIG_PATH || "").trim();
  if (explicit) {
    return explicit;
  }
  const stateDir = (env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw")).trim();
  return path.join(stateDir, "openclaw.json");
}

function resolveGatewayAuthTokenFromConfig(env: Record<string, string | undefined> = process.env): string | null {
  try {
    const configPath = resolveGatewayConfigPath(env);
    if (!fs.existsSync(configPath)) {
      return null;
    }
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON5.parse(raw) as {
      gateway?: {
        auth?: { token?: unknown };
        remote?: { token?: unknown };
      };
    };
    const token = parsed.gateway?.auth?.token ?? parsed.gateway?.remote?.token;
    if (typeof token !== "string") {
      return null;
    }
    const trimmed = token.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

export function resolveGatewayAuthToken(env: Record<string, string | undefined> = process.env): string | null {
  if (cachedGatewayAuthToken !== undefined) {
    return cachedGatewayAuthToken;
  }

  const envToken = (env.OPENCLAW_GATEWAY_TOKEN || env.GATEWAY_AUTH_TOKEN || "").trim();
  if (envToken) {
    cachedGatewayAuthToken = envToken;
    return envToken;
  }

  cachedGatewayAuthToken = resolveGatewayAuthTokenFromConfig(env);
  return cachedGatewayAuthToken;
}

export function resetGatewayAuthTokenCache() {
  cachedGatewayAuthToken = undefined;
}

export type GatewayRpcClient = {
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<GatewayResponseFrame>;
  close: () => void;
};

export async function createGatewayRpcClient(params: {
  url?: string;
  token?: string | null;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
} = {}): Promise<GatewayRpcClient> {
  const url = params.url?.trim() || resolveGatewayWsUrl();
  const token = params.token ?? resolveGatewayAuthToken();
  if (!token) {
    throw new Error("Missing gateway auth token. Set OPENCLAW_GATEWAY_TOKEN or gateway.auth.token.");
  }

  const ws = new WebSocket(url, {
    handshakeTimeout: params.handshakeTimeoutMs ?? 8000,
    maxPayload: 25 * 1024 * 1024,
  });
  const pending = new Map<
    string,
    {
      resolve: (value: GatewayResponseFrame) => void;
      reject: (reason: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  const rejectAllPending = (reason: Error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(reason);
    }
    pending.clear();
  };

  const request = (method: string, requestParams?: unknown, timeoutMs = params.requestTimeoutMs ?? 12000) =>
    new Promise<GatewayResponseFrame>((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`gateway websocket is not open for ${method}`));
        return;
      }
      const id = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).toString();
      const frame: GatewayRequestFrame = {
        type: "req",
        id,
        method,
        params: requestParams,
      };
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for gateway method ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify(frame));
    });

  await new Promise<void>((resolve, reject) => {
    const openTimeout = setTimeout(() => {
      reject(new Error(`timeout opening gateway websocket at ${url}`));
    }, params.handshakeTimeoutMs ?? 8000);

    ws.once("open", () => {
      clearTimeout(openTimeout);
      resolve();
    });
    ws.once("error", (error: unknown) => {
      clearTimeout(openTimeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  const connectResponse = await request(
    "connect",
    {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "openclaw-api-endpoints",
        displayName: "OpenClaw API endpoints",
        version: "dev",
        platform: "dev",
        mode: "ui",
        instanceId: "openclaw-api-endpoints",
      },
      locale: "en-US",
      userAgent: "openclaw-api-endpoints",
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      caps: [],
      auth: { token },
    },
    params.requestTimeoutMs ?? 12000,
  );

  if (!connectResponse.ok) {
    ws.close();
    throw new Error(
      `gateway connect failed: ${JSON.stringify(connectResponse.error ?? connectResponse.payload ?? "unknown error")}`,
    );
  }

  ws.on("message", (data: unknown) => {
    const text = toText(data);
    let frame: GatewayFrame | null = null;
    try {
      frame = JSON.parse(text) as GatewayFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object" || !("type" in frame)) {
      return;
    }
    if (frame.type === "res") {
      const response = frame as GatewayResponseFrame;
      const waiter = pending.get(response.id);
      if (waiter) {
        pending.delete(response.id);
        clearTimeout(waiter.timeout);
        waiter.resolve(response);
      }
    }
  });

  ws.on("close", (code: number, reason: unknown) => {
    rejectAllPending(new Error(`gateway websocket closed (${code}): ${toText(reason)}`));
  });

  ws.on("error", (error: unknown) => {
    rejectAllPending(error instanceof Error ? error : new Error(String(error)));
  });

  return {
    request,
    close: () => {
      rejectAllPending(new Error("gateway websocket closed"));
      ws.close();
    },
  };
}

export async function invokeGatewayMethod(
  method: string,
  params?: unknown,
  options?: { url?: string; token?: string | null; timeoutMs?: number },
) {
  const client = await createGatewayRpcClient({
    url: options?.url,
    token: options?.token,
    requestTimeoutMs: options?.timeoutMs,
  });
  try {
    return await client.request(method, params, options?.timeoutMs);
  } finally {
    client.close();
  }
}
