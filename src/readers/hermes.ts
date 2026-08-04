import type { ContentPart, Message } from "../types.js";

/** The delivery origin of a Hermes push, kept separate from API identity. */
export interface HermesPushSource {
  platform?: string;
  chatId?: string; chatType?: string; threadId?: string;
  userId?: string; userIdAlt?: string; scopeId?: string;
  prospectiveThreadId?: string; profile?: string;
  source?: string;
}

/** Stable Hermes locator. `apiSessionId` is never used as the push target. */
export interface HermesSessionLocator {
  kind: "hermes";
  sessionKey: string;
  apiSessionId?: string;
  pushSource: HermesPushSource;
}

export interface HermesCanonicalSession {
  id: string;
  sourceHarness: "hermes";
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  model?: string;
  locator: HermesSessionLocator;
  meta?: Record<string, unknown>;
}

export interface HermesNormalizationResult {
  session?: HermesCanonicalSession;
  warnings: string[];
  unknownPayloads: unknown[];
}

type RecordValue = Record<string, unknown>;

/** Normalize an observed Hermes export or conversation row. This is read-only. */
export class HermesReader {
  normalize(input: unknown): HermesNormalizationResult {
    const warnings: string[] = [];
    const unknownPayloads: unknown[] = [];
    const root = asRecord(input);
    if (!root) return { warnings: ["Hermes session root is not an object"], unknownPayloads: [input] };

    const locator = normalizeLocator(root, warnings);
    const rawMessages = firstArray(root, ["messages", "history", "conversation"]);
    if (!rawMessages) {
      return { warnings: ["Hermes session has no messages/history/conversation array"], unknownPayloads: [input] };
    }

    const messages = rawMessages.map((raw, index) => normalizeMessage(raw, index, warnings, unknownPayloads));
    const id = locator.sessionKey;
    const createdAt = timestamp(root.created_at ?? root.createdAt ?? root.started_at) || epoch();
    const updatedAt = timestamp(root.updated_at ?? root.updatedAt ?? root.finished_at) || createdAt;
    const meta: Record<string, unknown> = {
      hermes: true,
      apiSessionId: locator.apiSessionId,
      pushSource: locator.pushSource,
    };
    if (unknownPayloads.length) meta.unknownPayloads = unknownPayloads;

    return {
      warnings,
      unknownPayloads,
      session: {
        id,
        sourceHarness: "hermes",
        cwd: stringValue(root.cwd ?? root.working_directory ?? root.project_path) || "",
        title: stringValue(root.title ?? root.name ?? root.display_name) || firstText(messages) || id,
        createdAt,
        updatedAt,
        messages,
        model: stringValue(root.model),
        locator,
        meta,
      },
    };
  }

  /** Alias for callers that use the existing reader naming convention. */
  readSession(input: unknown): HermesCanonicalSession | null {
    return this.normalize(input).session || null;
  }
}

export const HermesSessionReader = HermesReader;

export function normalizeHermesSession(input: unknown): HermesNormalizationResult {
  return new HermesReader().normalize(input);
}

function normalizeLocator(root: RecordValue, warnings: string[]): HermesSessionLocator {
  const origin = asRecord(root.push_source ?? root.pushSource ?? root.origin) || {};
  const nestedSource = asRecord(origin.source);
  const pushSource: HermesPushSource = compact({
    platform: stringValue(origin.platform ?? root.platform),
    chatId: stringValue(origin.chat_id ?? origin.chatId ?? root.chat_id ?? root.chatId),
    threadId: stringValue(origin.thread_id ?? origin.threadId ?? root.thread_id ?? root.threadId),
    chatType: stringValue(origin.chat_type ?? origin.chatType ?? root.chat_type ?? root.chatType),
    userId: stringValue(origin.user_id ?? origin.userId ?? root.user_id ?? root.userId),
    userIdAlt: stringValue(origin.user_id_alt ?? origin.userIdAlt ?? root.user_id_alt ?? root.userIdAlt),
    scopeId: stringValue(origin.scope_id ?? origin.scopeId ?? root.scope_id ?? root.scopeId),
    prospectiveThreadId: stringValue(origin.prospective_thread_id ?? origin.prospectiveThreadId ?? root.prospective_thread_id ?? root.prospectiveThreadId),
    profile: stringValue(origin.profile ?? root.profile),
    source: stringValue(nestedSource?.name ?? origin.source ?? root.source),
  });
  const sessionKey = stringValue(root.session_key ?? root.sessionKey ?? root.id ?? root.key ?? root.session_id);
  if (!sessionKey) warnings.push("Hermes session has no session_key; using hermes-unknown");
  const apiSessionId = stringValue(root.session_id ?? root.sessionId);
  return { kind: "hermes", sessionKey: sessionKey || "hermes-unknown", apiSessionId, pushSource };
}

function normalizeMessage(raw: unknown, index: number, warnings: string[], unknownPayloads: unknown[]): Message {
  const record = asRecord(raw);
  if (!record) {
    warnings.push(`Hermes message ${index} is not an object`);
    unknownPayloads.push(raw);
    return { id: `hermes-message-${index}`, role: "system", parts: [{ type: "text", text: String(raw) }] };
  }
  const rawRole = stringValue(record.role ?? record.type) || "system";
  const role = (["user", "assistant", "system", "tool"] as const).includes(rawRole as never)
    ? rawRole as Message["role"] : "system";
  if (role === "system" && rawRole !== "system") warnings.push(`Hermes message ${index} has unknown role '${rawRole}'`);
  const parts: ContentPart[] = [];
  if (!(role === "tool" && record.tool_call_id !== undefined)) appendContent(parts, record.content ?? record.parts ?? record.text, `message ${index}`, warnings, unknownPayloads);
  if (Array.isArray(record.tool_calls)) for (const call of record.tool_calls) appendToolCall(parts, call, `message ${index}`, warnings, unknownPayloads);
  if (role === "tool" && record.tool_call_id !== undefined) parts.push({ type: "tool_result", toolCallId: String(record.tool_call_id), content: textValue(record.content ?? record.output ?? ""), isError: record.is_error === true });
  if (!parts.length) { warnings.push(`Hermes message ${index} has no recognized content`); unknownPayloads.push(raw); }
  return { id: stringValue(record.id ?? record.message_id) || `hermes-message-${index}`, role, parts, timestamp: timestamp(record.timestamp ?? record.created_at ?? record.createdAt), model: stringValue(record.model) };
}

function appendContent(parts: ContentPart[], content: unknown, context: string, warnings: string[], unknownPayloads: unknown[]): void {
  if (typeof content === "string") { if (content) parts.push({ type: "text", text: content }); return; }
  if (Array.isArray(content)) { content.forEach((item, index) => appendBlock(parts, item, `${context} part ${index}`, warnings, unknownPayloads)); return; }
  if (content !== undefined && content !== null) appendBlock(parts, content, context, warnings, unknownPayloads);
}

function appendBlock(parts: ContentPart[], raw: unknown, context: string, warnings: string[], unknownPayloads: unknown[]): void {
  const block = asRecord(raw);
  if (!block) { if (typeof raw === "string") parts.push({ type: "text", text: raw }); else { warnings.push(`Unknown Hermes payload at ${context}`); unknownPayloads.push(raw); } return; }
  const type = stringValue(block.type ?? block.kind);
  if (["text", "input_text", "output_text"].includes(type || "")) parts.push({ type: "text", text: textValue(block.text ?? block.content ?? "") });
  else if (["thinking", "reasoning"].includes(type || "")) parts.push({ type: "thinking", text: textValue(block.text ?? block.content ?? "") });
  else if (["tool_use", "tool_call"].includes(type || "")) appendToolCall(parts, block, context, warnings, unknownPayloads);
  else if (["tool_result", "tool_response"].includes(type || "")) parts.push({ type: "tool_result", toolCallId: stringValue(block.tool_call_id ?? block.toolCallId ?? block.id) || `${context}-tool`, name: stringValue(block.name), content: textValue(block.content ?? block.output ?? block.result ?? ""), isError: block.is_error === true || block.isError === true });
  else { warnings.push(`Unknown Hermes payload at ${context}`); unknownPayloads.push(raw); }
}

function appendToolCall(parts: ContentPart[], raw: unknown, context: string, warnings: string[], unknownPayloads: unknown[]): void {
  const block = asRecord(raw); if (!block) { warnings.push(`Unknown Hermes tool call at ${context}`); unknownPayloads.push(raw); return; }
  const fn = asRecord(block.function); const rawInput = block.input ?? block.arguments ?? fn?.arguments ?? {};
  const input = asRecord(rawInput); if (!input) { warnings.push(`Hermes tool call has non-object input at ${context}`); unknownPayloads.push(rawInput); }
  parts.push({ type: "tool_call", id: stringValue(block.id ?? block.tool_call_id) || `${context}-tool`, name: stringValue(block.name ?? fn?.name) || "unknown_tool", input: input || {}, finished: block.finished === true });
}

function firstArray(root: RecordValue, keys: string[]): unknown[] | undefined { for (const key of keys) if (Array.isArray(root[key])) return root[key]; return undefined; }
function asRecord(value: unknown): RecordValue | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function textValue(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value) ?? String(value); }
function timestamp(value: unknown): string | undefined { if (typeof value === "number") return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString(); return stringValue(value); }
function epoch(): string { return new Date(0).toISOString(); }
function firstText(messages: Message[]): string | undefined { for (const message of messages) for (const part of message.parts) if (part.type === "text" && part.text) return part.text.slice(0, 120); return undefined; }
function compact<T extends Record<string, unknown>>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as T; }
