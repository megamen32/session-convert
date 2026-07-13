import { Conversation, ConversionResult, ContentPart } from "../types.js";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

/**
 * Write conversations into an OpenCode SQLite database.
 * Creates/opens <project>/.opencode/opencode.db and inserts sessions + messages.
 *
 * This is the unique capability — no other tool can write sessions INTO OpenCode.
 */
export class OpenCodeWriter {
  /**
   * Write a conversation into the OpenCode DB for a given project.
   */
  async write(conv: Conversation, projectPath?: string): Promise<ConversionResult> {
    const warnings: string[] = [];
    const projectDir = projectPath || conv.cwd;
    const dbDir = join(projectDir, ".opencode");
    const dbPath = join(dbDir, "opencode.db");

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

      // Create tables if they don't exist (basic schema)
      this.ensureSchema(db);

      const sessionId = conv.id || randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const createdAt = conv.createdAt ? Math.floor(new Date(conv.createdAt).getTime() / 1000) : now;
      const updatedAt = conv.updatedAt ? Math.floor(new Date(conv.updatedAt).getTime() / 1000) : now;

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
          ? Math.floor(new Date(msg.timestamp).getTime() / 1000)
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