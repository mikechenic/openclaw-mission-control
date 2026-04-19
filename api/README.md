# OpenClaw Mission Control API

This document describes all HTTP API endpoints implemented in this folder:

- [mission-control.ts](mission-control.ts)
- [cron-api-endpoints.ts](cron-api-endpoints.ts)
- [subagent-api-endpoints.ts](subagent-api-endpoints.ts)

Use this spec as the contract for programmatic clients (including LLM tools).

## 1) Base URLs

### Direct local service

The API service listens on local port `8084`.

- `http://127.0.0.1:8084/api/mission-control/...`
- `http://127.0.0.1:8084/apis/mission-control/...`
- `http://127.0.0.1:8084/api/cron/...`
- `http://127.0.0.1:8084/apis/cron/...`
- `http://127.0.0.1:8084/api/subagents/...`
- `http://127.0.0.1:8084/apis/subagents/...`

### Caddy reverse proxy (from provided config)

Through Caddy, these paths are exposed and proxied to `127.0.0.1:8084`:

- `/api/mission-control*`
- `/apis/mission-control*`
- `/api/cron*`
- `/apis/cron*`
- `/api/subagents*`
- `/apis/subagents*`

Use your Caddy host and scheme, for example:

- `https://<caddy-host>/api/mission-control/logs`
- `https://<caddy-host>/api/cron/health`
- `https://<caddy-host>/api/subagents/methods`

## 2) General behavior

- Content type: JSON (`application/json; charset=utf-8`).
- CORS: `Access-Control-Allow-Origin: *` and methods `GET, POST, PUT, PATCH, DELETE, OPTIONS`.
- For unsupported paths: `404` with `{ "error": "Not Found" }`.
- For wrong method on known path: `405` with `{ "error": "Method not allowed" }`.

## 3) Mission Control endpoints

Route roots (both supported):

- `/api/mission-control`
- `/apis/mission-control`

### GET /health

Purpose: health check and active DB path.

Response `200`:

```json
{
	"ok": true,
	"service": "mission-control",
	"dbPath": "/root/.openclaw/mission-control/events.db"
}
```

### GET /logs

Purpose: paginated mission-control task log stream, with optional embedded events/documents.

Query parameters:

- `page` (int, optional, default `1`, min `1`)
- `pageSize` (int, optional, default `120`, max `500`)
- `status` (string, optional)
- `agentId` (string, optional)
- `sessionKey` (string, optional)
- `runId` (string, optional)
- `source` (string, optional)
- `q` (string, optional, text search across key task fields)
- `timeFrom` (string, optional, ISO timestamp lower bound)
- `timeTo` (string, optional, ISO timestamp upper bound)
- `outcome` (optional enum: `success` | `failed`)
- `eventType` (string, optional, only affects embedded/top-level `events`)
- `action` (string, optional, only affects embedded/top-level `events`)
- `includeEvents` (bool-like, optional, default `true`)
- `includeDocuments` (bool-like, optional, default `true`)
- `eventsLimit` (int, optional, default `240`, max `2000`)
- `documentsLimit` (int, optional, default `120`, max `2000`)

Bool-like values accepted: `1|true|yes` and `0|false|no` (case-insensitive).

Response `200` shape:

```json
{
	"dbPath": "string",
	"generatedAt": "ISO-8601",
	"pagination": {
		"page": 1,
		"pageSize": 120,
		"total": 0,
		"totalPages": 0,
		"hasPrev": false,
		"hasNext": false
	},
	"filters": {
		"status": "string|null",
		"agentId": "string|null",
		"sessionKey": "string|null",
		"runId": "string|null",
		"source": "string|null",
		"q": "string|null",
		"timeFrom": "string|null",
		"timeTo": "string|null",
		"outcome": "success|failed|null",
		"eventType": "string|null",
		"action": "string|null",
		"includeEvents": true,
		"includeDocuments": true,
		"eventsLimit": 240,
		"documentsLimit": 120
	},
	"tasks": [
		{
			"id": 0,
			"runId": "string",
			"sessionKey": "string",
			"sessionId": "string|null",
			"agentId": "string",
			"status": "string",
			"title": "string|null",
			"description": "string|null",
			"prompt": "string|null",
			"response": "string|null",
			"error": "string|null",
			"source": "string|null",
			"inputTokens": 0,
			"outputTokens": 0,
			"cacheReadTokens": 0,
			"cacheWriteTokens": 0,
			"totalTokens": 0,
			"estimatedCostUsd": 0,
			"responseUsage": {},
			"timestamp": "string",
			"createdAt": "string",
			"events": [],
			"documents": []
		}
	],
	"events": [],
	"documents": []
}
```

Response `500`:

```json
{
	"error": "string",
	"dbPath": "string"
}
```

## 4) Cron endpoints

Route roots (both supported):

- `/api/cron`
- `/apis/cron`

Note: many write endpoints proxy to OpenClaw Gateway RPC (`cron.*`, `wake`).

### GET /health

Response `200`:

```json
{
	"ok": true,
	"service": "cron",
	"gateway": {
		"http": "http://127.0.0.1:18789",
		"ws": "ws://127.0.0.1:18789/ws"
	}
}
```

### GET /methods

Response `200`:

```json
{
	"methods": {
		"list": "cron.list",
		"status": "cron.status",
		"add": "cron.add",
		"update": "cron.update",
		"remove": "cron.remove",
		"run": "cron.run",
		"runs": "cron.runs",
		"wake": "wake"
	},
	"list": ["..."]
}
```

### GET /storage

Response `200`:

```json
{
	"storage": {
		"stateDir": "/root/.openclaw",
		"jobsFile": "/root/.openclaw/cron/jobs.json",
		"runsDir": "/root/.openclaw/cron/runs"
	},
	"exists": {
		"stateDir": true,
		"jobsFile": true,
		"runsDir": true
	}
}
```

### GET /jobs

Reads cron jobs directly from `jobs.json`.

Response `200`:

```json
{
	"exists": true,
	"file": "/root/.openclaw/cron/jobs.json",
	"version": 1,
	"total": 0,
	"jobs": []
}
```

If file is missing, `exists=false`, `jobs=[]`.

### GET /jobs/:jobId

Response `200`:

```json
{
	"ok": true,
	"job": {}
}
```

Response `404`: `{ "error": "Cron job '<id>' not found" }`

### PATCH|PUT /jobs/:jobId

Purpose: update one job by id. Body is merged as RPC params.

Body:

- Any object fields accepted by Gateway `cron.update`.
- `id` is forced from `:jobId` path.

Success response `200` (RPC wrapper):

```json
{
	"ok": true,
	"method": "cron.update",
	"response": {
		"type": "res",
		"id": "string",
		"ok": true,
		"payload": {}
	}
}
```

Gateway failure response `502`:

```json
{
	"ok": false,
	"method": "cron.update",
	"error": "string"
}
```

### DELETE /jobs/:jobId

Proxies `cron.remove` with body `{ "id": ":jobId" }`.

Response shapes same as above (`method = "cron.remove"`).

### POST /jobs/:jobId/run

Proxies `cron.run`.

Body:

- Any object fields accepted by Gateway `cron.run`.
- `id` is forced from `:jobId`.
- `mode` defaults to `force` unless provided as string.

Response wrapper method: `cron.run`.

### GET /runs

Reads run logs from `/root/.openclaw/cron/runs/*.jsonl`.

Query:

- `jobId` (optional string; when present, only `<jobId>.jsonl`)
- `limit` (optional int; default `200`, clamped `1..5000`)

Response `200`:

```json
{
	"exists": true,
	"dir": "/root/.openclaw/cron/runs",
	"totalFiles": 1,
	"runs": [
		{
			"ts": 0,
			"jobId": "string",
			"action": "string",
			"status": "string",
			"error": "string",
			"summary": "string",
			"sessionKey": "string"
		}
	]
}
```

### POST /jobs

Proxies `cron.add` with full body as params.

### PATCH|PUT /jobs

Proxies `cron.update` with full body as params.

### DELETE /jobs

Proxies `cron.remove` with full body as params.

### Aliases

- `POST /add` -> `cron.add`
- `POST|PATCH|PUT /update` and `/patch` -> `cron.update`
- `POST|DELETE /delete` and `/remove` -> `cron.remove`
- `POST /run-now` and `/run` -> `cron.run` (defaults `mode=force`)
- `POST /wake` -> `wake`

### POST /rpc

Generic cron RPC proxy.

Body:

```json
{
	"method": "cron.list|cron.status|cron.add|cron.update|cron.remove|cron.run|cron.runs|wake",
	"params": {}
}
```

Response:

- `200` wrapper if method supported and RPC call succeeds.
- `400` if unsupported method.
- `502` on gateway transport/invoke failure.

### Error envelope for uncaught cron/subagent handler errors

`500`:

```json
{
	"error": "string",
	"storage": {}
}
```

## 5) Subagent endpoints

Route roots (both supported):

- `/api/subagents`
- `/apis/subagents`

Note: these are helper/read endpoints plus write-through proxies to Gateway session/agent methods.

### GET /health

Response `200`:

```json
{
	"ok": true,
	"service": "subagents",
	"gateway": {
		"http": "http://127.0.0.1:18789",
		"ws": "ws://127.0.0.1:18789/ws"
	}
}
```

### GET /methods

Response `200`:

```json
{
	"methods": {
		"listSessions": "sessions.list",
		"previewSession": "sessions.preview",
		"chatHistory": "chat.history",
		"send": "sessions.send",
		"steer": "sessions.steer",
		"abort": "sessions.abort",
		"patch": "sessions.patch",
		"reset": "sessions.reset",
		"deleteSession": "sessions.delete",
		"runAgent": "agent",
		"runChat": "chat.send"
	},
	"tools": {
		"spawn": "sessions_spawn",
		"list": "subagents"
	},
	"list": ["..."]
}
```

### GET /storage

Response `200`:

```json
{
	"storage": {
		"stateDir": "/root/.openclaw",
		"subagentRunsFile": "/root/.openclaw/subagents/runs.json",
		"taskLedgerSqlite": "/root/.openclaw/tasks/runs.sqlite",
		"sessionsDir": "/root/.openclaw/agents"
	},
	"exists": {
		"stateDir": true,
		"runsFile": true,
		"taskLedgerSqlite": true,
		"sessionsDir": true
	}
}
```

### GET /runs

Reads `/root/.openclaw/subagents/runs.json`.

Response `200`:

```json
{
	"exists": true,
	"file": "/root/.openclaw/subagents/runs.json",
	"version": 1,
	"total": 0,
	"runs": [
		{ "runId": "string", "entry": {} }
	]
}
```

### GET /sessions

Scans `/root/.openclaw/agents/*/sessions/sessions.json` and returns entries whose `key` contains `:subagent:`.

Response `200`:

```json
{
	"exists": true,
	"baseDir": "/root/.openclaw/agents",
	"total": 0,
	"sessions": [
		{
			"key": "string",
			"sessionId": "string",
			"label": "string",
			"sessionFile": "string"
		}
	]
}
```

### Write-through proxy endpoints

All endpoints below use full JSON request body as RPC params. Success/failure wrappers are the same pattern as cron proxy responses.

- `POST /sessions/send` and `POST /send` -> `sessions.send`
- `POST /sessions/steer` and `POST /steer` -> `sessions.steer`
- `POST /sessions/abort` and `POST /abort` -> `sessions.abort`
- `POST|PATCH|PUT /sessions/patch` and `/patch` -> `sessions.patch`
- `POST /sessions/reset` and `POST /reset` -> `sessions.reset`
- `POST|DELETE /sessions/delete` and `/delete` -> `sessions.delete`
- `POST /agent` and `POST /run-agent` -> `agent`
- `POST /chat/send` and `POST /run-chat` -> `chat.send`

### POST /rpc

Generic subagent RPC proxy.

Body:

```json
{
	"method": "sessions.list|sessions.preview|chat.history|sessions.send|sessions.steer|sessions.abort|sessions.patch|sessions.reset|sessions.delete|agent|chat.send",
	"params": {}
}
```

Errors:

- `400` for unsupported method.
- `502` for gateway invoke/transport failure.

## 6) LLM calling notes

1. Prefer `/api/...` routes over `/apis/...` unless your caller explicitly uses `/apis`.
2. For write operations, treat request bodies as pass-through RPC params to OpenClaw Gateway.
3. Parse the proxy wrapper first:
	 - Top-level `ok` and `method`
	 - Nested `response.ok`, `response.payload`, and `response.error`
4. `GET /api/mission-control/logs` is read-only against SQLite and does not call gateway RPC.
5. For robust clients, handle `404`, `405`, `500`, and `502` explicitly.
