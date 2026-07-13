import { Conversation, ConversionResult, ContentPart } from "../types.js";
import { writeFile, mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Write conversations as Codex CLI rollout JSONL sessions.
 * Creates files in ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
 * Also appends to session_index.jsonl for discoverability.
 */
export class CodexWriter {
  private codexDir: string;

  constructor(codexDir?: string) {
    this.codexDir = codexDir || join(homedir(), ".codex");
  }

  async write(conv: Conversation): Promise<ConversionResult> {
    const warnings: string[] = [];
    const sessionId = conv.id || randomUUID();
    const now = new Date();
    const dateDir = join(
      this.codexDir, "sessions",
      now.getFullYear().toString(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0")
    );

    await mkdir(dateDir, { recursive: true });
    const ts = now.toISOString().replace(/[:.]/g, "-");
    const filePath = join(dateDir, `rollout-${ts}-${sessionId}.jsonl`);

    const lines: string[] = [];
    let ordinal = 0;

    // session_meta (first line)
    lines.push(JSON.stringify({
      timestamp: conv.createdAt || now.toISOString(),
      ordinal: ordinal++,
      type: "session_meta",
      payload: {
        session_id: sessionId,
        id: sessionId,
        forked_from_id: null,
        parent_thread_id: null,
        timestamp: conv.createdAt || now.toISOString(),
        cwd: conv.cwd,
        originator: "session-convert",
        cli_version: "1.0.0",
        source: "cli",
        model_provider: this.inferProvider(conv.model),
        git: conv.gitBranch ? { branch: conv.gitBranch } : undefined,
      },
    }));

    // Messages
    for (const msg of conv.messages) {
      if (msg.role === "user") {
        const content = this.toCodexUserContent(msg.parts);
        if (content.length === 0) continue;

        lines.push(JSON.stringify({
          timestamp: msg.timestamp || now.toISOString(),
          ordinal: ordinal++,
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content,
          },
        }));
      } else if (msg.role === "assistant") {
        // Text parts as message
        const textParts = msg.parts.filter(p => p.type === "text" || p.type === "thinking");
        if (textParts.length > 0) {
          const content = textParts.map(p => {
            if (p.type === "thinking") {
              return { type: "reasoning", text: p.text };
            }
            return { type: "output_text", text: p.text };
          });

          lines.push(JSON.stringify({
            timestamp: msg.timestamp || now.toISOString(),
            ordinal: ordinal++,
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content,
            },
          }));
        }

        // Tool calls as separate function_call items
        for (const part of msg.parts) {
          if (part.type === "tool_call") {
            lines.push(JSON.stringify({
              timestamp: msg.timestamp || now.toISOString(),
              ordinal: ordinal++,
              type: "response_item",
              payload: {
                type: "function_call",
                call_id: part.id || randomUUID(),
                name: part.name,
                arguments: JSON.stringify(part.input),
              },
            }));
          }
        }
      }

      if (msg.role === "system") {
        warnings.push("System messages are written as user messages in Codex format");
        lines.push(JSON.stringify({
          timestamp: msg.timestamp || now.toISOString(),
          ordinal: ordinal++,
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: msg.parts.map(p => "text" in p ? p.text : "").join("\n") }],
          },
        }));
      }
    }

    await writeFile(filePath, lines.join("\n") + "\n", "utf-8");

    // Append to session index
    await this.appendToIndex(sessionId, conv, filePath);

    return {
      success: true,
      targetSessionId: sessionId,
      targetPath: filePath,
      messageCount: lines.length,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  private async appendToIndex(sessionId: string, conv: Conversation, filePath: string): Promise<void> {
    const indexPath = join(this.codexDir, "session_index.jsonl");
    const relativePath = filePath.replace(this.codexDir + "/", "");

    const indexEntry = {
      session_id: sessionId,
      path: relativePath,
      cwd: conv.cwd,
      title: conv.title,
      created_at: new Date().toISOString(),
      source: "session-convert",
    };

    try {
      await appendFile(indexPath, JSON.stringify(indexEntry) + "\n", "utf-8");
    } catch (err) {
      console.error(`[session-convert] Could not write to Codex session index: ${(err as Error).message}`);
    }
  }

  private inferProvider(model?: string): string {
    if (!model) return "openai";
    if (model.includes("claude") || model.includes("anthropic")) return "anthropic";
    if (model.includes("gemini") || model.includes("google")) return "google";
    if (model.includes("deepseek")) return "deepseek";
    if (model.includes("ollama") || model.includes("llama") || model.includes("qwen")) return "ollama";
    return "openai";
  }

  private toCodexUserContent(parts: ContentPart[]): unknown[] {
    const content: unknown[] = [];
    for (const part of parts) {
      if (part.type === "text") {
        content.push({ type: "input_text", text: part.text });
      } else if (part.type === "tool_result") {
        // In Codex, tool results come as function_call_output items, not in user messages
        // But we can include a reference
        content.push({ type: "input_text", text: `[Tool result for ${part.name || part.toolCallId}]: ${part.content}` });
      } else if (part.type === "image") {
        content.push({ type: "input_image", image_url: part.url, detail: part.detail || "auto" });
      }
    }
    return content;
  }
}