import { describe, expect, it } from "vitest";
import { HermesReader, normalizeHermesSession } from "../src/readers/hermes.js";

describe("HermesReader", () => {
  it("keeps the push origin distinct from the raw API session id", () => {
    const session = new HermesReader().readSession({
      session_key: "telegram:chat-7:thread-3",
      session_id: "api-internal-42",
      platform: "telegram",
      chat_id: "chat-7",
      thread_id: "thread-3",
      source: "telegram-push",
      messages: [{ role: "user", content: "hello Hermes" }],
    });

    expect(session?.id).toBe("telegram:chat-7:thread-3");
    expect(session?.locator).toEqual({
      kind: "hermes",
      sessionKey: "telegram:chat-7:thread-3",
      apiSessionId: "api-internal-42",
      pushSource: {
        platform: "telegram",
        chatId: "chat-7",
        threadId: "thread-3",
        source: "telegram-push",
      },
    });
    expect(session?.meta?.apiSessionId).toBe("api-internal-42");
    expect(session?.meta?.pushSource).toEqual(session?.locator.pushSource);
  });

  it("normalizes messages and retains unknown payloads without execution", () => {
    const result = normalizeHermesSession({
      session_key: "hermes-key",
      messages: [
        { role: "assistant", content: [{ type: "text", text: "done" }, { type: "tool_call", id: "call-1", name: "list", input: { path: "." } }] },
        { role: "tool", tool_call_id: "call-1", content: "README.md" },
        { role: "assistant", content: [{ type: "future_block", value: 1 }] },
      ],
    });

    expect(result.session?.messages[0].parts).toEqual([
      { type: "text", text: "done" },
      { type: "tool_call", id: "call-1", name: "list", input: { path: "." }, finished: false },
    ]);
    expect(result.session?.messages[1].parts).toEqual([
      { type: "tool_result", toolCallId: "call-1", content: "README.md", isError: false },
    ]);
    expect(result.unknownPayloads).toHaveLength(2);
    expect(result.unknownPayloads).toContainEqual({ role: "assistant", content: [{ type: "future_block", value: 1 }] });
    expect(result.warnings).toContain("Unknown Hermes payload at message 2 part 0");
  });

  it("does not confuse a missing session key with session_id", () => {
    const session = new HermesReader().readSession({ session_id: "raw-only", messages: [] });
    expect(session?.id).toBe("raw-only");
    expect(session?.locator.apiSessionId).toBe("raw-only");
    expect(session?.locator.pushSource).toEqual({});
  });
});
