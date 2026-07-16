import { Conversation, Message, ContentPart, SessionSummary } from "../types.js";
import { readdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

/**
 * Read OpenCode sessions from current global and legacy project-local SQLite databases.
 */
export class OpenCodeReader {
  private dataHome: string;

  constructor(dataHome?: string) {
    this.dataHome = dataHome || process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  }

  /**
   * Find all OpenCode databases.
   * Includes the current global database and scans known project directories
   * for legacy .opencode/opencode.db files.
   */
  async findDatabases(searchPaths?: string[]): Promise<string[]> {
    const dbs: string[] = [];
    const globalDb = join(this.dataHome, "opencode", "opencode.db");

    try {
      await access(globalDb);
      dbs.push(globalDb);
    } catch {
      // OpenCode may only have project-local databases.
    }

    const paths = searchPaths || [homedir()];

    for (const searchPath of paths) {
      await this.scanForDbs(searchPath, dbs, 0, 3);
    }

    return [...new Set(dbs)];
  }

  /**
   * List sessions from a specific database file.
   */
  async listSessionsFromDb(dbPath: string, cwdPrefix?: string): Promise<SessionSummary[]> {
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      if (this.hasTable(db, "session")) {
        return this.queryCurrentSessions(db, dbPath, cwdPrefix);
      }
      const sessions = await this.querySessions(db, dbPath, cwdPrefix);
      return sessions;
    } catch (err) {
      throw new Error(`Failed to read OpenCode DB ${dbPath}: ${(err as Error).message}`);
    } finally {
      db?.close();
    }
  }

  /**
   * List sessions from all found databases.
   */
  async listSessions(cwdPrefix?: string, searchPaths?: string[]): Promise<SessionSummary[]> {
    const dbs = await this.findDatabases(searchPaths);
    const allSessions: SessionSummary[] = [];

    for (const dbPath of dbs) {
      try {
        const sessions = await this.listSessionsFromDb(dbPath, cwdPrefix);
        allSessions.push(...sessions);
      } catch { /* skip inaccessible DBs */ }
    }

    allSessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return allSessions;
  }

  /**
   * Read a full conversation from a specific database.
   */
  async readSessionFromDb(dbPath: string, sessionId: string): Promise<Conversation | null> {
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      return this.readConversation(db, sessionId, dbPath);
    } catch (err) {
      throw new Error(`Failed to read session from ${dbPath}: ${(err as Error).message}`);
    } finally {
      db?.close();
    }
  }

  /**
   * Search all databases for a session by ID.
   */
  async readSession(sessionId: string, searchPaths?: string[]): Promise<Conversation | null> {
    const dbs = await this.findDatabases(searchPaths);
    for (const dbPath of dbs) {
      try {
        const conv = await this.readSessionFromDb(dbPath, sessionId);
        if (conv) return conv;
      } catch { /* continue */ }
    }
    return null;
  }

  // ---- Internal ----

  private async scanForDbs(dir: string, results: string[], depth: number, maxDepth: number): Promise<void> {
    if (depth > maxDepth) return;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".opencode") continue;
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;

        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === ".opencode") {
            // Check for opencode.db inside
            const dbFile = join(fullPath, "opencode.db");
            try {
              await access(dbFile);
              results.push(dbFile);
            } catch { /* no db here */ }
          } else {
            await this.scanForDbs(fullPath, results, depth + 1, maxDepth);
          }
        }
      }
    } catch { /* permission denied etc. */ }
  }

  private async querySessions(db: Database.Database, dbPath: string, cwdPrefix?: string): Promise<SessionSummary[]> {
    const sessions: SessionSummary[] = [];

    try {
      // Try with workspaces join first, fall back to sessions-only
      let rows: Array<Record<string, unknown>>;
      try {
        rows = db.prepare(
          "SELECT s.id, s.title, s.parent_session_id, s.message_count, s.cost, " +
          "s.updated_at, s.created_at, w.path as cwd " +
          "FROM sessions s LEFT JOIN workspaces w ON 1=1 " +
          "ORDER BY s.updated_at DESC LIMIT 200"
        ).all() as Array<Record<string, unknown>>;
      } catch {
        rows = db.prepare(
          "SELECT id, title, parent_session_id, message_count, cost, " +
          "updated_at, created_at FROM sessions " +
          "ORDER BY updated_at DESC LIMIT 200"
        ).all() as Array<Record<string, unknown>>;
      }

      for (const row of rows) {
        const cwd = (row.cwd as string) || dirname(dirname(dbPath));
        if (cwdPrefix) {
          const expanded = cwdPrefix.replace(/^~/, homedir());
          if (!cwd.startsWith(expanded)) continue;
        }

        const updatedAt = toIsoTimestamp(row.updated_at) || new Date().toISOString();
        const createdAt = toIsoTimestamp(row.created_at) || updatedAt;

        sessions.push({
          id: row.id as string,
          harness: "opencode",
          title: (row.title as string) || "Untitled",
          cwd,
          createdAt,
          updatedAt,
          messageCount: (row.message_count as number) || 0,
          costUsd: row.cost as number | undefined,
          sourcePath: dbPath,
        });
      }
    } catch (err) {
      // Table might not exist or schema mismatch
      console.error(`[session-convert] OpenCode DB query error: ${(err as Error).message}`);
    }

    return sessions;
  }

  private queryCurrentSessions(db: Database.Database, dbPath: string, cwdPrefix?: string): SessionSummary[] {
    const sessions: SessionSummary[] = [];
    const rows = db.prepare(
      "SELECT id, title, directory, model, time_created, time_updated " +
      "FROM session ORDER BY time_updated DESC LIMIT 200"
    ).all() as Array<Record<string, unknown>>;

    for (const row of rows) {
      const cwd = (row.directory as string) || dirname(dirname(dbPath));
      if (cwdPrefix) {
        const expanded = cwdPrefix.replace(/^~/, homedir());
        if (!cwd.startsWith(expanded)) continue;
      }

      const updatedAt = toIsoTimestamp(row.time_updated) || new Date().toISOString();
      const createdAt = toIsoTimestamp(row.time_created) || updatedAt;
      sessions.push({
        id: row.id as string,
        harness: "opencode",
        title: (row.title as string) || "Untitled",
        cwd,
        model: parseModelId(row.model),
        createdAt,
        updatedAt,
        messageCount: this.countCurrentMessages(db, row.id as string),
        sourcePath: dbPath,
      });
    }

    return sessions;
  }

  private countCurrentMessages(db: Database.Database, sessionId: string): number {
    const row = db.prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?").get(sessionId) as { count: number };
    return row.count;
  }

  private readConversation(db: Database.Database, sessionId: string, dbPath: string): Conversation | null {
    if (this.hasTable(db, "session")) {
      return this.readCurrentConversation(db, sessionId, dbPath);
    }

    try {
      const sessionRow = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as Record<string, unknown> | undefined;
      if (!sessionRow) return null;

      const cwd = (sessionRow as Record<string, unknown>).path as string
        || dirname(dirname(dbPath));

      const msgRows = db.prepare(
        "SELECT id, session_id, role, parts, model, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC"
      ).all(sessionId) as Array<Record<string, unknown>>;

      const messages: Message[] = [];
      let model: string | undefined;
      let title = (sessionRow.title as string) || "Untitled";

      // If no title, use first user message
      if (title === "Untitled" || !title) {
        for (const row of msgRows) {
          if (row.role === "user") {
            const parts = this.parseParts(row.parts as string);
            const text = parts.find(p => p.type === "text");
            if (text && "text" in text) {
              title = text.text.slice(0, 120);
              break;
            }
          }
        }
      }

      for (const row of msgRows) {
        if (row.model) model = row.model as string;
        const parts = this.parseParts(row.parts as string);
        const ts = toIsoTimestamp(row.created_at);

        messages.push({
          id: row.id as string,
          role: row.role as "user" | "assistant" | "system" | "tool",
          parts,
          model: row.model as string | undefined,
          timestamp: ts,
        });
      }

      const updatedAt = toIsoTimestamp(sessionRow.updated_at) || new Date().toISOString();
      const createdAt = toIsoTimestamp(sessionRow.created_at) || updatedAt;

      return {
        id: sessionId,
        sourceHarness: "opencode",
        cwd,
        model,
        title,
        createdAt,
        updatedAt,
        messages,
        costUsd: sessionRow.cost as number | undefined,
        tokenUsage: {
          inputTokens: (sessionRow.prompt_tokens as number) || undefined,
          outputTokens: (sessionRow.completion_tokens as number) || undefined,
        },
        meta: { sourceFormat: "opencode-sqlite", dbPath },
      };
    } catch (err) {
      console.error(`[session-convert] Error reading conversation: ${(err as Error).message}`);
      return null;
    }
  }

  private readCurrentConversation(db: Database.Database, sessionId: string, dbPath: string): Conversation | null {
    try {
      const sessionRow = db.prepare("SELECT * FROM session WHERE id = ?").get(sessionId) as Record<string, unknown> | undefined;
      if (!sessionRow) return null;

      const rows = db.prepare(
        "SELECT m.id AS message_id, m.data AS message_data, m.time_created AS message_created, " +
        "p.id AS part_id, p.data AS part_data, p.time_created AS part_created " +
        "FROM message m LEFT JOIN part p ON p.message_id = m.id " +
        "WHERE m.session_id = ? ORDER BY m.time_created ASC, p.time_created ASC"
      ).all(sessionId) as Array<Record<string, unknown>>;

      const messageMap = new Map<string, Message>();
      for (const row of rows) {
        const messageId = row.message_id as string;
        let message = messageMap.get(messageId);
        if (!message) {
          const data = parseJsonObject(row.message_data);
          const role = data.role === "assistant" ? "assistant" : "user";
          message = {
            id: messageId,
            role,
            parts: [],
            model: typeof data.modelID === "string" ? data.modelID : undefined,
            timestamp: toIsoTimestamp(row.message_created),
          };
          messageMap.set(messageId, message);
        }

        if (row.part_data) {
          message.parts.push(...parseCurrentParts(row.part_data as string));
        }
      }

      const messages = [...messageMap.values()];
      const createdAt = toIsoTimestamp(sessionRow.time_created) || new Date().toISOString();
      const updatedAt = toIsoTimestamp(sessionRow.time_updated) || createdAt;

      return {
        id: sessionId,
        sourceHarness: "opencode",
        cwd: (sessionRow.directory as string) || dirname(dirname(dbPath)),
        model: parseModelId(sessionRow.model),
        title: (sessionRow.title as string) || "Untitled",
        createdAt,
        updatedAt,
        messages,
        costUsd: typeof sessionRow.cost === "number" ? sessionRow.cost : undefined,
        tokenUsage: {
          inputTokens: (sessionRow.tokens_input as number) || undefined,
          outputTokens: (sessionRow.tokens_output as number) || undefined,
          reasoningTokens: (sessionRow.tokens_reasoning as number) || undefined,
          cacheReadTokens: (sessionRow.tokens_cache_read as number) || undefined,
          cacheWriteTokens: (sessionRow.tokens_cache_write as number) || undefined,
        },
        meta: { sourceFormat: "opencode-sqlite-current", dbPath },
      };
    } catch (err) {
      console.error(`[session-convert] Error reading current OpenCode conversation: ${(err as Error).message}`);
      return null;
    }
  }

  private hasTable(db: Database.Database, tableName: string): boolean {
    const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
    return row !== undefined;
  }

  /**
   * Parse OpenCode's double-wrapped parts format:
   * [{ "type": "text", "data": { "text": "..." } }, ...]
   */
  private parseParts(partsJson: string): ContentPart[] {
    if (!partsJson) return [];
    const parts: ContentPart[] = [];

    try {
      const parsed = JSON.parse(partsJson) as Array<Record<string, unknown>>;
      for (const p of parsed) {
        const type = p.type as string;
        const data = p.data as Record<string, unknown> | undefined;

        if (type === "text" && data?.text) {
          parts.push({ type: "text", text: data.text as string });
        } else if (type === "reasoning" && data?.thinking) {
          parts.push({ type: "thinking", text: data.thinking as string });
        } else if (type === "tool_call" && data) {
          let input: Record<string, unknown> = {};
          try {
            input = typeof data.input === "string" ? JSON.parse(data.input) : (data.input as Record<string, unknown>) || {};
          } catch { /* keep empty */ }

          parts.push({
            type: "tool_call",
            id: (data.id as string) || randomUUID(),
            name: (data.name as string) || "unknown",
            input,
            finished: data.finished as boolean | undefined,
          });
        } else if (type === "tool_result" && data) {
          parts.push({
            type: "tool_result",
            toolCallId: (data.tool_call_id as string) || "",
            name: data.name as string,
            content: (data.content as string || "").slice(0, 50_000),
            isError: data.is_error as boolean | undefined,
          });
        } else if (type === "image_url" && data) {
          parts.push({
            type: "image",
            url: (data.url as string) || "",
            detail: (data.detail as "auto" | "low" | "high") || "auto",
          });
        }
        // Skip "finish" and "binary" parts
      }
    } catch {
      // malformed parts JSON
    }

    return parts;
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseModelId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const parsed = parseJsonObject(value);
    if (typeof parsed.id === "string") {
      return parsed.providerID && typeof parsed.providerID === "string"
        ? `${parsed.providerID}/${parsed.id}`
        : parsed.id;
    }
    return value;
  }
  if (!value || typeof value !== "object") return undefined;
  const model = value as Record<string, unknown>;
  if (typeof model.id !== "string") return undefined;
  return model.providerID && typeof model.providerID === "string"
    ? `${model.providerID}/${model.id}`
    : model.id;
}

function parseCurrentParts(partsJson: string): ContentPart[] {
  const data = parseJsonObject(partsJson);
  switch (data.type) {
    case "text":
      return typeof data.text === "string" ? [{ type: "text", text: data.text }] : [];
    case "reasoning":
      return typeof data.text === "string" ? [{ type: "thinking", text: data.text }] : [];
    case "tool": {
      const state = data.state && typeof data.state === "object"
        ? data.state as Record<string, unknown>
        : {};
      const input = state.input && typeof state.input === "object"
        ? state.input as Record<string, unknown>
        : {};
      const callId = typeof data.callID === "string" ? data.callID : randomUUID();
      const toolName = typeof data.tool === "string" ? data.tool : "unknown";
      const status = state.status;
      const call: ContentPart = {
        type: "tool_call",
        id: callId,
        name: toolName,
        input,
        finished: status === "completed" || status === "error",
      };
      if (typeof state.output === "string") {
        return [call, {
          type: "tool_result",
          toolCallId: callId,
          name: toolName,
          content: state.output.slice(0, 50_000),
          isError: status === "error",
        }];
      }
      return [call];
    }
    default:
      return [];
  }
}

/**
 * Convert OpenCode epoch timestamps to ISO strings.
 *
 * OpenCode currently stores milliseconds, while older local databases used
 * seconds. Detecting the unit keeps old exports readable without writing new
 * data in the legacy format.
 */
function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const milliseconds = value < 100_000_000_000 ? value * 1000 : value;
  return new Date(milliseconds).toISOString();
}
