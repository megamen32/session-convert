import { Conversation, ConversionResult, ContentPart } from "../types.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Write conversations as Claude Code JSONL sessions.
 * Creates files in ~/.claude/projects/<encoded-cwd>/sessions/<uuid>.jsonl
 */
export class ClaudeWriter {
  private claudeDir: string;

  constructor(claudeDir?: string) {
    this.claudeDir = claudeDir || join(homedir(), ".claude");
  }

  async write(conv: Conversation): Promise<ConversionResult> {
    const warnings: string[] = [];
    const sessionId = conv.id || randomUUID();
    const encodedCwd = conv.cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-|-$/g, "");
    const sessionDir = join(this.claudeDir, "projects", encodedCwd, "sessions");

    await mkdir(sessionDir, { recursive: true });
    const filePath = join(sessionDir, `${sessionId}.jsonl`);

    const lines: string[] = [];
    let msgIndex = 0;

    for (const msg of conv.messages) {
      if (msg.role === "user") {
        const content = this.toUserContent(msg.parts);
        if (content.length === 0) continue;

        lines.push(JSON.stringify({
          type: "user",
          uuid: msg.id || randomUUID(),
          parentUuid: msgIndex > 0 ? String(msgIndex - 1) : null,
          timestamp: msg.timestamp || new Date().toISOString(),
          sessionId,
          cwd: conv.cwd,
          message: { role: "user", content },
        }));
        msgIndex++;
      } else if (msg.role === "assistant") {
        const content = this.toAssistantContent(msg.parts);
        if (content.length === 0) continue;

        const msgObj: Record<string, unknown> = {
          role: "assistant",
          content,
          model: msg.model || conv.model || "claude-sonnet-4-20250514",
        };

        if (msg.usage) {
          (msgObj as Record<string, unknown>).usage = {
            input_tokens: msg.usage.inputTokens || 0,
            output_tokens: msg.usage.outputTokens || 0,
            cache_read_input_tokens: msg.usage.cacheReadTokens || 0,
            cache_creation_input_tokens: msg.usage.cacheWriteTokens || 0,
          };
        }

        lines.push(JSON.stringify({
          type: "assistant",
          uuid: msg.id || randomUUID(),
          parentUuid: String(msgIndex - 1),
          timestamp: msg.timestamp || new Date().toISOString(),
          sessionId,
          cwd: conv.cwd,
          message: msgObj,
        }));
        msgIndex++;
      }
      if (msg.role === "system") {
        warnings.push("System messages are not natively supported in Claude JSONL");
      }
    }

    await writeFile(filePath, lines.join("\n") + "\n", "utf-8");

    // Write project.json
    const projectFile = join(dirname(sessionDir), "project.json");
    try {
      await writeFile(projectFile, JSON.stringify({ path: conv.cwd }, null, 2));
    } catch { /* may already exist */ }

    return {
      success: true,
      targetSessionId: sessionId,
      targetPath: filePath,
      messageCount: lines.length,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  private toUserContent(parts: ContentPart[]): unknown[] {
    const content: unknown[] = [];
    for (const part of parts) {
      if (part.type === "text") {
        content.push({ type: "text", text: part.text });
      } else if (part.type === "tool_result") {
        content.push({
          type: "tool_result",
          tool_use_id: part.toolCallId,
          content: part.content,
          is_error: part.isError || false,
        });
      }
    }
    return content;
  }

  private toAssistantContent(parts: ContentPart[]): unknown[] {
    const content: unknown[] = [];
    for (const part of parts) {
      if (part.type === "text") {
        content.push({ type: "text", text: part.text });
      } else if (part.type === "thinking") {
        content.push({ type: "thinking", thinking: part.text });
      } else if (part.type === "tool_call") {
        content.push({
          type: "tool_use",
          id: part.id,
          name: part.name,
          input: part.input,
        });
      } else if (part.type === "image") {
        content.push({ type: "image", source: { type: "base64", data: part.url, media_type: "image/png" } });
      }
    }
    return content;
  }
}