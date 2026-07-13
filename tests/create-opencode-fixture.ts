import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

await mkdir(join(__dirname, "fixtures", "opencode-project", ".opencode"), { recursive: true });

const db = new Database(join(__dirname, "fixtures", "opencode-project", ".opencode", "opencode.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

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

const sessionId = "opencode-test-session";
const now = Math.floor(Date.now() / 1000);
const base = now - 300;

// Insert session
db.prepare(
  "INSERT INTO sessions (id, title, message_count, prompt_tokens, completion_tokens, cost, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?)"
).run(sessionId, "Deploy the API to production", 6, 3000, 800, 0.05, base + 300, base);

// Messages
const msgs = [
  {
    id: "oc-u-1",
    session_id: sessionId,
    role: "user",
    parts: JSON.stringify([{ type: "text", data: { text: "Deploy the API to production using Docker" } }]),
    model: null,
    created_at: base,
    updated_at: base,
    finished_at: null,
  },
  {
    id: "oc-a-1",
    session_id: sessionId,
    role: "assistant",
    parts: JSON.stringify([
      { type: "reasoning", data: { thinking: "I need to create a Dockerfile and a docker-compose.yml for the API deployment." } },
      { type: "tool_call", data: { id: "tc-01", name: "write_file", input: JSON.stringify({ path: "Dockerfile", content: "FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --only=production\nCOPY . .\nEXPOSE 3000\nCMD [\"node\", \"server.js\"]" }), type: "function", finished: true } },
    ]),
    model: "anthropic/claude-sonnet-4-20250514",
    created_at: base + 10,
    updated_at: base + 10,
    finished_at: null,
  },
  {
    id: "oc-t-1",
    session_id: sessionId,
    role: "tool",
    parts: JSON.stringify([{ type: "finish", data: { reason: "stop", time: 1000 } }]),
    model: "anthropic/claude-sonnet-4-20250514",
    created_at: base + 10,
    updated_at: base + 10,
    finished_at: null,
  },
  {
    id: "oc-u-2",
    session_id: sessionId,
    role: "user",
    parts: JSON.stringify([
      { type: "tool_result", data: { tool_call_id: "tc-01", name: "write_file", content: "File Dockerfile written successfully", metadata: "", is_error: false } },
    ]),
    model: null,
    created_at: base + 20,
    updated_at: base + 20,
    finished_at: null,
  },
  {
    id: "oc-a-2",
    session_id: sessionId,
    role: "assistant",
    parts: JSON.stringify([
      { type: "tool_call", data: { id: "tc-02", name: "write_file", input: JSON.stringify({ path: "docker-compose.yml", content: "version: '3.8'\nservices:\n  api:\n    build: .\n    ports:\n      - '3000:3000'\n    environment:\n      - NODE_ENV=production" }), type: "function", finished: true } },
    ]),
    model: "anthropic/claude-sonnet-4-20250514",
    created_at: base + 30,
    updated_at: base + 30,
    finished_at: null,
  },
  {
    id: "oc-t-2",
    session_id: sessionId,
    role: "tool",
    parts: JSON.stringify([{ type: "finish", data: { reason: "stop", time: 2000 } }]),
    model: "anthropic/claude-sonnet-4-20250514",
    created_at: base + 30,
    updated_at: base + 30,
    finished_at: null,
  },
  {
    id: "oc-u-3",
    session_id: sessionId,
    role: "user",
    parts: JSON.stringify([
      { type: "tool_result", data: { tool_call_id: "tc-02", name: "write_file", content: "File docker-compose.yml written successfully", metadata: "", is_error: false } },
    ]),
    model: null,
    created_at: base + 40,
    updated_at: base + 40,
    finished_at: null,
  },
  {
    id: "oc-a-3",
    session_id: sessionId,
    role: "assistant",
    parts: JSON.stringify([
      { type: "text", data: { text: "Both Dockerfile and docker-compose.yml are ready. Run `docker-compose up --build` to deploy the API to production." } },
    ]),
    model: "anthropic/claude-sonnet-4-20250514",
    created_at: base + 50,
    updated_at: base + 50,
    finished_at: null,
  },
  {
    id: "oc-t-3",
    session_id: sessionId,
    role: "tool",
    parts: JSON.stringify([{ type: "finish", data: { reason: "stop", time: 3000 } }]),
    model: "anthropic/claude-sonnet-4-20250514",
    created_at: base + 50,
    updated_at: base + 50,
    finished_at: null,
  },
];

const insertMsg = db.prepare(
  "INSERT INTO messages (id, session_id, role, parts, model, created_at, updated_at, finished_at) VALUES (?,?,?,?,?,?,?,?)"
);

for (const m of msgs) {
  insertMsg.run(m.id, m.session_id, m.role, m.parts, m.model, m.created_at, m.updated_at, m.finished_at);
}

db.close();
console.log("OpenCode fixture DB created successfully");