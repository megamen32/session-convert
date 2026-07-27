import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { OpenCodeWriter } from "../src/writers/opencode.js";

type JsonObject = Record<string, any>;

const baseUrl = (process.env.OPENCODE_SMOKE_URL || "http://127.0.0.1:4095").replace(/\/$/, "");
const username = process.env.OPENCODE_SMOKE_USER || "opencode";
const password = process.env.OPENCODE_SMOKE_PASSWORD;
const model = process.env.OPENCODE_SMOKE_MODEL || "opencode/big-pickle";
const project = process.env.OPENCODE_SMOKE_PROJECT || join(homedir(), "PycharmProjects", "TelegramAuto");
const logPath = process.env.OPENCODE_SMOKE_LOG || join("trash", "logs", `live-resume-${Date.now()}.log`);

if (!password) {
  throw new Error("OPENCODE_SMOKE_PASSWORD is required for the live resume smoke test");
}

const auth = Buffer.from(`${username}:${password}`).toString("base64");

async function log(message: string, value?: unknown): Promise<void> {
  const line = value === undefined ? message : `${message} ${JSON.stringify(value)}`;
  console.log(line);
  await appendFile(logPath, `${line}\n`);
}

async function request(path: string, init?: RequestInit): Promise<{ status: number; body: JsonObject | JsonObject[] | null }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${auth}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const text = await response.text();
  let body: JsonObject | JsonObject[] | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as JsonObject | JsonObject[];
    } catch {
      body = { raw: text };
    }
  }
  return { status: response.status, body };
}

function modelReference(value: string): { providerID: string; modelID: string } {
  const separator = value.indexOf("/");
  return separator > 0
    ? { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) }
    : { providerID: "session-convert", modelID: value };
}

function latestAssistant(body: JsonObject | JsonObject[] | null): JsonObject | null {
  if (!Array.isArray(body)) return null;
  const messages = body.filter((item) => item && typeof item === "object" && (item as JsonObject).info?.role === "assistant");
  return (messages.at(-1) as JsonObject | undefined) ?? null;
}

function assistantSummary(message: JsonObject | null): JsonObject | null {
  if (!message) return null;
  const info = message.info as JsonObject;
  const parts = Array.isArray(message.parts) ? message.parts as JsonObject[] : [];
  return {
    id: info.id,
    created: info.time?.created,
    error: info.error ?? null,
    text: parts.filter((part) => part.type === "text").map((part) => part.text).join(" "),
    parts: parts.map((part) => part.type),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await mkdir(dirname(logPath), { recursive: true });
await log("live resume smoke started", { baseUrl, model, project, logPath });

const health = await request("/global/health");
await log("health", { status: health.status, body: health.body });
if (health.status !== 200) throw new Error(`OpenCode health check failed: HTTP ${health.status}`);

const modelRef = modelReference(model);
const now = new Date().toISOString();
const created = await new OpenCodeWriter().write({
  id: `session-convert-live-${Date.now()}`,
  sourceHarness: "claude",
  cwd: project,
  model,
  title: "session-convert live resume smoke",
  createdAt: now,
  updatedAt: now,
  messages: [
    { role: "user", parts: [{ type: "text", text: "Prepare to resume this converted session." }], timestamp: now },
    {
      role: "assistant",
      model,
      parts: [
        { type: "text", text: "The converted session is ready." },
        { type: "tool_call", id: "session-convert-smoke-call", name: "Read", input: { file_path: "README.md" }, finished: true },
        { type: "tool_result", toolCallId: "session-convert-smoke-call", name: "Read", content: "fixture output" },
      ],
      timestamp: now,
    },
  ],
});

if (!created.success || !created.targetSessionId) throw new Error(created.error || "Failed to create smoke session");
const sessionId = created.targetSessionId;
await log("session created", { sessionId, targetPath: created.targetPath });

try {
  const promptStarted = Date.now();
  const prompt = await request(`/session/${sessionId}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({
      model: modelRef,
      agent: "build",
      tools: {},
      parts: [{ type: "text", text: "Resume smoke test. Reply with a short confirmation. Do not call tools, edit files, or run commands." }],
    }),
  });
  await log("prompt_async", { status: prompt.status, body: prompt.body });
  if (prompt.status !== 204) throw new Error(`prompt_async failed: HTTP ${prompt.status}`);

  let completed: JsonObject | null = null;
  for (let attempt = 1; attempt <= 60; attempt++) {
    await sleep(2000);
    const [status, messages] = await Promise.all([
      request("/session/status"),
      request(`/session/${sessionId}/message?limit=20`),
    ]);
    const statusBody = status.body && !Array.isArray(status.body) ? status.body[sessionId] ?? null : null;
    const assistant = latestAssistant(messages.body);
    const summary = assistantSummary(assistant);
    await log(`poll ${attempt}`, { status: statusBody, assistant: summary });
    const info = assistant?.info as JsonObject | undefined;
    const parts = Array.isArray(assistant?.parts) ? assistant.parts : [];
    const partTypes = parts.map((part) => (part as JsonObject).type);
    const finished = partTypes.includes("step-finish") || Boolean(info?.error);
    if (typeof info?.time?.created === "number" && info.time.created > promptStarted && finished) {
      completed = summary;
      break;
    }
  }

  if (!completed) throw new Error("Timed out waiting for a completed assistant response");
  if (completed.error) throw new Error(`Resume returned an assistant error: ${JSON.stringify(completed.error)}`);
  if (!String(completed.text).trim()) {
    throw new Error(`Resume response did not contain text: ${JSON.stringify(completed)}`);
  }
  await log("resume passed", completed);
} finally {
  const deleted = await request(`/session/${sessionId}`, { method: "DELETE" });
  await log("session cleanup", { status: deleted.status, body: deleted.body });
}
