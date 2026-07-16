import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, rm, readFile, readdir, stat, access, writeFile } from "node:fs/promises";
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
  it("discovers current Claude sessions stored directly in the project directory", async () => {
    const claudeHome = await mkdtemp(join(homedir(), "sc-test-claude-home-"));
    const projectPath = join(claudeHome, "projects", "-home-roomhacker-PycharmProjects-TelegramAuto");
    const sessionId = "direct-layout-session";

    await mkdir(projectPath, { recursive: true });
    await writeFile(
      join(projectPath, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          cwd: "/home/roomhacker/PycharmProjects/TelegramAuto",
          timestamp: "2026-07-16T10:00:00.000Z",
          message: { role: "user", content: "Fix session converter" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          cwd: "/home/roomhacker/PycharmProjects/TelegramAuto",
          timestamp: "2026-07-16T10:00:01.000Z",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-20250514",
            content: [{ type: "text", text: "I will inspect the converter." }],
          },
        }),
      ].join("\n") + "\n",
    );

    try {
      const reader = new ClaudeReader(claudeHome);
      const sessions = await reader.listSessions("/home/roomhacker/PycharmProjects/TelegramAuto");
      const conversation = await reader.readSession(sessionId);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].title).toBe("Fix session converter");
      expect(conversation).not.toBeNull();
      expect(conversation!.title).toBe("Fix session converter");
    } finally {
      await rm(claudeHome, { recursive: true, force: true });
    }
  });

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

  it("reads the current OpenCode session/message/part schema", async () => {
    const tempDir = await mkdtemp(join(homedir(), "sc-test-current-opencode-reader-"));
    const dbPath = join(tempDir, ".opencode", "opencode.db");
    await createCurrentOpenCodeDatabase(dbPath);

    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO session (id, project_id, slug, directory, title, version, model, time_created, time_updated) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "ses-current-reader",
      "global",
      "current-reader",
      "/home/dev/test-project",
      "Current schema session",
      "1.17.18",
      JSON.stringify({ id: "MiniMax-M3", providerID: "minimax-coding-plan" }),
      1_750_000_000_000,
      1_750_000_001_000,
    );
    db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(
      "msg-current-reader",
      "ses-current-reader",
      1_750_000_000_000,
      1_750_000_000_000,
      JSON.stringify({ role: "assistant", modelID: "MiniMax-M3" }),
    );
    db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(
      "prt-current-reader",
      "msg-current-reader",
      "ses-current-reader",
      1_750_000_000_001,
      1_750_000_000_001,
      JSON.stringify({ type: "text", text: "Current OpenCode works." }),
    );
    db.close();

    try {
      const conv = await new OpenCodeReader().readSessionFromDb(dbPath, "ses-current-reader");
      expect(conv).not.toBeNull();
      expect(conv!.title).toBe("Current schema session");
      expect(conv!.model).toBe("minimax-coding-plan/MiniMax-M3");
      expect(conv!.messages).toHaveLength(1);
      expect(conv!.messages[0].parts).toEqual([{ type: "text", text: "Current OpenCode works." }]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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

  it("writes and reads OpenCode timestamps in milliseconds", async () => {
    const writer = new OpenCodeWriter();
    const reader = new OpenCodeReader();
    const conv = makeMiniConversation("oc-millisecond-timestamps-test", "opencode");
    const result = await writer.write(conv, opencodeOutDir);

    expect(result.success).toBe(true);

    const db = new Database(result.targetPath!, { readonly: true });
    const session = db.prepare("SELECT created_at, updated_at FROM sessions WHERE id = ?").get(result.targetSessionId) as {
      created_at: number;
      updated_at: number;
    };
    db.close();

    expect(session.created_at).toBeGreaterThan(1_000_000_000_000);
    expect(session.updated_at).toBeGreaterThan(1_000_000_000_000);

    const roundtrip = await reader.readSessionFromDb(result.targetPath!, result.targetSessionId!);
    expect(roundtrip!.createdAt).toBe(conv.createdAt);
    expect(roundtrip!.updatedAt).toBe(conv.updatedAt);
  });

  it("writes a session into the current OpenCode schema", async () => {
    const tempDir = await mkdtemp(join(homedir(), "sc-test-current-opencode-writer-"));
    const dbPath = join(tempDir, ".opencode", "opencode.db");
    await createCurrentOpenCodeDatabase(dbPath);

    try {
      const conv = makeMiniConversation("oc-current-schema-test", "claude");
      const result = await new OpenCodeWriter().write(conv, tempDir);

      expect(result.success).toBe(true);
      expect(result.targetSessionId).toMatch(/^ses_/);
      expect(result.targetPath).toBe(dbPath);

      const db = new Database(dbPath, { readonly: true });
      const counts = db.prepare(
        "SELECT (SELECT COUNT(*) FROM message WHERE session_id = ?) AS messages, " +
        "(SELECT COUNT(*) FROM part WHERE session_id = ?) AS parts"
      ).get(result.targetSessionId, result.targetSessionId) as { messages: number; parts: number };
      db.close();
      expect(counts.messages).toBe(conv.messages.length);
      expect(counts.parts).toBeGreaterThan(0);

      const roundtrip = await new OpenCodeReader().readSessionFromDb(dbPath, result.targetSessionId!);
      expect(roundtrip!.messages.length).toBe(conv.messages.length);
      expect(roundtrip!.title).toBe(conv.title);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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

async function createCurrentOpenCodeDatabase(dbPath: string): Promise<void> {
  await mkdir(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      vcs TEXT,
      name TEXT,
      icon_url TEXT,
      icon_url_override TEXT,
      icon_color TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_initialized INTEGER,
      sandboxes TEXT NOT NULL,
      commands TEXT
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      path TEXT,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      metadata TEXT,
      cost REAL DEFAULT 0 NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
      revert TEXT,
      permission TEXT,
      agent TEXT,
      model TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?)").run(
    "global",
    "/",
    Date.now(),
    Date.now(),
    "[]",
  );
  db.close();
}

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
