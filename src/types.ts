// ===== Unified Intermediate Conversation Format =====
// All three harness formats (Claude JSONL, Codex rollout JSONL, OpenCode SQLite)
// are converted to/from this common representation.

export type HarnessType = "claude" | "codex" | "opencode";

export interface Conversation {
  /** Unique session/conversation identifier */
  id: string;
  /** Which harness this came from (or is destined for) */
  sourceHarness: HarnessType;
  /** Working directory / project path */
  cwd: string;
  /** Git branch if available */
  gitBranch?: string;
  /** Model used (first or primary) */
  model?: string;
  /** Human-readable title or first prompt */
  title: string;
  /** When the conversation started (ISO 8601) */
  createdAt: string;
  /** When the conversation was last active (ISO 8601) */
  updatedAt: string;
  /** Ordered list of messages */
  messages: Message[];
  /** Token usage (approximate) */
  tokenUsage?: TokenUsage;
  /** Cost in USD if available */
  costUsd?: number;
  /** Source-specific metadata we can't represent in the unified format */
  meta?: Record<string, unknown>;
}

export interface Message {
  /** Unique ID for this message */
  id: string;
  /** "user" | "assistant" | "system" | "tool" */
  role: "user" | "assistant" | "system" | "tool";
  /** Ordered content blocks */
  parts: ContentPart[];
  /** Model that generated this (assistant only) */
  model?: string;
  /** Timestamp (ISO 8601) */
  timestamp?: string;
  /** Token usage for this specific message (assistant only) */
  usage?: TokenUsage;
}

export type ContentPart =
  | TextPart
  | ToolCallPart
  | ToolResultPart
  | ThinkingPart
  | ImagePart;

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  /** Tool arguments as a parsed object */
  input: Record<string, unknown>;
  /** Whether the tool call completed */
  finished?: boolean;
}

export interface ToolResultPart {
  type: "tool_result";
  /** References the tool call ID */
  toolCallId: string;
  /** Tool name */
  name?: string;
  /** Result content (text) */
  content: string;
  /** Whether the tool call errored */
  isError?: boolean;
}

export interface ThinkingPart {
  type: "thinking";
  /** Extended thinking / reasoning text */
  text: string;
}

export interface ImagePart {
  type: "image";
  /** URL or base64 data URI */
  url: string;
  detail?: "auto" | "low" | "high";
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface SessionSummary {
  id: string;
  harness: HarnessType;
  title: string;
  cwd: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** Path to the source file */
  sourcePath: string;
  costUsd?: number;
}

export interface ConversionResult {
  success: boolean;
  targetSessionId?: string;
  targetPath?: string;
  messageCount?: number;
  error?: string;
  warnings?: string[];
}