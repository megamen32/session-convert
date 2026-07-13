import { Conversation, Message, ContentPart, SessionSummary } from "../types.js";
import { readFile, readdir, access, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Read Claude Code sessions from ~/.claude/projects/<hash>/sessions/<id>.jsonl
 */
export class ClaudeReader {
  private claudeDir: string;

  constructor(claudeDir?: string) {
    this.claudeDir = claudeDir || join(homedir(), ".claude");
  }

  async listSessions(cwdPrefix?: string): Promise<SessionSummary[]> {
    const projectsDir = join(this.claudeDir, "projects");
    const summaries: SessionSummary[] = [];

    try {
      const projectHashes = await readdir(projectsDir);
      for (const hash of projectHashes) {
        const sessionDir = join(projectsDir, hash, "sessions");
        try {
          const files = await readdir(sessionDir);
          for (const file of files) {
            if (!file.endsWith(".jsonl")) continue;
            const sessionId = file.replace(".jsonl", "");
            const filePath = join(sessionDir, file);

            try {
              const summary = await this.readSessionSummary(filePath, sessionId, hash);
              if (cwdPrefix) {
                const expanded = cwdPrefix.replace(/^~/, homedir());
                if (!summary.cwd.startsWith(expanded)) continue;
              }
              summaries.push(summary);
            } catch {
              // skip
            }
          }
        } catch {
          // no sessions dir
        }
      }
    } catch {
      // no projects dir
    }

    summaries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return summaries;
  }

  async readSession(sessionId: string): Promise<Conversation | null> {
    const projectsDir = join(this.claudeDir, "projects");
    try {
      const projectHashes = await readdir(projectsDir);
      for (const hash of projectHashes) {
        const filePath = join(projectsDir, hash, "sessions", `${sessionId}.jsonl`);
        try {
          await access(filePath);
          return await this.parseFile(filePath, sessionId, hash);
        } catch {
          continue;
        }
      }
    } catch { /* no projects dir */ }
    return null;
  }

  async readSessionByPath(filePath: string): Promise<Conversation> {
    const sessionId = filePath.replace(/\.jsonl$/, "").split("/").pop()!;
    const hash = filePath.split("/").slice(-3)[0]; // <hash>/sessions/<id>.jsonl
    return this.parseFile(filePath, sessionId, hash);
  }

  // ---- Internal ----

  private async readSessionSummary(
    filePath: string,
    sessionId: string,
    _hash: string
  ): Promise<SessionSummary> {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    let title = "Untitled";
    let firstTimestamp = "";
    let lastTimestamp = "";
    let model: string | undefined;
    let messageCount = 0;
    let cwd = "";

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const ts = entry.timestamp || "";
        if (!firstTimestamp && ts) firstTimestamp = ts;
        if (ts) lastTimestamp = ts;

        if (!cwd && entry.cwd) cwd = entry.cwd;

        if (entry.type === "user" && !title) {
          const text = this.extractText(entry.message?.content);
          if (text) title = text.slice(0, 120);
        }
        if (entry.type === "assistant") {
          messageCount++;
          if (entry.message?.model) model = entry.message.model;
        }
        if (entry.type === "user") messageCount++;
      } catch { /* skip */ }
    }

    if (!cwd) {
      try {
        const projFile = join(dirname(dirname(filePath)), "project.json");
        const proj = JSON.parse(await readFile(projFile, "utf-8"));
        if (proj.path) cwd = proj.path;
      } catch { /* fallback */ }
    }

    const fileStat = await stat(filePath);
    return {
      id: sessionId,
      harness: "claude",
      title,
      cwd,
      model,
      createdAt: firstTimestamp || fileStat.birthtime.toISOString(),
      updatedAt: lastTimestamp || fileStat.mtime.toISOString(),
      messageCount,
      sourcePath: filePath,
    };
  }

  private async parseFile(
    filePath: string,
    sessionId: string,
    _hash: string
  ): Promise<Conversation> {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const messages: Message[] = [];
    let title = "Untitled";
    let cwd = "";
    let gitBranch: string | undefined;
    let model: string | undefined;
    let firstTimestamp = "";
    let lastTimestamp = "";
    let totalInput = 0;
    let totalOutput = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const ts = entry.timestamp || "";
        if (!firstTimestamp && ts) firstTimestamp = ts;
        if (ts) lastTimestamp = ts;
        if (!cwd && entry.cwd) cwd = entry.cwd;
        if (!gitBranch && entry.gitBranch) gitBranch = entry.gitBranch;

        if (entry.type === "user") {
          const text = this.extractText(entry.message?.content);
          if (!title && text) title = text.slice(0, 120);

          const parts = this.convertUserContent(entry.message?.content);
          if (parts.length > 0) {
            messages.push({
              id: entry.uuid || randomUUID(),
              role: "user",
              parts,
              timestamp: ts,
            });
          }
        } else if (entry.type === "assistant") {
          if (entry.message?.model) model = entry.message.model;
          const parts = this.convertAssistantContent(entry.message?.content);
          const msg: Message = {
            id: entry.uuid || randomUUID(),
            role: "assistant",
            parts,
            model: entry.message?.model,
            timestamp: ts,
          };
          if (entry.message?.usage) {
            msg.usage = {
              inputTokens: entry.message.usage.input_tokens,
              outputTokens: entry.message.usage.output_tokens,
              cacheReadTokens: entry.message.usage.cache_read_input_tokens,
              cacheWriteTokens: entry.message.usage.cache_creation_input_tokens,
            };
            totalInput += msg.usage.inputTokens || 0;
            totalOutput += msg.usage.outputTokens || 0;
          }
          if (parts.length > 0) messages.push(msg);
        }
        // Skip system, compaction, and other event types
      } catch { /* skip bad lines */ }
    }

    if (!cwd) {
      try {
        const projFile = join(dirname(dirname(filePath)), "project.json");
        const proj = JSON.parse(await readFile(projFile, "utf-8"));
        if (proj.path) cwd = proj.path;
      } catch { /* fallback */ }
    }

    return {
      id: sessionId,
      sourceHarness: "claude",
      cwd,
      gitBranch,
      model,
      title,
      createdAt: firstTimestamp,
      updatedAt: lastTimestamp,
      messages,
      tokenUsage: {
        inputTokens: totalInput || undefined,
        outputTokens: totalOutput || undefined,
      },
      meta: { sourceFormat: "claude-jsonl", filePath },
    };
  }

  private extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) return block.text;
      }
    }
    return "";
  }

  private convertUserContent(content: unknown): ContentPart[] {
    if (!content) return [];
    const parts: ContentPart[] = [];

    if (typeof content === "string") {
      parts.push({ type: "text", text: content });
      return parts;
    }

    if (!Array.isArray(content)) return parts;

    for (const block of content) {
      if (block.type === "text" && block.text) {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "tool_result") {
        const resultText = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c: { text?: string }) => c.text || "").join("")
            : JSON.stringify(block.content);
        parts.push({
          type: "tool_result",
          toolCallId: block.tool_use_id || "",
          content: resultText.slice(0, 50_000), // cap result size
          isError: block.is_error,
        });
      }
    }

    return parts;
  }

  private convertAssistantContent(content: unknown): ContentPart[] {
    if (!content) return [];
    const parts: ContentPart[] = [];

    if (!Array.isArray(content)) return parts;

    for (const block of content) {
      if (block.type === "text" && block.text) {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "thinking" && block.thinking) {
        parts.push({ type: "thinking", text: block.thinking });
      } else if (block.type === "tool_use") {
        parts.push({
          type: "tool_call",
          id: block.id || "",
          name: block.name || "unknown",
          input: block.input || {},
          finished: true,
        });
      } else if (block.type === "image") {
        parts.push({ type: "image", url: block.source?.data || "", detail: "auto" });
      }
    }

    return parts;
  }
}