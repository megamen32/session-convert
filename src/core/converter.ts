import { Conversation, ConversionResult, HarnessType, SessionSummary } from "../types.js";
import { ClaudeReader } from "../readers/claude.js";
import { CodexReader } from "../readers/codex.js";
import { OpenCodeReader } from "../readers/opencode.js";
import { ClaudeWriter } from "../writers/claude.js";
import { CodexWriter } from "../writers/codex.js";
import { OpenCodeWriter } from "../writers/opencode.js";

/**
 * Core conversion engine.
 * Reads from any harness, writes to any harness via the unified intermediate format.
 */
export class SessionConverter {
  private claudeReader = new ClaudeReader();
  private codexReader = new CodexReader();
  private opencodeReader = new OpenCodeReader();
  private claudeWriter = new ClaudeWriter();
  private codexWriter = new CodexWriter();
  private opencodeWriter = new OpenCodeWriter();

  /**
   * List convertible sessions from a harness.
   */
  async listSessions(
    harness: HarnessType,
    options?: { cwdPrefix?: string; searchPaths?: string[] }
  ): Promise<SessionSummary[]> {
    switch (harness) {
      case "claude":
        return this.claudeReader.listSessions(options?.cwdPrefix);
      case "codex":
        return this.codexReader.listSessions(options?.cwdPrefix);
      case "opencode":
        return this.opencodeReader.listSessions(options?.cwdPrefix, options?.searchPaths);
      default:
        return [];
    }
  }

  /**
   * Read a session from any harness into the unified format.
   */
  async readSession(
    harness: HarnessType,
    sessionId: string,
    options?: { searchPaths?: string[] }
  ): Promise<Conversation | null> {
    switch (harness) {
      case "claude":
        return this.claudeReader.readSession(sessionId);
      case "codex":
        return this.codexReader.readSession(sessionId);
      case "opencode":
        return this.opencodeReader.readSession(sessionId, options?.searchPaths);
      default:
        return null;
    }
  }

  /**
   * Convert a session from one harness to another.
   * Reads from source, writes to target.
   */
  async convert(
    sourceHarness: HarnessType,
    targetHarness: HarnessType,
    sessionId: string,
    options?: {
      /** For OpenCode writer: override target project path */
      projectPath?: string;
      /** Search paths for finding OpenCode DBs */
      searchPaths?: string[];
    }
  ): Promise<ConversionResult> {
    // Read source
    const conv = await this.readSession(sourceHarness, sessionId, options);
    if (!conv) {
      return { success: false, error: `Session '${sessionId}' not found in ${sourceHarness}` };
    }

    // Validate
    if (conv.messages.length === 0) {
      return { success: false, error: `Session '${sessionId}' has no messages to convert` };
    }

    // Write to target
    return this.writeToTarget(conv, targetHarness, options?.projectPath);
  }

  /**
   * Convert a session by its source file path (auto-detect format).
   */
  async convertByPath(
    sourcePath: string,
    targetHarness: HarnessType,
    options?: { projectPath?: string }
  ): Promise<ConversionResult> {
    let conv: Conversation;

    if (sourcePath.endsWith(".jsonl")) {
      // Could be Claude or Codex — try Claude first (look for typical patterns)
      try {
        conv = await this.claudeReader.readSessionByPath(sourcePath);
      } catch {
        conv = await this.codexReader.readSessionByPath(sourcePath);
      }
    } else if (sourcePath.endsWith(".db")) {
      const dbSessionId = options?.projectPath || "";
      const result = await this.opencodeReader.readSessionFromDb(sourcePath, dbSessionId);
      if (!result) {
        return { success: false, error: `Could not read session from OpenCode DB: ${sourcePath}` };
      }
      conv = result;
    } else {
      return { success: false, error: `Unknown file format: ${sourcePath}` };
    }

    if (conv.messages.length === 0) {
      return { success: false, error: `No messages found in source file` };
    }

    return this.writeToTarget(conv, targetHarness, options?.projectPath);
  }

  /**
   * Preview what a conversion would look like (without writing).
   */
  async preview(
    sourceHarness: HarnessType,
    targetHarness: HarnessType,
    sessionId: string,
    options?: { searchPaths?: string[] }
  ): Promise<string> {
    const conv = await this.readSession(sourceHarness, sessionId, options);
    if (!conv) return `Session '${sessionId}' not found in ${sourceHarness}.`;

    const lines = [
      `## Conversion Preview`,
      ``,
      `**Source**: [${conv.sourceHarness}] ${conv.id}`,
      `**Target**: ${targetHarness}`,
      `**Title**: ${conv.title}`,
      `**CWD**: ${conv.cwd}`,
      `**Model**: ${conv.model || "unknown"}`,
      `**Messages**: ${conv.messages.length}`,
      ``,
      `### Message Breakdown`,
    ];

    const roleCounts: Record<string, number> = {};
    const toolCounts: Record<string, number> = {};

    for (const msg of conv.messages) {
      roleCounts[msg.role] = (roleCounts[msg.role] || 0) + 1;
      for (const part of msg.parts) {
        if (part.type === "tool_call") {
          toolCounts[part.name] = (toolCounts[part.name] || 0) + 1;
        }
      }
    }

    for (const [role, count] of Object.entries(roleCounts)) {
      lines.push(`- ${role}: ${count} messages`);
    }

    if (Object.keys(toolCounts).length > 0) {
      lines.push(``, `### Tool Calls`);
      for (const [name, count] of Object.entries(toolCounts).sort((a, b) => b[1] - a[1])) {
        lines.push(`- ${name}: ${count}x`);
      }
    }

    // Compatibility notes
    lines.push(``, `### Compatibility Notes`);
    if (targetHarness === "claude") {
      if (conv.messages.some(m => m.role === "system")) {
        lines.push(`- ⚠ System messages will be dropped (Claude doesn't store them in JSONL)`);
      }
      if (toolCounts["Task"]) {
        lines.push(`- ⚠ Sub-agent tasks (Task tool) will be converted as regular tool calls`);
      }
    } else if (targetHarness === "codex") {
      if (conv.messages.some(m => m.role === "system")) {
        lines.push(`- ⚠ System messages will be converted to user messages`);
      }
      lines.push(`- Tool results will be converted to function_call_output items`);
    } else if (targetHarness === "opencode") {
      lines.push(`- Session will be written to <project>/.opencode/opencode.db`);
      lines.push(`- OpenCode must be restarted to discover the new session`);
    }

    return lines.join("\n");
  }

  // ---- Internal ----

  private async writeToTarget(
    conv: Conversation,
    targetHarness: HarnessType,
    projectPath?: string
  ): Promise<ConversionResult> {
    switch (targetHarness) {
      case "claude":
        return this.claudeWriter.write(conv);
      case "codex":
        return this.codexWriter.write(conv);
      case "opencode":
        return this.opencodeWriter.write(conv, projectPath);
      default:
        return { success: false, error: `Unknown target harness: ${targetHarness}` };
    }
  }
}