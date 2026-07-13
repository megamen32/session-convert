#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { SessionConverter } from "./core/converter.js";
import type { HarnessType } from "./types.js";

const converter = new SessionConverter();

async function main() {
  const server = new McpServer({
    name: "session-convert",
    version: "0.1.0",
    description: "Convert coding agent sessions between Claude Code, Codex CLI, and OpenCode. Unique: full OpenCode SQLite read/write support.",
  });

  // ===== Tool: list_sessions =====
  server.tool(
    "list_sessions",
    "List convertible sessions from a harness. Shows session ID, title, CWD, model, message count, and age. Use this to find the session ID to convert.",
    {
      harness: z.enum(["claude", "codex", "opencode"]).describe("Which harness to list sessions from"),
      cwdPrefix: z.string().optional().describe("Filter by CWD prefix (e.g. '~/apps' to find sessions in that directory tree)"),
      searchPaths: z.array(z.string()).optional().describe("Additional paths to search for OpenCode databases (only for opencode harness)"),
    },
    async (args) => {
      try {
        const sessions = await converter.listSessions(args.harness as HarnessType, {
          cwdPrefix: args.cwdPrefix,
          searchPaths: args.searchPaths,
        });

        if (sessions.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No sessions found for ${args.harness}.${args.cwdPrefix ? ` (filtered by ${args.cwdPrefix})` : ""}` }],
          };
        }

        const lines = [`Found ${sessions.length} session(s) on ${args.harness}:`, ""];
        for (const s of sessions) {
          const age = getTimeAgo(s.updatedAt);
          lines.push(
            `[${s.harness}] ${s.id}`,
            `  Title: ${s.title}`,
            `  CWD: ${s.cwd}`,
            `  Model: ${s.model || "unknown"}`,
            `  Messages: ${s.messageCount}`,
            `  Updated: ${s.updatedAt} (${age})`,
            `  Path: ${s.sourcePath}`,
            ""
          );
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error listing sessions: ${(err as Error).message}` }] };
      }
    }
  );

  // ===== Tool: convert_session =====
  server.tool(
    "convert_session",
    "Convert a session from one harness to another. Reads the session, transforms messages to the target format, and writes it to the target harness's native storage. OpenCode conversion (read/write) is uniquely supported — no other tool does this.",
    {
      sessionId: z.string().describe("Session ID to convert"),
      from: z.enum(["claude", "codex", "opencode"]).describe("Source harness"),
      to: z.enum(["claude", "codex", "opencode"]).describe("Target harness"),
      projectPath: z.string().optional().describe("For OpenCode target: override the project directory where .opencode/opencode.db will be created/updated"),
      searchPaths: z.array(z.string()).optional().describe("For OpenCode source: paths to search for databases"),
    },
    async (args) => {
      if (args.from === args.to) {
        return { content: [{ type: "text" as const, text: "Source and target are the same. Nothing to convert." }] };
      }

      try {
        const result = await converter.convert(
          args.from as HarnessType,
          args.to as HarnessType,
          args.sessionId,
          { projectPath: args.projectPath, searchPaths: args.searchPaths }
        );

        if (result.success) {
          const lines = [
            `Session converted successfully!`,
            ``,
            `**From**: ${args.from} → **To**: ${args.to}`,
            `**New session ID**: ${result.targetSessionId}`,
            `**Messages written**: ${result.messageCount}`,
            `**Location**: ${result.targetPath}`,
          ];
          if (result.warnings) {
            lines.push(``, `**Warnings:**`);
            for (const w of result.warnings) {
              lines.push(`- ${w}`);
            }
          }

          if (args.to === "claude") {
            lines.push(``, `Resume with: claude --resume ${result.targetSessionId}`);
          } else if (args.to === "codex") {
            lines.push(``, `Resume with: codex resume ${result.targetSessionId}`);
          } else if (args.to === "opencode") {
            lines.push(``, `Restart OpenCode in the project directory to see the new session.`);
          }

          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }

        return { content: [{ type: "text" as const, text: `Conversion failed: ${result.error}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] };
      }
    }
  );

  // ===== Tool: preview_conversion =====
  server.tool(
    "preview_conversion",
    "Preview what a session conversion would look like without actually writing anything. Shows message breakdown, tool call stats, and compatibility notes for the target format.",
    {
      sessionId: z.string().describe("Session ID to preview"),
      from: z.enum(["claude", "codex", "opencode"]).describe("Source harness"),
      to: z.enum(["claude", "codex", "opencode"]).describe("Target harness"),
      searchPaths: z.array(z.string()).optional().describe("For OpenCode source: paths to search for databases"),
    },
    async (args) => {
      try {
        const preview = await converter.preview(
          args.from as HarnessType,
          args.to as HarnessType,
          args.sessionId,
          { searchPaths: args.searchPaths }
        );
        return { content: [{ type: "text" as const, text: preview }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] };
      }
    }
  );

  // ===== Tool: convert_by_path =====
  server.tool(
    "convert_by_path",
    "Convert a session file by its direct file path. Auto-detects the format (Claude JSONL, Codex rollout JSONL, or OpenCode .db). Useful when you know the exact file location.",
    {
      sourcePath: z.string().describe("Absolute path to the source session file (.jsonl or .db)"),
      to: z.enum(["claude", "codex", "opencode"]).describe("Target harness"),
      projectPath: z.string().optional().describe("For OpenCode target: project directory path"),
    },
    async (args) => {
      try {
        const result = await converter.convertByPath(args.sourcePath, args.to as HarnessType, {
          projectPath: args.projectPath,
        });

        if (result.success) {
          return {
            content: [{
              type: "text" as const,
              text: [
                `Converted ${args.sourcePath}`,
                `→ ${args.to}: ${result.targetPath}`,
                `Session ID: ${result.targetSessionId}`,
                `Messages: ${result.messageCount}`,
              ].join("\n"),
            }],
          };
        }

        return { content: [{ type: "text" as const, text: `Conversion failed: ${result.error}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] };
      }
    }
  );

  // Start
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[session-convert] MCP server running on stdio");
}

function getTimeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

main().catch((err) => {
  console.error("[session-convert] Fatal:", err);
  process.exit(1);
});