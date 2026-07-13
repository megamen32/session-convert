import { Conversation, Message, ContentPart, SessionSummary } from "../types.js";
import { readdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

/**
 * Read OpenCode sessions from SQLite databases.
 * OpenCode stores sessions in <project>/.opencode/opencode.db
 * We scan for these databases across the filesystem.
 */
export class OpenCodeReader {
  private dataHome: string;

  constructor(dataHome?: string) {
    this.dataHome = dataHome || process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  }

  /**
   * Find all OpenCode databases.
   * Scans known project directories for .opencode/opencode.db files.
   */
  async findDatabases(searchPaths?: string[]): Promise<string[]> {
    const dbs: string[] = [];
    const paths = searchPaths || [homedir()];

    for (const searchPath of paths) {
      await this.scanForDbs(searchPath, dbs, 0, 3);
    }

    return dbs;
  }

  /**
   * List sessions from a specific database file.
   */
  async listSessionsFromDb(dbPath: string, cwdPrefix?: string): Promise<SessionSummary[]> {
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
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

        const updatedAt = row.updated_at
          ? new Date((row.updated_at as number) * 1000).toISOString()
          : new Date().toISOString();
        const createdAt = row.created_at
          ? new Date((row.created_at as number) * 1000).toISOString()
          : updatedAt;

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

  private readConversation(db: Database.Database, sessionId: string, dbPath: string): Conversation | null {
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
        const ts = row.created_at
          ? new Date((row.created_at as number) * 1000).toISOString()
          : undefined;

        messages.push({
          id: row.id as string,
          role: row.role as "user" | "assistant" | "system" | "tool",
          parts,
          model: row.model as string | undefined,
          timestamp: ts,
        });
      }

      const updatedAt = sessionRow.updated_at
        ? new Date((sessionRow.updated_at as number) * 1000).toISOString()
        : new Date().toISOString();
      const createdAt = sessionRow.created_at
        ? new Date((sessionRow.created_at as number) * 1000).toISOString()
        : updatedAt;

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