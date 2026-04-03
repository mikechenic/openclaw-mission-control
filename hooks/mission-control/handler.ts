/**
 * Mission Control Hook
 *
 * Syncs agent lifecycle events to a local SQLite database.
 * Captures user prompts and agent responses.
 */

import path from "node:path";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import Database from "better-sqlite3";

type HookEvent = {
  type: string;
  action: string;
  sessionKey: string;
  context: Record<string, unknown>;
  timestamp: Date;
  messages: string[];
};

type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

type OpenClawConfig = {
  hooks?: {
    internal?: {
      entries?: Record<string, { enabled?: boolean; env?: Record<string, string> }>;
    };
  };
};

let listenerRegistered = false;
let db: InstanceType<typeof Database> | null = null;
let missionControlDbPath: string | undefined;

// Track session info by sessionKey
const sessionInfo = new Map<string, { agentId: string; sessionId: string }>();

// Track the last real (non-system) runId per sessionKey so follow-up runs can link back
const lastRealRunId = new Map<string, string>();

// Track pending write tool calls by toolCallId
const pendingWrites = new Map<string, { filePath: string; content: string; sessionKey: string }>();

// Track tool call metadata so result events can include original arguments.
const pendingToolCalls = new Map<string, { toolName: string; args: Record<string, unknown> | undefined }>();

// Fallback run tracking when agent-events stream is unavailable
const commandRunIdBySession = new Map<string, string>();

function resolveDbPath(cfg?: OpenClawConfig): string | undefined {
  const hookConfig = cfg?.hooks?.internal?.entries?.["mission-control"];
  return hookConfig?.env?.MISSION_CONTROL_DB_PATH || hookConfig?.env?.SQLITE_DB_PATH || process.env.MISSION_CONTROL_DB_PATH || process.env.SQLITE_DB_PATH;
}

// Backward-compatible alias: keep original function name/signature.
// It now resolves a SQLite database path instead of an HTTP endpoint URL.
export function resolveUrl(cfg?: OpenClawConfig): string | undefined {
  return resolveDbPath(cfg);
}

function initializeDatabase(): InstanceType<typeof Database> {
  if (db) return db;

  const defaultDbPath = "/root/.openclaw/mission-control/events.db";
  const configuredDbPath = missionControlDbPath?.trim();
  const dbPath = configuredDbPath ? path.resolve(configuredDbPath) : defaultDbPath;
  const dbDir = path.dirname(dbPath);

  // Ensure directory exists
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);

  // Enable foreign keys
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Create tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId TEXT NOT NULL,
      sessionKey TEXT NOT NULL,
      agentId TEXT,
      status TEXT NOT NULL CHECK (status IN ('start', 'end', 'error')),
      title TEXT,
      description TEXT,
      prompt TEXT,
      response TEXT,
      error TEXT,
      source TEXT,
      timestamp DATETIME NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId TEXT NOT NULL,
      sessionKey TEXT NOT NULL,
      eventType TEXT NOT NULL,
      action TEXT NOT NULL,
      title TEXT,
      description TEXT,
      message TEXT,
      data JSON,
      timestamp DATETIME NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId TEXT NOT NULL,
      sessionKey TEXT NOT NULL,
      agentId TEXT,
      title TEXT NOT NULL,
      description TEXT,
      content TEXT,
      type TEXT NOT NULL,
      path TEXT,
      eventType TEXT,
      timestamp DATETIME NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_sessionKey ON tasks(sessionKey);
    CREATE INDEX IF NOT EXISTS idx_tasks_runId ON tasks(runId);
    CREATE INDEX IF NOT EXISTS idx_events_runId ON events(runId);
    CREATE INDEX IF NOT EXISTS idx_documents_runId ON documents(runId);
  `);

  // Repair old schemas that used invalid foreign keys on runId.
  // In SQLite, a foreign key target must be PRIMARY KEY or UNIQUE, which tasks.runId is not.
  const repairTableIfNeeded = (tableName: "events" | "documents", createSql: string, copySql: string) => {
    const fkList = db!.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{ table?: string; from?: string; to?: string }>;
    const hasInvalidLegacyFk = fkList.some(fk => fk.table === "tasks" && fk.from === "runId" && fk.to === "runId");
    if (!hasInvalidLegacyFk) return;

    db!.exec(`
      ALTER TABLE ${tableName} RENAME TO ${tableName}_old;
      ${createSql}
      ${copySql}
      DROP TABLE ${tableName}_old;
    `);
  };

  repairTableIfNeeded(
    "events",
    `CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId TEXT NOT NULL,
      sessionKey TEXT NOT NULL,
      eventType TEXT NOT NULL,
      action TEXT NOT NULL,
      title TEXT,
      description TEXT,
      message TEXT,
      data JSON,
      timestamp DATETIME NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );`,
    `INSERT INTO events (id, runId, sessionKey, eventType, action, message, data, timestamp, createdAt)
     SELECT id, runId, sessionKey, eventType, action, message, data, timestamp, createdAt FROM events_old;`
  );

  repairTableIfNeeded(
    "documents",
    `CREATE TABLE documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId TEXT NOT NULL,
      sessionKey TEXT NOT NULL,
      agentId TEXT,
      title TEXT NOT NULL,
      description TEXT,
      content TEXT,
      type TEXT NOT NULL,
      path TEXT,
      eventType TEXT,
      timestamp DATETIME NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );`,
    `INSERT INTO documents (id, runId, sessionKey, agentId, title, content, type, path, eventType, timestamp, createdAt)
     SELECT id, runId, sessionKey, agentId, title, content, type, path, eventType, timestamp, createdAt FROM documents_old;`
  );

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_runId ON events(runId);
    CREATE INDEX IF NOT EXISTS idx_documents_runId ON documents(runId);
  `);

  console.log("[mission-control] SQLite database initialized at:", dbPath);
  return db;
}

async function saveToDatabase(payload: Record<string, unknown>) {
  try {
    const database = initializeDatabase();
    const {
      runId,
      action,
      sessionKey,
      timestamp,
      title,
      description,
      prompt,
      response,
      error,
      source,
      message,
      eventType,
      data,
      agentId,
      document,
    } = payload as {
      runId?: string;
      action?: string;
      sessionKey?: string;
      timestamp?: string;
      title?: string | null;
      description?: string | null;
      prompt?: string | null;
      response?: string | null;
      error?: string | null;
      source?: string | null;
      message?: string | null;
      eventType?: string | null;
      data?: unknown;
      agentId?: string | null;
      document?: {
        title: string;
        description?: string;
        content: string;
        type: string;
        path?: string;
      } | null;
    };

    // Track task lifecycle
    if (action === "start" || action === "end" || action === "error") {
      const stmt = database.prepare(`
        INSERT INTO tasks (runId, sessionKey, agentId, status, title, description, prompt, response, error, source, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        runId,
        sessionKey,
        agentId || null,
        action,
        title || null,
        description || null,
        prompt || null,
        response || null,
        error || null,
        source || null,
        timestamp
      );

      console.log(`[mission-control] Task ${action} saved to DB for runId: ${runId}`);
    }

    // Track general events (progress, tool usage, etc.)
    if (eventType && action === "progress") {
      const stmt = database.prepare(`
        INSERT INTO events (runId, sessionKey, eventType, action, title, description, message, data, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(runId, sessionKey, eventType, action, title || null, description || null, message || null, data ? JSON.stringify(data) : null, timestamp);

      console.log(`[mission-control] Event saved: ${eventType}`);
    }

    // Track documents
    if (action === "document" && document) {
      const stmt = database.prepare(`
        INSERT INTO documents (runId, sessionKey, agentId, title, description, content, type, path, eventType, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        runId,
        sessionKey,
        agentId || null,
        document.title,
        document.description || null,
        document.content,
        document.type,
        document.path || null,
        eventType || null,
        timestamp
      );

      console.log(`[mission-control] Document saved: ${document.title}`);
    }
  } catch (err) {
    console.error("[mission-control] Failed to save to database:", err instanceof Error ? err.message : err);
  }
}

// Backward-compatible alias: keep original function name/signature.
// It now stores the payload in SQLite instead of POSTing to a remote API.
export async function postToMissionControl(payload: Record<string, unknown>) {
  await saveToDatabase(payload);
}

/**
 * Extract the last user message from a session file (JSONL format)
 */
async function getLastUserMessage(sessionFilePath: string, retries: number = 10): Promise<string | null> {
  try {
    const content = await fsp.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === "message" && entry.message?.role === "user") {
          const msg = entry.message;
          if (msg.content) {
            if (Array.isArray(msg.content)) {
              const textParts = msg.content
                .filter((p: { type?: string }) => p.type === "text")
                .map((p: { text?: string }) => p.text || "")
                .join("\n");
              if (textParts) return textParts;
            } else if (typeof msg.content === "string") {
              return msg.content;
            }
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }
  } catch (err) {
    if (retries > 0 && (err instanceof Error && err.message.includes("ENOENT"))) {
      // File doesn't exist yet, retry with exponential backoff
      const delayMs = Math.pow(2, 10 - retries) * 100; // ..., 1600ms, 800ms, 400ms, 200ms, 100ms
      console.log(`[mission-control] Session file not ready, retrying in ${delayMs}ms (${retries} retries left)`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return getLastUserMessage(sessionFilePath, retries - 1);
    }
    console.error("[mission-control] Failed to read session file:", err);
  }
  return null;
}

/**
 * Extract the last assistant message from a session file
 */
async function getLastAssistantMessage(sessionFilePath: string): Promise<string | null> {
  try {
    const content = await fsp.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === "message" && entry.message?.role === "assistant") {
          const msg = entry.message;
          if (msg.content) {
            if (Array.isArray(msg.content)) {
              const textParts = msg.content
                .filter((p: { type?: string }) => p.type === "text")
                .map((p: { text?: string }) => p.text || "")
                .join("\n");
              if (textParts) return textParts;
            } else if (typeof msg.content === "string") {
              return msg.content;
            }
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }
  } catch (err) {
    console.error("[mission-control] Failed to read session file:", err);
  }
  return null;
}

function getSessionFilePath(agentId: string, sessionId: string): string {
  const home = os.homedir();
  return path.join(home, ".openclaw", "agents", agentId, "sessions", `${sessionId}.jsonl`);
}

/**
 * Extract the clean user message and source from metadata-wrapped prompts.
 * Handles formats like:
 * "System: [timestamp] Node: ... [Telegram User ...] actual message [message_id: 123]"
 */
function extractCleanPrompt(rawPrompt: string): { prompt: string; source: string | null } {
  // Webchat metadata format:
  // "System: [timestamp] Node: hostname (IP) · app VERSION · mode MODE\n\nactual user message"
  const webchatMatch = rawPrompt.match(/^System:\s*\[\d{4}-[^\]]+\]\s*Node:\s*[^\n]+\n\n(.+)/s);
  if (webchatMatch && webchatMatch[1]) {
    return { prompt: webchatMatch[1].trim(), source: "webchat" };
  }

  // If it doesn't look like it has metadata, return as-is
  if (!rawPrompt.includes("System:") && !rawPrompt.includes("[message_id:")) {
    return { prompt: rawPrompt.trim(), source: null };
  }

  // Try to extract the source and actual message
  // Pattern: [Channel User (info) timestamp] actual message [message_id: xxx]
  const channels = ["Telegram", "Discord", "Slack", "WhatsApp", "SMS", "Email"];
  let source: string | null = null;

  for (const channel of channels) {
    if (rawPrompt.includes(`[${channel}`)) {
      source = channel;
      break;
    }
  }

  const channelMatch = rawPrompt.match(/\[(?:Telegram|Discord|Slack|WhatsApp|SMS|Email)[^\]]+\]\s*(.+?)(?:\s*\[message_id:|$)/s);
  if (channelMatch && channelMatch[1]) {
    return { prompt: channelMatch[1].trim(), source };
  }

  // Fallback: try to get content after the last ] before [message_id
  const messageIdIndex = rawPrompt.indexOf("[message_id:");
  if (messageIdIndex > 0) {
    const beforeMessageId = rawPrompt.slice(0, messageIdIndex);
    const lastBracket = beforeMessageId.lastIndexOf("]");
    if (lastBracket > 0) {
      return { prompt: beforeMessageId.slice(lastBracket + 1).trim(), source };
    }
  }

  // Last fallback: return trimmed original
  return { prompt: rawPrompt.trim(), source };
}

function formatPromptWithSource(prompt: string, source: string | null): string {
  if (source) {
    return `${source}: ${prompt}`;
  }
  return prompt;
}

async function findAgentEventsModule(): Promise<{
  onAgentEvent: (listener: (evt: AgentEventPayload) => void) => () => void;
} | null> {
  const g = globalThis as Record<string, unknown>;
  if (g.__openclawAgentEvents && typeof (g.__openclawAgentEvents as Record<string, unknown>).onAgentEvent === "function") {
    return g.__openclawAgentEvents as { onAgentEvent: (listener: (evt: AgentEventPayload) => void) => () => void };
  }

  const searchPaths = [
    "/usr/local/lib/node_modules/openclaw/dist/infra/agent-events.js",
    "/opt/homebrew/lib/node_modules/openclaw/dist/infra/agent-events.js",
    "/opt/openclaw/moltbot/dist/infra/agent-events.js",
  ];

  const mainPath = process.argv[1];
  if (mainPath) {
    const mainDir = path.dirname(mainPath);
    searchPaths.unshift(path.join(mainDir, "infra", "agent-events.js"));
    searchPaths.unshift(path.join(mainDir, "..", "dist", "infra", "agent-events.js"));
  }

  const home = os.homedir();
  if (home) {
    searchPaths.push(path.join(home, ".npm-global", "lib", "node_modules", "openclaw", "dist", "infra", "agent-events.js"));
  }

  // Common local-project layouts when running from a workspace checkout
  const cwd = process.cwd();
  if (cwd) {
    searchPaths.push(path.join(cwd, "dist", "infra", "agent-events.js"));
    searchPaths.push(path.join(cwd, "..", "dist", "infra", "agent-events.js"));
  }

  for (const searchPath of searchPaths) {
    try {
      if (fs.existsSync(searchPath)) {
        console.log("[mission-control] Loading agent-events module from:", searchPath);
        const module = await import(`file://${searchPath}`);
        if (typeof module.onAgentEvent === "function") return module;
      }
    } catch {
      // Continue
    }
  }

  return null;
}

const handler = async (event: HookEvent) => {
  console.log(`[mission-control] Event: ${event.type}:${event.action} session=${event.sessionKey}`);
  
  if (!missionControlDbPath) {
    const cfg = event.context.cfg as OpenClawConfig | undefined;
    missionControlDbPath = resolveUrl(cfg);
  }

  // Handle agent bootstrap - store session info for later
  if (event.type === "agent" && event.action === "bootstrap") {
    const agentId = event.context.agentId as string | undefined;
    const sessionId = event.context.sessionId as string | undefined;

    if (agentId && sessionId) {
      console.log("[mission-control] Storing session info:", agentId, sessionId);
      sessionInfo.set(event.sessionKey, { agentId, sessionId });
    }
    return;
  }

  // Fallback logging path when lifecycle stream listener is unavailable.
  // This guarantees at least one DB record per user command.
  if (event.type === "command" && event.action === "new") {
    const runId = `hook-${event.sessionKey}-${Date.now()}`;
    commandRunIdBySession.set(event.sessionKey, runId);
    lastRealRunId.set(event.sessionKey, runId);

    const prompt = event.messages.length > 0 ? event.messages.join("\n") : null;

    void postToMissionControl({
      runId,
      action: "start",
      sessionKey: event.sessionKey,
      timestamp: event.timestamp.toISOString(),
      prompt,
      source: "hook:command:new",
      eventType: "hook:command:new",
    });

    return;
  }

  // Register listener on gateway startup
  if (event.type === "gateway" && event.action === "startup") {
    if (listenerRegistered) return;

    try {
      initializeDatabase();
    } catch (err) {
      console.error("[mission-control] Failed to initialize database:", err);
      return;
    }

    try {
      const agentEvents = await findAgentEventsModule();
      if (!agentEvents) {
        console.error("[mission-control] Could not find agent-events module; using command:new fallback logging only");
        listenerRegistered = true;
        return;
      }

      agentEvents.onAgentEvent(async (evt: AgentEventPayload) => {
        const sessionKey = evt.sessionKey;
        if (!sessionKey) return;

        // Lifecycle events
        if (evt.stream === "lifecycle") {
          const phase = evt.data?.phase as string | undefined;
          if (!phase) return;

          // Skip heartbeat runs — they shouldn't create tasks
          const messageChannel = evt.data?.messageChannel as string | undefined;
          if (messageChannel === "heartbeat") {
            console.log("[mission-control] Skipping heartbeat lifecycle event");
            return;
          }

          const info = sessionInfo.get(sessionKey);

          if (phase === "start") {
            let prompt: string | null = null;
            let source: string | null = null;
            let rawPrompt: string | null = null;

            if (info) {
              const sessionFile = getSessionFilePath(info.agentId, info.sessionId);
              console.log("[mission-control] Attempting to read session file:", sessionFile);
              rawPrompt = await getLastUserMessage(sessionFile);
              if (rawPrompt) {
                const extracted = extractCleanPrompt(rawPrompt);
                prompt = extracted.prompt;
                source = extracted.source;
                console.log("[mission-control] Raw prompt:", rawPrompt.slice(0, 100));
                console.log("[mission-control] Clean prompt:", prompt.slice(0, 100));
                console.log("[mission-control] Source:", source);
              } else {
                console.log("[mission-control] WARNING: No user message found in session file or file doesn't exist");
              }
            } else {
              console.log("[mission-control] WARNING: No session info found for sessionKey:", sessionKey, "- skipping prompt extraction");
            }

            // Determine if this is a real user run or a system follow-up
            // Check both: messageChannel from event data (if available) and
            // source detected by extractCleanPrompt (webchat metadata, Telegram brackets, etc.)
            const userChannels = ["telegram", "webchat", "whatsapp", "discord", "slack", "signal", "sms", "imessage", "nostr"];
            const isUserChannel = (messageChannel && userChannels.includes(messageChannel)) || source !== null;

            if (!isUserChannel && rawPrompt && (rawPrompt.startsWith("System:") || rawPrompt.startsWith("Read HEARTBEAT"))) {
              // System follow-up runs (exec notifications) — don't create new tasks,
              // but track them so tool events link to the original task
              console.log("[mission-control] System follow-up run, linking to previous runId:", lastRealRunId.get(sessionKey));
              return;
            }

            // Override source with messageChannel if available and no source detected
            if (messageChannel && !source) {
              source = messageChannel;
            }

            // Track this as the last real runId for this session
            lastRealRunId.set(sessionKey, evt.runId);
            console.log("[mission-control] Tracked real runId:", evt.runId, "for session:", sessionKey);

            void postToMissionControl({
              runId: evt.runId,
              action: "start",
              sessionKey,
              timestamp: new Date(evt.ts).toISOString(),
              prompt,
              source,
              eventType: "lifecycle:start",
            });
          } else if (phase === "end") {
            // Capture the assistant's response before cleanup
            let response: string | null = null;
            if (info) {
              const sessionFile = getSessionFilePath(info.agentId, info.sessionId);
              response = await getLastAssistantMessage(sessionFile);
              if (response) {
                // Truncate long responses
                const maxLen = 1000;
                if (response.length > maxLen) {
                  response = response.slice(0, maxLen) + "...";
                }
                console.log("[mission-control] Captured response:", response.slice(0, 100));
              }
            }

            const endRunId = lastRealRunId.get(sessionKey) || evt.runId;
            sessionInfo.delete(sessionKey);
            void postToMissionControl({
              runId: endRunId,
              action: "end",
              sessionKey,
              timestamp: new Date(evt.ts).toISOString(),
              response,
              eventType: "lifecycle:end",
            });
          } else if (phase === "error") {
            const errorRunId = lastRealRunId.get(sessionKey) || evt.runId;
            sessionInfo.delete(sessionKey);
            void postToMissionControl({
              runId: errorRunId,
              action: "error",
              sessionKey,
              timestamp: new Date(evt.ts).toISOString(),
              error: evt.data?.error as string | undefined,
              eventType: "lifecycle:error",
            });
          }
          return;
        }

        // Tool usage - progress updates and document capture
        if (evt.stream === "tool") {
          const toolName = evt.data?.name as string | undefined;
          const phase = evt.data?.phase as string | undefined;
          const toolCallId = evt.data?.toolCallId as string | undefined;
          const args = evt.data?.args as Record<string, unknown> | undefined;

          // Use the last real runId if this is a follow-up/system run
          const effectiveRunId = lastRealRunId.get(sessionKey) || evt.runId;

          if (toolName && phase === "start") {
            if (toolCallId) {
              pendingToolCalls.set(toolCallId, { toolName, args });
            }

            void postToMissionControl({
              runId: effectiveRunId,
              action: "progress",
              sessionKey,
              timestamp: new Date(evt.ts).toISOString(),
              message: `🔧 Using tool: ${toolName}`,
              eventType: "tool:start",
              data: {
                toolName,
                args: args || null,
                phase,
                toolCallId: toolCallId || null,
              },
            });

            // Track write tool calls for document capture
            if (toolName === "write" && toolCallId) {
              const args = evt.data?.args as Record<string, unknown> | undefined;
              const filePath = (args?.file_path ?? args?.path) as string | undefined;
              const content = args?.content as string | undefined;

              if (filePath && content) {
                pendingWrites.set(toolCallId, { filePath, content, sessionKey });
                console.log(`[mission-control] Tracking write: ${toolCallId} -> ${filePath}`);
              }
            }
          }

          if (toolName && phase === "result") {
            const tracked = toolCallId ? pendingToolCalls.get(toolCallId) : null;
            const isError = evt.data?.isError as boolean | undefined;
            const result = evt.data?.result ?? evt.data?.output ?? null;

            void postToMissionControl({
              runId: effectiveRunId,
              action: "progress",
              sessionKey,
              timestamp: new Date(evt.ts).toISOString(),
              message: `${isError ? "❌" : "✅"} Tool result: ${toolName}`,
              eventType: "tool:result",
              data: {
                toolName,
                args: tracked?.args || null,
                result,
                isError: Boolean(isError),
                phase,
                toolCallId: toolCallId || null,
              },
            });

            if (toolCallId) {
              pendingToolCalls.delete(toolCallId);
            }
          }

          // Capture document creation when write tool completes successfully
          if (toolName === "write" && phase === "result" && toolCallId) {
            const isError = evt.data?.isError as boolean | undefined;
            const pending = pendingWrites.get(toolCallId);

            if (pending && !isError) {
              const { filePath, content } = pending;
              const fileName = path.basename(filePath);
              const ext = path.extname(filePath).toLowerCase();

              // Determine document type from extension
              let docType = "text";
              if ([".md", ".markdown"].includes(ext)) docType = "markdown";
              else if ([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".css", ".html", ".json", ".yaml", ".yml", ".toml", ".sh", ".bash"].includes(ext)) docType = "code";
              else if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"].includes(ext)) docType = "image";
              else if ([".txt", ".log"].includes(ext)) docType = "note";

              const info = sessionInfo.get(pending.sessionKey);

              void postToMissionControl({
                runId: effectiveRunId,
                action: "document",
                sessionKey: pending.sessionKey,
                timestamp: new Date(evt.ts).toISOString(),
                agentId: info?.agentId,
                document: {
                  title: fileName,
                  content: content.length > 50000 ? content.slice(0, 50000) + "\n\n[Content truncated...]" : content,
                  type: docType,
                  path: filePath,
                },
                eventType: "tool:write",
              });

              console.log(`[mission-control] Document captured: ${fileName} (${docType})`);
            }

            pendingWrites.delete(toolCallId);
          }

          // Capture files from exec/process tool results (e.g., images from nano banana)
          // exec returns "Command still running", the actual output comes via the process tool
          if ((toolName === "exec" || toolName === "process") && phase === "result") {
            // Extract text from the result (can be string or content array)
            const rawResult = evt.data?.result as string | { content?: Array<{ type?: string; text?: string }> } | undefined;
            let text = "";
            if (typeof rawResult === "string") {
              text = rawResult;
            } else if (rawResult && Array.isArray(rawResult.content)) {
              text = rawResult.content
                .filter((c: { type?: string }) => c.type === "text")
                .map((c: { text?: string }) => c.text || "")
                .join("\n");
            }
            const output = evt.data?.output as string | undefined;
            if (!text && output) text = output;

            if (text) {
              // Look for file paths with media extensions in the output
              const fileMatch = text.match(/(\/\S+\.(?:png|jpg|jpeg|gif|webp|svg|mp4|mp3|wav|pdf))/i);

              if (fileMatch && fileMatch[1]) {
                const filePath = fileMatch[1];
                const fileName = path.basename(filePath);
                const ext = path.extname(filePath).toLowerCase();

                let docType = "text";
                if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"].includes(ext)) docType = "image";
                else if ([".mp4", ".mp3", ".wav"].includes(ext)) docType = "media";
                else if ([".pdf"].includes(ext)) docType = "document";

                const info = sessionInfo.get(sessionKey);

                void postToMissionControl({
                  runId: effectiveRunId,
                  action: "document",
                  sessionKey,
                  timestamp: new Date(evt.ts).toISOString(),
                  agentId: info?.agentId,
                  document: {
                    title: fileName,
                    content: filePath,
                    type: docType,
                    path: filePath,
                  },
                  eventType: "exec:file",
                });

                console.log(`[mission-control] Exec file captured: ${fileName} (${docType})`);
              } else {
                console.log(`[mission-control] Exec result (no file found): ${text.slice(0, 150)}`);
              }
            }
          }
        }

        // Assistant message chunks - track significant updates
        if (evt.stream === "assistant") {
          const content = evt.data?.content as string | undefined;
          const chunkType = evt.data?.type as string | undefined;

          // Only send on significant events, not every token
          if (chunkType === "thinking_start") {
            void postToMissionControl({
              runId: evt.runId,
              action: "progress",
              sessionKey,
              timestamp: new Date(evt.ts).toISOString(),
              message: "💭 Thinking...",
              eventType: "assistant:thinking",
            });
          }
        }

        // Log unhandled streams for diagnostics
        if (!["lifecycle", "tool", "exec", "assistant"].includes(evt.stream)) {
          console.log(`[mission-control] Unhandled stream: ${evt.stream}`, JSON.stringify(evt.data).slice(0, 200));
        }
      });

      listenerRegistered = true;
      console.log("[mission-control] Registered event listener");
      if (missionControlDbPath) {
        console.log("[mission-control] Using configured SQLite database path:", missionControlDbPath);
      } else {
        console.log("[mission-control] Using default SQLite database path");
      }
    } catch (err) {
      console.error("[mission-control] Failed:", err instanceof Error ? err.message : err);
    }
  }
};

export default handler;
