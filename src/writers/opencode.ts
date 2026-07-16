import { Conversation, ConversionResult, ContentPart } from "../types.js";
import { access, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

/**
 * Write conversations into an OpenCode SQLite database.
 * Creates/opens the current global OpenCode database, or an explicit
 * project-local .opencode/opencode.db when projectPath is provided.
 */
export class OpenCodeWriter {
  /**
   * Write a conversation into the OpenCode DB for a given project.
   */
  async write(conv: Conversation, projectPath?: string): Promise<ConversionResult> {
    const warnings: string[] = [];
    const projectDir = projectPath || conv.cwd;
    const dbPath = await this.resolveDatabasePath(projectPath, projectDir);
    const dbDir = dirname(dbPath);

    await mkdir(dbDir, { recursive: true });

    let db: Database.Database;
    try {
      db = new Database(dbPath);
    } catch (err) {
      return {
        success: false,
        error: `Cannot open/create OpenCode DB at ${dbPath}: ${(err as Error).message}`,
      };
    }

    try {
      // Enable WAL mode
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");

      if (this.hasTable(db, "session")) {
        const result = this.writeCurrentSchema(db, conv, projectDir, warnings);
        db.close();
        return result;
      }

      // Create tables if they don't exist (basic schema)
      this.ensureSchema(db);

      const sessionId = conv.id || randomUUID();
      const now = Date.now();
      const createdAt = conv.createdAt ? new Date(conv.createdAt).getTime() : now;
      const updatedAt = conv.updatedAt ? new Date(conv.updatedAt).getTime() : now;

      // Determine model from conversation
      const model = conv.model || this.detectModel(conv);

      // Calculate message count
      const messageCount = conv.messages.filter(m => m.role === "user" || m.role === "assistant").length;

      // Calculate costs (approximate)
      const cost = conv.costUsd || this.estimateCost(conv);

      // Insert session
      db.prepare(
        "INSERT OR REPLACE INTO sessions (id, title, message_count, prompt_tokens, completion_tokens, cost, updated_at, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        sessionId,
        conv.title.slice(0, 500),
        messageCount,
        conv.tokenUsage?.inputTokens || null,
        conv.tokenUsage?.outputTokens || null,
        cost,
        updatedAt,
        createdAt
      );

      // Insert messages
      let msgCount = 0;
      for (const msg of conv.messages) {
        const parts = this.toOpenCodeParts(msg.parts);
        if (parts.length === 0) continue;

        const msgId = msg.id || randomUUID();
        const msgTs = msg.timestamp
          ? new Date(msg.timestamp).getTime()
          : now;
        const msgModel = msg.model || model;

        db.prepare(
          "INSERT INTO messages (id, session_id, role, parts, model, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(msgId, sessionId, msg.role, JSON.stringify(parts), msgModel, msgTs, msgTs);

        // Add finish part for non-streaming compatibility
        db.prepare(
          "INSERT INTO messages (id, session_id, role, parts, model, created_at, updated_at) " +
          "VALUES (?, ?, 'tool', ?, ?, ?, ?)"
        ).run(
          randomUUID(), sessionId,
          JSON.stringify([{ type: "finish", data: { reason: "stop", time: Date.now() } }]),
          msgModel, msgTs, msgTs
        );

        msgCount++;
      }

      db.close();

      return {
        success: true,
        targetSessionId: sessionId,
        targetPath: dbPath,
        messageCount: msgCount,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (err) {
      db.close();
      return {
        success: false,
        error: `Failed to write to OpenCode DB: ${(err as Error).message}`,
      };
    }
  }

  private async resolveDatabasePath(projectPath: string | undefined, projectDir: string): Promise<string> {
    const projectDb = join(projectDir, ".opencode", "opencode.db");
    if (projectPath) return projectDb;

    const globalDb = process.env.OPENCODE_DB_PATH
      || join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "opencode.db");
    try {
      await access(globalDb);
      return globalDb;
    } catch {
      return projectDb;
    }
  }

  private writeCurrentSchema(
    db: Database.Database,
    conv: Conversation,
    projectDir: string,
    warnings: string[],
  ): ConversionResult {
    const project = db.prepare("SELECT id FROM project WHERE id = 'global' OR worktree = ? ORDER BY id = 'global' DESC LIMIT 1").get(projectDir) as { id: string } | undefined;
    if (!project) {
      return {
        success: false,
        error: `OpenCode current database has no project record for ${projectDir}`,
      };
    }

    const versionRow = db.prepare("SELECT version FROM session ORDER BY time_updated DESC LIMIT 1").get() as { version: string } | undefined;
    const version = versionRow?.version || "1.0.0";
    const modelId = conv.model || this.detectModel(conv);
    const providerID = modelId.includes("/") ? modelId.split("/", 1)[0] : "session-convert";
    const now = Date.now();
    const createdAt = conv.createdAt ? new Date(conv.createdAt).getTime() : now;
    const updatedAt = conv.updatedAt ? new Date(conv.updatedAt).getTime() : now;
    const sessionId = this.newOpenCodeId("ses");
    const title = conv.title.slice(0, 500);
    const slug = this.slugify(title) || sessionId.slice(4);

    const insertSession = db.prepare(
      "INSERT INTO session (id, project_id, slug, directory, title, version, cost, tokens_input, " +
      "tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, agent, model, time_created, time_updated) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const insertMessage = db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
    );
    const insertPart = db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
    );

    const write = db.transaction(() => {
      insertSession.run(
        sessionId,
        project.id,
        slug,
        projectDir,
        title,
        version,
        conv.costUsd || 0,
        conv.tokenUsage?.inputTokens || 0,
        conv.tokenUsage?.outputTokens || 0,
        conv.tokenUsage?.reasoningTokens || 0,
        conv.tokenUsage?.cacheReadTokens || 0,
        conv.tokenUsage?.cacheWriteTokens || 0,
        "coder",
        JSON.stringify({ id: modelId, providerID, variant: "default" }),
        createdAt,
        updatedAt,
      );

      let parentId: string | null = null;
      for (const msg of conv.messages) {
        const messageId = this.newOpenCodeId("msg");
        const timestamp = msg.timestamp ? new Date(msg.timestamp).getTime() : now;
        const messageModel = msg.model || modelId;
        const messageData = {
          ...(parentId ? { parentID: parentId } : {}),
          role: msg.role === "assistant" ? "assistant" : "user",
          mode: "coder",
          agent: "coder",
          variant: "default",
          path: { cwd: projectDir, root: "/" },
          cost: 0,
          tokens: {
            input: msg.usage?.inputTokens || 0,
            output: msg.usage?.outputTokens || 0,
            reasoning: msg.usage?.reasoningTokens || 0,
            cache: {
              read: msg.usage?.cacheReadTokens || 0,
              write: msg.usage?.cacheWriteTokens || 0,
            },
          },
          modelID: messageModel,
          providerID,
          time: { created: timestamp },
        };
        insertMessage.run(messageId, sessionId, timestamp, timestamp, JSON.stringify(messageData));

        for (const part of this.toCurrentOpenCodeParts(msg.parts, timestamp, warnings)) {
          const partId = this.newOpenCodeId("prt");
          insertPart.run(partId, messageId, sessionId, timestamp, timestamp, JSON.stringify(part));
        }
        parentId = messageId;
      }
    });

    write();
    return {
      success: true,
      targetSessionId: sessionId,
      targetPath: db.name,
      messageCount: conv.messages.length,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  private toCurrentOpenCodeParts(parts: ContentPart[], timestamp: number, warnings: string[]): unknown[] {
    const result: unknown[] = [];
    for (const part of parts) {
      if (part.type === "text") {
        result.push({ type: "text", text: part.text, time: { start: timestamp, end: timestamp } });
      } else if (part.type === "thinking") {
        result.push({ type: "reasoning", text: part.text, time: { start: timestamp, end: timestamp } });
      } else if (part.type === "tool_call") {
        result.push({
          type: "tool",
          tool: part.name,
          callID: part.id,
          state: {
            status: part.finished === false ? "pending" : "completed",
            input: part.input,
            output: "",
          },
        });
      } else if (part.type === "tool_result") {
        result.push({
          type: "tool",
          tool: part.name || "unknown",
          callID: part.toolCallId,
          state: {
            status: part.isError ? "error" : "completed",
            input: {},
            output: part.content,
          },
        });
      } else if (part.type === "image") {
        warnings.push("Image parts are not written to the current OpenCode schema");
      }
    }
    return result;
  }

  private hasTable(db: Database.Database, tableName: string): boolean {
    const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
    return row !== undefined;
  }

  private newOpenCodeId(prefix: string): string {
    return `${prefix}_${randomUUID().replaceAll("-", "")}`;
  }

  private slugify(title: string): string {
    return title.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80);
  }

  private ensureSchema(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT,
        title TEXT,
        message_count INTEGER DEFAULT 0,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        cost REAL DEFAULT 0,
        updated_at INTEGER,
        created_at INTEGER,
        summary_message_id TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        parts TEXT NOT NULL DEFAULT '[]',
        model TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        finished_at INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    `);
  }

  private toOpenCodeParts(parts: ContentPart[]): unknown[] {
    const result: unknown[] = [];

    for (const p of parts) {
      if (p.type === "text") {
        result.push({ type: "text", data: { text: p.text } });
      } else if (p.type === "thinking") {
        result.push({ type: "reasoning", data: { thinking: p.text } });
      } else if (p.type === "tool_call") {
        result.push({
          type: "tool_call",
          data: {
            id: p.id,
            name: p.name,
            input: JSON.stringify(p.input),
            type: "function",
            finished: p.finished !== false,
          },
        });
      } else if (p.type === "tool_result") {
        result.push({
          type: "tool_result",
          data: {
            tool_call_id: p.toolCallId,
            name: p.name,
            content: p.content,
            metadata: "",
            is_error: p.isError || false,
          },
        });
      } else if (p.type === "image") {
        result.push({ type: "image_url", data: { url: p.url, detail: p.detail || "auto" } });
      }
    }

    return result;
  }

  private detectModel(conv: Conversation): string {
    // Check first assistant message
    for (const msg of conv.messages) {
      if (msg.role === "assistant" && msg.model) return msg.model;
    }
    // Infer from source
    if (conv.sourceHarness === "claude") return "anthropic/claude-sonnet-4-20250514";
    if (conv.sourceHarness === "codex") return "openai/o4-mini";
    return "openai/gpt-4o";
  }

  private estimateCost(conv: Conversation): number {
    // Very rough estimate
    const inputTokens = conv.tokenUsage?.inputTokens || conv.messages.length * 500;
    const outputTokens = conv.tokenUsage?.outputTokens || conv.messages.length * 200;

    if (conv.sourceHarness === "claude") {
      return (inputTokens * 3 / 1_000_000) + (outputTokens * 15 / 1_000_000);
    }
    return (inputTokens * 2.5 / 1_000_000) + (outputTokens * 10 / 1_000_000);
  }
}
