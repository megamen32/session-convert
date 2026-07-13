import { Conversation, Message, ContentPart, SessionSummary } from "../types.js";
import { readFile, readdir, access, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
  // Flattened fields (some rollouts put payload fields at top level)
  [key: string]: unknown;
}

/**
 * Read Codex CLI sessions from ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */
export class CodexReader {
  private codexDir: string;

  constructor(codexDir?: string) {
    this.codexDir = codexDir || join(homedir(), ".codex");
  }

  async listSessions(cwdPrefix?: string): Promise<SessionSummary[]> {
    const sessionsDir = join(this.codexDir, "sessions");
    const summaries: SessionSummary[] = [];

    try {
      await this.walkSessionsDir(sessionsDir, summaries, cwdPrefix);
    } catch {
      // no sessions dir
    }

    summaries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return summaries;
  }

  async readSession(sessionId: string): Promise<Conversation | null> {
    const sessionsDir = join(this.codexDir, "sessions");
    const filePath = await this.findSessionFile(sessionsDir, sessionId);
    if (!filePath) return null;
    return this.parseFile(filePath);
  }

  async readSessionByPath(filePath: string): Promise<Conversation> {
    return this.parseFile(filePath);
  }

  // ---- Internal ----

  private async walkSessionsDir(
    dir: string,
    summaries: SessionSummary[],
    cwdPrefix?: string
  ): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walkSessionsDir(fullPath, summaries, cwdPrefix);
      } else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        try {
          const summary = await this.readSessionSummary(fullPath);
          if (cwdPrefix) {
            const expanded = cwdPrefix.replace(/^~/, homedir());
            if (!summary.cwd.startsWith(expanded)) continue;
          }
          summaries.push(summary);
        } catch { /* skip */ }
      }
    }
  }

  private async findSessionFile(sessionsDir: string, sessionId: string): Promise<string | null> {
    // Also check session_index.jsonl
    const indexPath = join(this.codexDir, "session_index.jsonl");
    try {
      const indexContent = await readFile(indexPath, "utf-8");
      for (const line of indexContent.split("\n").filter(Boolean)) {
        try {
          const entry = JSON.parse(line);
          if (entry.session_id === sessionId || entry.id === sessionId) {
            if (typeof entry.path === "string") {
              const fullPath = join(this.codexDir, entry.path);
              try { await access(fullPath); return fullPath; } catch { /* continue */ }
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* no index */ }

    // Brute-force scan
    const found: string[] = [];
    await this.findMatchingFiles(sessionsDir, sessionId, found);
    return found[0] || null;
  }

  private async findMatchingFiles(dir: string, sessionId: string, results: string[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.findMatchingFiles(fullPath, sessionId, results);
      } else if (entry.name.includes(sessionId) && entry.name.endsWith(".jsonl")) {
        results.push(fullPath);
      }
    }
  }

  private async readSessionSummary(filePath: string): Promise<SessionSummary> {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    let sessionId = basename(filePath, ".jsonl").replace(/^rollout-[^-]+-/, "");
    let title = "Untitled";
    let cwd = "";
    let model: string | undefined;
    let firstTimestamp = "";
    let lastTimestamp = "";
    let messageCount = 0;

    for (const line of lines) {
      try {
        const entry: RolloutLine = JSON.parse(line);
        const ts = entry.timestamp || "";
        if (!firstTimestamp && ts) firstTimestamp = ts;
        if (ts) lastTimestamp = ts;

        // session_meta is typically the first line
        if (entry.type === "session_meta" && entry.payload) {
          const p = entry.payload;
          if (p.session_id) sessionId = p.session_id as string;
          if (p.id) sessionId = p.id as string;
          if (p.cwd) cwd = p.cwd as string;
        }

        // Extract from flattened format too
        if (entry.payload?.cwd) cwd = entry.payload.cwd as string;
        if ((entry as Record<string, unknown>).cwd) cwd = (entry as Record<string, unknown>).cwd as string;

        if (entry.payload?.model_provider) {
          // Codex stores provider, not full model name in meta
        }

        // response_item with type "message"
        if (entry.type === "response_item" || entry.payload?.type === "message") {
          const item = entry.payload || entry;
          const role = item.role as string | undefined;
          if (role === "user" || role === "assistant") {
            messageCount++;
            if (role === "user" && !title && Array.isArray(item.content)) {
              for (const c of item.content) {
                if ((c.type === "input_text" || c.type === "output_text") && c.text) {
                  title = (c.text as string).slice(0, 120);
                  break;
                }
              }
            }
          }
        }
      } catch { /* skip */ }
    }

    const fileStat = await stat(filePath);
    return {
      id: sessionId,
      harness: "codex",
      title,
      cwd,
      model,
      createdAt: firstTimestamp || fileStat.birthtime.toISOString(),
      updatedAt: lastTimestamp || fileStat.mtime.toISOString(),
      messageCount,
      sourcePath: filePath,
    };
  }

  private async parseFile(filePath: string): Promise<Conversation> {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const messages: Message[] = [];
    let title = "Untitled";
    let cwd = "";
    let gitBranch: string | undefined;
    let model: string | undefined;
    let sessionId = basename(filePath, ".jsonl").replace(/^rollout-[^-]+-/, "");
    let firstTimestamp = "";
    let lastTimestamp = "";

    // Track pending function calls to match with outputs
    const pendingCalls = new Map<string, { name: string; timestamp: string }>();

    for (const line of lines) {
      try {
        const entry: RolloutLine = JSON.parse(line);
        const ts = entry.timestamp || "";
        if (!firstTimestamp && ts) firstTimestamp = ts;
        if (ts) lastTimestamp = ts;

        const p = entry.payload || {};
        const itemType = (p.type || entry.type) as string;

        // session_meta
        if (itemType === "session_meta") {
          if (p.session_id) sessionId = p.session_id as string;
          if (p.cwd) cwd = p.cwd as string;
          if ((p.git as Record<string, unknown>)?.branch) {
            gitBranch = (p.git as Record<string, unknown>).branch as string;
          }
          continue;
        }

        // Also check for flattened session_meta fields
        if (!cwd && (entry as Record<string, unknown>).cwd) {
          cwd = (entry as Record<string, unknown>).cwd as string;
        }

        // message items
        if (itemType === "message") {
          const role = (p.role || entry.role) as string;
          if (role !== "user" && role !== "assistant") continue;

          const parts: ContentPart[] = [];
          const contentArr = (p.content || entry.content) as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(contentArr)) {
            for (const c of contentArr) {
              if ((c.type === "input_text" || c.type === "output_text") && c.text) {
                parts.push({ type: "text", text: c.text as string });
                if (role === "user" && !title) {
                  title = (c.text as string).slice(0, 120);
                }
              } else if (c.type === "input_image" && c.image_url) {
                parts.push({ type: "image", url: c.image_url as string, detail: (c.detail as "auto" | "low" | "high") || "auto" });
              }
            }
          }

          if (parts.length > 0) {
            messages.push({
              id: (p.id as string) || randomUUID(),
              role: role as "user" | "assistant",
              parts,
              timestamp: ts,
            });
          }
        }

        // function_call
        if (itemType === "function_call") {
          const callId = (p.call_id || entry.call_id) as string;
          const name = (p.name || entry.name) as string;
          const argsStr = (p.arguments || entry.arguments) as string;
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(argsStr); } catch { input = { raw: argsStr }; }

          pendingCalls.set(callId, { name, timestamp: ts });

          // Add to the last assistant message, or create a standalone one
          const lastMsg = messages[messages.length - 1];
          if (lastMsg?.role === "assistant") {
            lastMsg.parts.push({ type: "tool_call", id: callId, name, input, finished: true });
          } else {
            messages.push({
              id: randomUUID(),
              role: "assistant",
              parts: [{ type: "tool_call", id: callId, name, input, finished: true }],
              timestamp: ts,
            });
          }
        }

        // function_call_output
        if (itemType === "function_call_output") {
          const callId = (p.call_id || entry.call_id) as string;
          const callInfo = pendingCalls.get(callId);
          const name = callInfo?.name || (p.name as string);
          const output = typeof p.output === "string" ? p.output : JSON.stringify(p.output);

          // Create a user message with the tool result
          messages.push({
            id: randomUUID(),
            role: "user",
            parts: [{
              type: "tool_result",
              toolCallId: callId,
              name,
              content: (output as string).slice(0, 50_000),
            }],
            timestamp: ts,
          });
          pendingCalls.delete(callId);
        }

        // custom_tool_call (MCP tools)
        if (itemType === "custom_tool_call") {
          const callId = (p.call_id || entry.call_id) as string;
          const name = (p.name || entry.name) as string;
          let input: Record<string, unknown> = {};
          try { input = typeof p.input === "string" ? JSON.parse(p.input) : (p.input as Record<string, unknown>) || {}; } catch { /* keep empty */ }

          const lastMsg = messages[messages.length - 1];
          if (lastMsg?.role === "assistant") {
            lastMsg.parts.push({ type: "tool_call", id: callId, name, input, finished: true });
          } else {
            messages.push({
              id: randomUUID(),
              role: "assistant",
              parts: [{ type: "tool_call", id: callId, name, input, finished: true }],
              timestamp: ts,
            });
          }
        }

        // custom_tool_call_output
        if (itemType === "custom_tool_call_output") {
          const callId = (p.call_id || entry.call_id) as string;
          const name = p.name as string;
          const output = typeof p.output === "string" ? p.output : JSON.stringify(p.output);
          messages.push({
            id: randomUUID(),
            role: "user",
            parts: [{ type: "tool_result", toolCallId: callId, name, content: (output as string).slice(0, 50_000) }],
            timestamp: ts,
          });
        }

        // reasoning
        if (itemType === "reasoning") {
          const summaryArr = p.summary as Array<{ text?: string }> | undefined;
          const text = summaryArr?.map(s => s.text || "").join("\n") || "";
          if (text) {
            const lastMsg = messages[messages.length - 1];
            if (lastMsg?.role === "assistant") {
              lastMsg.parts.push({ type: "thinking", text });
            } else {
              messages.push({
                id: randomUUID(),
                role: "assistant",
                parts: [{ type: "thinking", text }],
                timestamp: ts,
              });
            }
          }
        }
      } catch { /* skip bad lines */ }
    }

    return {
      id: sessionId,
      sourceHarness: "codex",
      cwd,
      gitBranch,
      model,
      title,
      createdAt: firstTimestamp,
      updatedAt: lastTimestamp,
      messages,
      meta: { sourceFormat: "codex-rollout-jsonl", filePath },
    };
  }
}