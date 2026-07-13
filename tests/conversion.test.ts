import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, readFile, readdir, stat, access } from "node:fs/promises";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import { ClaudeReader } from "../src/readers/claude.js";
import { CodexReader } from "../src/readers/codex.js";
import { OpenCodeReader } from "../src/readers/opencode.js";
import { ClaudeWriter } from "../src/writers/claude.js";
import { CodexWriter } from "../src/writers/codex.js";
import { OpenCodeWriter } from "../src/writers/opencode.js";
import type { Conversation, ContentPart } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");

// ===== Fixtures =====

const claudeFixturePath = join(fixturesDir, "claude-session.jsonl");
const codexFixturePath = join(fixturesDir, "codex-session.jsonl");
const opencodeFixtureDb = join(fixturesDir, "opencode-project", ".opencode", "opencode.db");

// Temp dirs for writers
let claudeOutDir: string;
let codexOutDir: string;
let opencodeOutDir: string;

beforeAll(async () => {
  claudeOutDir = await mkdtemp(join(homedir(), "sc-test-claude-"));
  codexOutDir = await mkdtemp(join(homedir(), "sc-test-codex-"));
  opencodeOutDir = await mkdtemp(join(homedir(), "sc-test-opencode-"));
});

afterAll(async () => {
  for (const d of [claudeOutDir, codexOutDir, opencodeOutDir]) {
    await rm(d, { recursive: true, force: true });
  }
});

// ===== Reader Tests =====

describe("ClaudeReader", () => {
  it("reads a Claude JSONL session into unified format", async () => {
    const reader = new ClaudeReader();
    const conv = await reader.readSessionByPath(claudeFixturePath);

    expect(conv).not.toBeNull();
    expect(conv!.sourceHarness).toBe("claude");
    expect(conv!.messages.length).toBeGreaterThanOrEqual(3);
    expect(conv!.model).toContain("claude");

    // Check first user message
    const firstUser = conv!.messages.find(m => m.role === "user");
    expect(firstUser).toBeDefined();
    const textPart = firstUser!.parts.find(p => p.type === "text");
    expect(textPart).toBeDefined();
    expect((textPart as { text: string }).text).toContain("hello world");
  });

  it("parses thinking blocks", async () => {
    const reader = new ClaudeReader();
    const conv = await reader.readSessionByPath(claudeFixturePath);
    const thinkingMsgs = conv!.messages.filter(m =>
      m.parts.some(p => p.type === "thinking")
    );
    expect(thinkingMsgs.length).toBeGreaterThan(0);
    const thinking = thinkingMsgs[0].parts.find(p => p.type === "thinking") as { text: string };
    expect(thinking.text.length).toBeGreaterThan(0);
  });

  it("parses tool_use and tool_result pairs", async () => {
    const reader = new ClaudeReader();
    const conv = await reader.readSessionByPath(claudeFixturePath);

    const toolCalls = conv!.messages.flatMap(m => m.parts).filter(p => p.type === "tool_call");
    const toolResults = conv!.messages.flatMap(m => m.parts).filter(p => p.type === "tool_result");

    expect(toolCalls.length).toBeGreaterThan(0);
    expect(toolResults.length).toBeGreaterThan(0);

    // tool_call should have name and input
    const call = toolCalls[0] as { type: "tool_call"; name: string; input: Record<string, unknown> };
    expect(call.name).toBeDefined();
    expect(call.input).toBeDefined();

    // tool_result should reference a tool call
    const result = toolResults[0] as { type: "tool_result"; toolCallId: string; content: string };
    expect(result.toolCallId).toBeTruthy();
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("extracts token usage", async () => {
    const reader = new ClaudeReader();
    const conv = await reader.readSessionByPath(claudeFixturePath);
    const assistantMsgs = conv!.messages.filter(m => m.role === "assistant" && m.usage);
    expect(assistantMsgs.length).toBeGreaterThan(0);
    expect(assistantMsgs[0].usage!.inputTokens).toBeGreaterThan(0);
  });
});

describe("CodexReader", () => {
  it("reads a Codex rollout JSONL session into unified format", async () => {
    const reader = new CodexReader();
    const conv = await reader.readSessionByPath(codexFixturePath);

    expect(conv).not.toBeNull();
    expect(conv!.sourceHarness).toBe("codex");
    expect(conv!.messages.length).toBeGreaterThanOrEqual(2);

    // Check first user message
    const firstUser = conv!.messages.find(m => m.role === "user");
    expect(firstUser).toBeDefined();
    const textPart = firstUser!.parts.find(p => p.type === "text");
    expect((textPart as { text: string }).text).toContain("unit test");
  });

  it("parses reasoning blocks", async () => {
    const reader = new CodexReader();
    const conv = await reader.readSessionByPath(codexFixturePath);
    const thinkingMsgs = conv!.messages.filter(m =>
      m.parts.some(p => p.type === "thinking")
    );
    expect(thinkingMsgs.length).toBeGreaterThan(0);
  });

  it("parses function_call and function_call_output", async () => {
    const reader = new CodexReader();
    const conv = await reader.readSessionByPath(codexFixturePath);

    const toolCalls = conv!.messages.flatMap(m => m.parts).filter(p => p.type === "tool_call");
    const toolResults = conv!.messages.flatMap(m => m.parts).filter(p => p.type === "tool_result");

    expect(toolCalls.length).toBeGreaterThan(0);
    expect(toolResults.length).toBeGreaterThan(0);

    const call = toolCalls[0] as { type: "tool_call"; name: string; input: Record<string, unknown> };
    expect(call.name).toBe("shell");
    expect(call.input).toHaveProperty("command");

    const result = toolResults[0] as { type: "tool_result"; toolCallId: string; content: string };
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("extracts session_meta (cwd, git branch)", async () => {
    const reader = new CodexReader();
    const conv = await reader.readSessionByPath(codexFixturePath);
    expect(conv!.cwd).toBe("/home/dev/myapp");
    expect(conv!.gitBranch).toBe("main");
  });
});

describe("OpenCodeReader", () => {
  it("reads an OpenCode SQLite session into unified format", async () => {
    const reader = new OpenCodeReader();
    const conv = await reader.readSessionFromDb(opencodeFixtureDb, "opencode-test-session");

    expect(conv).not.toBeNull();
    expect(conv!.sourceHarness).toBe("opencode");
    expect(conv!.id).toBe("opencode-test-session");
    expect(conv!.messages.length).toBeGreaterThanOrEqual(2);
  });

  it("parses double-wrapped parts format", async () => {
    const reader = new OpenCodeReader();
    const conv = await reader.readSessionFromDb(opencodeFixtureDb, "opencode-test-session");

    // Check text part
    const textMsgs = conv!.messages.filter(m =>
      m.parts.some(p => p.type === "text")
    );
    expect(textMsgs.length).toBeGreaterThan(0);
    const textPart = textMsgs[0].parts.find(p => p.type === "text") as { text: string };
    expect(textPart.text).toContain("Docker");
  });

  it("parses reasoning (thinking) from OpenCode", async () => {
    const reader = new OpenCodeReader();
    const conv = await reader.readSessionFromDb(opencodeFixtureDb, "opencode-test-session");
    const thinkingMsgs = conv!.messages.filter(m =>
      m.parts.some(p => p.type === "thinking")
    );
    expect(thinkingMsgs.length).toBeGreaterThan(0);
  });

  it("parses tool_call and tool_result from OpenCode", async () => {
    const reader = new OpenCodeReader();
    const conv = await reader.readSessionFromDb(opencodeFixtureDb, "opencode-test-session");

    const toolCalls = conv!.messages.flatMap(m => m.parts).filter(p => p.type === "tool_call");
    const toolResults = conv!.messages.flatMap(m => m.parts).filter(p => p.type === "tool_result");

    expect(toolCalls.length).toBeGreaterThan(0);
    expect(toolResults.length).toBeGreaterThan(0);

    const call = toolCalls[0] as { type: "tool_call"; name: string; input: Record<string, unknown> };
    expect(call.name).toBe("write_file");
    expect(call.input).toHaveProperty("path");
  });

  it("skips finish parts", async () => {
    const reader = new OpenCodeReader();
    const conv = await reader.readSessionFromDb(opencodeFixtureDb, "opencode-test-session");
    const finishParts = conv!.messages.flatMap(m => m.parts).filter(p => p.type === "text" && "text" in p && (p as { text: string }).text.includes("finish"));
    // finish parts should not appear as text
    const allTexts = conv!.messages.flatMap(m => m.parts).filter(p => p.type === "text");
    for (const t of allTexts) {
      expect((t as { text: string }).text).not.toContain('"reason": "stop"');
    }
  });

  it("extracts session metadata (title, model, cost)", async () => {
    const reader = new OpenCodeReader();
    const conv = await reader.readSessionFromDb(opencodeFixtureDb, "opencode-test-session");
    expect(conv!.title).toBe("Deploy the API to production");
    expect(conv!.model).toContain("claude");
    expect(conv!.costUsd).toBeGreaterThan(0);
  });
});

// ===== Writer Tests =====

describe("ClaudeWriter", () => {
  it("writes a conversation to Claude JSONL format", async () => {
    const writer = new ClaudeWriter(claudeOutDir);
    const conv = makeMiniConversation("claude-writer-test", "claude");
    const result = await writer.write(conv);

    expect(result.success).toBe(true);
    expect(result.targetPath).toBeTruthy();
    expect(result.messageCount).toBeGreaterThan(0);

    // Verify file exists and is valid JSONL
    const content = await readFile(result.targetPath!, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const entry = JSON.parse(line);
      expect(entry.type).toMatch(/^(user|assistant)$/);
    }
  });

  it("converts tool_call to tool_use in output", async () => {
    const writer = new ClaudeWriter(claudeOutDir);
    const conv = makeMiniConversation("claude-tool-test", "claude");
    const result = await writer.write(conv);

    const content = await readFile(result.targetPath!, "utf-8");
    // Should contain tool_use blocks
    expect(content).toContain('"tool_use"');
    // Should contain tool_result blocks
    expect(content).toContain('"tool_result"');
    // Should contain thinking blocks
    expect(content).toContain('"thinking"');
  });
});

describe("CodexWriter", () => {
  it("writes a conversation to Codex rollout JSONL format", async () => {
    const writer = new CodexWriter(codexOutDir);
    const conv = makeMiniConversation("codex-writer-test", "codex");
    const result = await writer.write(conv);

    expect(result.success).toBe(true);
    expect(result.targetPath).toBeTruthy();
    expect(result.messageCount).toBeGreaterThan(0);

    // Verify it's valid JSONL
    const content = await readFile(result.targetPath!, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    // First line should be session_meta
    const first = JSON.parse(lines[0]);
    expect(first.type).toBe("session_meta");
    expect(first.payload.session_id).toBeTruthy();
  });

  it("converts messages to response_items with correct types", async () => {
    const writer = new CodexWriter(codexOutDir);
    const conv = makeMiniConversation("codex-types-test", "codex");
    const result = await writer.write(conv);

    const content = await readFile(result.targetPath!, "utf-8");
    // Should have session_meta, message, function_call types
    expect(content).toContain('"session_meta"');
    expect(content).toContain('"function_call"');
    expect(content).toContain('"output_text"');
    expect(content).toContain('"input_text"');
  });

  it("appends to session_index.jsonl", async () => {
    const writer = new CodexWriter(codexOutDir);
    const conv = makeMiniConversation("codex-index-test", "codex");
    await writer.write(conv);

    const indexPath = join(codexOutDir, "session_index.jsonl");
    const content = await readFile(indexPath, "utf-8");
    expect(content).toContain("codex-index-test");
  });
});

describe("OpenCodeWriter", () => {
  it("writes a conversation to OpenCode SQLite format", async () => {
    const writer = new OpenCodeWriter();
    const conv = makeMiniConversation("oc-writer-test", "opencode");
    const result = await writer.write(conv, opencodeOutDir);

    expect(result.success).toBe(true);
    expect(result.targetPath).toContain("opencode.db");
    expect(result.messageCount).toBeGreaterThan(0);

    // Verify DB is readable
    const db = new Database(result.targetPath!, { readonly: true });
    const sessions = db.prepare("SELECT * FROM sessions").all();
    expect(sessions.length).toBe(1);
    const messages = db.prepare("SELECT * FROM messages").all();
    expect(messages.length).toBeGreaterThan(0);
    db.close();
  });

  it("stores parts in double-wrapped format", async () => {
    const writer = new OpenCodeWriter();
    const conv = makeMiniConversation("oc-parts-test", "opencode");
    const result = await writer.write(conv, opencodeOutDir);

    const db = new Database(result.targetPath!, { readonly: true });
    const msg = db.prepare("SELECT parts FROM messages WHERE role = 'assistant' LIMIT 1").get() as { parts: string };
    db.close();

    const parts = JSON.parse(msg.parts);
    expect(Array.isArray(parts)).toBe(true);
    // Should be double-wrapped: [{ type: "text", data: { text: "..." } }]
    if (parts[0]?.type === "text") {
      expect(parts[0].data).toBeDefined();
      expect(parts[0].data.text).toBeDefined();
    }
  });

  it("stores tool_calls with correct double-wrapping", async () => {
    const writer = new OpenCodeWriter();
    const conv = makeMiniConversation("oc-tools-test", "opencode");
    const result = await writer.write(conv, opencodeOutDir);

    const db = new Database(result.targetPath!, { readonly: true });
    const msgs = db.prepare("SELECT parts FROM messages WHERE role = 'assistant'").all() as Array<{ parts: string }>;
    db.close();

    const allParts = msgs.flatMap(m => JSON.parse(m.parts));
    const toolCalls = allParts.filter((p: { type: string }) => p.type === "tool_call");
    expect(toolCalls.length).toBeGreaterThan(0);
    // Double-wrapped: data should contain id, name, input
    expect(toolCalls[0].data.id).toBeTruthy();
    expect(toolCalls[0].data.name).toBeTruthy();
    expect(toolCalls[0].data.input).toBeDefined();
  });
});

// ===== Roundtrip Tests (Read → Write → Read again) =====

describe("Roundtrip: Claude → Codex → OpenCode", () => {
  it("Claude JSONL → Codex rollout JSONL", async () => {
    const reader = new ClaudeReader();
    const writer = new CodexWriter(codexOutDir);

    // Read Claude fixture
    const conv = await reader.readSessionByPath(claudeFixturePath);

    // Write as Codex
    const result = await writer.write(conv);
    expect(result.success).toBe(true);

    // Read back the Codex output
    const codexReader = new CodexReader();
    const roundtrip = await codexReader.readSessionByPath(result.targetPath!);

    // Verify content preservation
    expect(roundtrip.messages.length).toBeGreaterThan(0);
    const originalText = conv.messages.flatMap(m => m.parts).filter(p => p.type === "text").map(p => (p as { text: string }).text);
    const roundtripText = roundtrip.messages.flatMap(m => m.parts).filter(p => p.type === "text").map(p => (p as { text: string }).text);

    // At least the user's first message should survive
    const origFirstUser = conv.messages.find(m => m.role === "user")?.parts.find(p => p.type === "text") as { text: string } | undefined;
    const allText = roundtripText.join(" ");
    expect(allText).toContain(origFirstUser?.text?.slice(0, 30) || "hello world");
  });

  it("Claude JSONL → OpenCode SQLite", async () => {
    const reader = new ClaudeReader();
    const writer = new OpenCodeWriter();

    const conv = await reader.readSessionByPath(claudeFixturePath);
    const result = await writer.write(conv, opencodeOutDir);
    expect(result.success).toBe(true);

    // Read back from OpenCode DB
    const ocReader = new OpenCodeReader();
    const roundtrip = await ocReader.readSessionFromDb(result.targetPath!, result.targetSessionId!);

    expect(roundtrip).not.toBeNull();
    expect(roundtrip!.messages.length).toBeGreaterThan(0);

    // Check tool calls survived
    const toolCalls = roundtrip!.messages.flatMap(m => m.parts).filter(p => p.type === "tool_call");
    expect(toolCalls.length).toBeGreaterThan(0);
  });
});

describe("Roundtrip: Codex → Claude → OpenCode", () => {
  it("Codex rollout JSONL → Claude JSONL", async () => {
    const reader = new CodexReader();
    const writer = new ClaudeWriter(claudeOutDir);

    const conv = await reader.readSessionByPath(codexFixturePath);
    const result = await writer.write(conv);
    expect(result.success).toBe(true);

    // Read back the Claude output
    const claudeReader = new ClaudeReader();
    const roundtrip = await claudeReader.readSessionByPath(result.targetPath!);

    expect(roundtrip.messages.length).toBeGreaterThan(0);

    // Original user message should survive
    const origFirstUser = conv.messages.find(m => m.role === "user")?.parts.find(p => p.type === "text") as { text: string } | undefined;
    const allText = roundtrip.messages.flatMap(m => m.parts).filter(p => p.type === "text").map(p => (p as { text: string }).text).join(" ");
    expect(allText).toContain(origFirstUser?.text?.slice(0, 20) || "unit test");
  });

  it("Codex rollout JSONL → OpenCode SQLite", async () => {
    const reader = new CodexReader();
    const writer = new OpenCodeWriter();

    const conv = await reader.readSessionByPath(codexFixturePath);
    const result = await writer.write(conv, opencodeOutDir);
    expect(result.success).toBe(true);

    const ocReader = new OpenCodeReader();
    const roundtrip = await ocReader.readSessionFromDb(result.targetPath!, result.targetSessionId!);

    expect(roundtrip).not.toBeNull();
    expect(roundtrip!.messages.length).toBeGreaterThan(0);
    // Shell tool calls should survive
    const toolCalls = roundtrip!.messages.flatMap(m => m.parts).filter(p => p.type === "tool_call");
    expect(toolCalls.some(tc => (tc as { name: string }).name === "shell")).toBe(true);
  });
});

describe("Roundtrip: OpenCode → Claude → Codex", () => {
  it("OpenCode SQLite → Claude JSONL", async () => {
    const reader = new OpenCodeReader();
    const writer = new ClaudeWriter(claudeOutDir);

    const conv = await reader.readSessionFromDb(opencodeFixtureDb, "opencode-test-session");
    expect(conv).not.toBeNull();

    const result = await writer.write(conv!);
    expect(result.success).toBe(true);

    // Read back
    const claudeReader = new ClaudeReader();
    const roundtrip = await claudeReader.readSessionByPath(result.targetPath!);

    expect(roundtrip.messages.length).toBeGreaterThan(0);
    // "Docker" should survive
    const allText = roundtrip.messages.flatMap(m => m.parts).filter(p => p.type === "text").map(p => (p as { text: string }).text).join(" ");
    expect(allText).toContain("Docker");
  });

  it("OpenCode SQLite → Codex rollout JSONL", async () => {
    const reader = new OpenCodeReader();
    const writer = new CodexWriter(codexOutDir);

    const conv = await reader.readSessionFromDb(opencodeFixtureDb, "opencode-test-session");
    expect(conv).not.toBeNull();

    const result = await writer.write(conv!);
    expect(result.success).toBe(true);

    // Read back
    const codexReader = new CodexReader();
    const roundtrip = await codexReader.readSessionByPath(result.targetPath!);

    expect(roundtrip.messages.length).toBeGreaterThan(0);
    const allText = roundtrip.messages.flatMap(m => m.parts).filter(p => p.type === "text").map(p => (p as { text: string }).text).join(" ");
    expect(allText).toContain("Docker");
  });
});

// ===== Edge Cases =====

describe("Edge cases", () => {
  it("handles conversation with only text messages", async () => {
    const writer = new ClaudeWriter(claudeOutDir);
    const conv: Conversation = {
      id: "text-only",
      sourceHarness: "claude",
      cwd: "/tmp/test",
      title: "Text only",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] },
        { id: "2", role: "assistant", parts: [{ type: "text", text: "Hi there!" }], model: "claude-3" },
      ],
    };
    const result = await writer.write(conv);
    expect(result.success).toBe(true);
    expect(result.messageCount).toBe(2);
  });

  it("handles conversation with system messages (should warn for Claude)", async () => {
    const writer = new ClaudeWriter(claudeOutDir);
    const conv: Conversation = {
      id: "system-test",
      sourceHarness: "opencode",
      cwd: "/tmp/test",
      title: "System test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        { id: "1", role: "system", parts: [{ type: "text", text: "You are helpful." }] },
        { id: "2", role: "user", parts: [{ type: "text", text: "Hello" }] },
        { id: "3", role: "assistant", parts: [{ type: "text", text: "Hi!" }], model: "gpt-4" },
      ],
    };
    const result = await writer.write(conv);
    expect(result.success).toBe(true);
    expect(result.warnings).toContainEqual("System messages are not natively supported in Claude JSONL");
    // System message should NOT appear in output (only user + assistant)
    const content = await readFile(result.targetPath!, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBe(2); // only user + assistant
  });

  it("OpenCode reader returns null for non-existent session", async () => {
    const reader = new OpenCodeReader();
    const result = await reader.readSessionFromDb(opencodeFixtureDb, "nonexistent-session");
    expect(result).toBeNull();
  });

  it("Claude writer produces valid JSONL (every line parses)", async () => {
    const writer = new ClaudeWriter(claudeOutDir);
    const conv = makeMiniConversation("jsonl-valid", "claude");
    const result = await writer.write(conv);

    const content = await readFile(result.targetPath!, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("Codex writer produces valid JSONL (every line parses)", async () => {
    const writer = new CodexWriter(codexOutDir);
    const conv = makeMiniConversation("jsonl-valid-codex", "codex");
    const result = await writer.write(conv);

    const content = await readFile(result.targetPath!, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("OpenCode writer creates tables if DB is new", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");

    const tmpDir = await mkdtemp(join(homedir(), "sc-new-db-"));
    try {
      const writer = new OpenCodeWriter();
      const conv = makeMiniConversation("new-db-test", "opencode");
      const result = await writer.write(conv, tmpDir);

      expect(result.success).toBe(true);

      // Verify tables exist
      const db = new Database(result.targetPath!, { readonly: true });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain("sessions");
      expect(tableNames).toContain("messages");
      db.close();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ===== Helper =====

function makeMiniConversation(id: string, source: "claude" | "codex" | "opencode"): Conversation {
  return {
    id,
    sourceHarness: source,
    cwd: "/home/dev/test-project",
    gitBranch: "main",
    model: source === "claude" ? "claude-sonnet-4-20250514" : source === "codex" ? "o4-mini" : "anthropic/claude-sonnet-4-20250514",
    title: `Test session ${id}`,
    createdAt: "2025-06-15T12:00:00.000Z",
    updatedAt: "2025-06-15T12:05:00.000Z",
    tokenUsage: { inputTokens: 2000, outputTokens: 500 },
    costUsd: 0.03,
    messages: [
      {
        id: `${id}-u1`,
        role: "user",
        parts: [{ type: "text", text: "Create a REST API endpoint for users" }],
        timestamp: "2025-06-15T12:00:00.000Z",
      },
      {
        id: `${id}-a1`,
        role: "assistant",
        parts: [
          { type: "thinking", text: "I need to create a GET /users endpoint with Express.js. Let me check the existing routes first." },
          { type: "tool_call", id: `${id}-tc1`, name: "Read", input: { file_path: "/home/dev/test-project/routes.js" }, finished: true },
        ],
        model: source === "claude" ? "claude-sonnet-4-20250514" : "o4-mini",
        timestamp: "2025-06-15T12:00:05.000Z",
        usage: { inputTokens: 1000, outputTokens: 100 },
      },
      {
        id: `${id}-u2`,
        role: "user",
        parts: [
          {
            type: "tool_result",
            toolCallId: `${id}-tc1`,
            name: "Read",
            content: "const router = require('express').Router();\nmodule.exports = router;",
          },
        ],
        timestamp: "2025-06-15T12:00:10.000Z",
      },
      {
        id: `${id}-a2`,
        role: "assistant",
        parts: [
          { type: "text", text: "I see the routes file is empty. Let me add the users endpoint." },
          {
            type: "tool_call",
            id: `${id}-tc2`,
            name: "Write",
            input: { file_path: "/home/dev/test-project/routes.js", content: "router.get('/users', (req, res) => res.json([]));" },
            finished: true,
          },
        ],
        model: source === "claude" ? "claude-sonnet-4-20250514" : "o4-mini",
        timestamp: "2025-06-15T12:00:15.000Z",
        usage: { inputTokens: 1500, outputTokens: 200 },
      },
      {
        id: `${id}-u3`,
        role: "user",
        parts: [
          {
            type: "tool_result",
            toolCallId: `${id}-tc2`,
            name: "Write",
            content: "File written successfully",
          },
        ],
        timestamp: "2025-06-15T12:00:20.000Z",
      },
      {
        id: `${id}-a3`,
        role: "assistant",
        parts: [
          { type: "text", text: "Done! The GET /users endpoint is ready. It returns an empty array for now." },
        ],
        model: source === "claude" ? "claude-sonnet-4-20250514" : "o4-mini",
        timestamp: "2025-06-15T12:00:25.000Z",
        usage: { inputTokens: 2000, outputTokens: 80 },
      },
    ],
  };
}