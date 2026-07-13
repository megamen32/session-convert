# session-convert

**MCP server that converts coding agent sessions between Claude Code, Codex CLI, and OpenCode.**

The only tool that supports **OpenCode SQLite** session conversion — [agent-convert](https://github.com/theoriclabs/agent-convert) and [ctxmv](https://github.com/Ryu0118/ctxmv) handle Claude↔Codex but nothing touches OpenCode's `.opencode/opencode.db`.

## What problem does this solve?

You're using multiple AI coding agents (Claude Code, Codex CLI, OpenCode) and want to **migrate a session from one to another** — maybe you started in Claude Code but want to continue in OpenCode, or you found a great Codex session that would be useful in Claude.

Each agent stores sessions differently:
- **Claude Code** — JSONL files in `~/.claude/projects/<hash>/sessions/`
- **Codex CLI** — Rollout JSONL in `~/.codex/sessions/YYYY/MM/DD/`
- **OpenCode** — SQLite database in `<project>/.opencode/opencode.db`

This MCP server reads from any of these, normalizes into a unified format, and writes to any other. **All 6 conversion directions work** (Claude→Codex, Claude→OpenCode, Codex→Claude, Codex→OpenCode, OpenCode→Claude, OpenCode→Codex).

## Quick Start

```bash
git clone https://github.com/megamen32/session-convert.git
cd session-convert
npm install
npm run build
```

### MCP Configuration

Add to your MCP client config (Claude Desktop, Cursor, Windsurf, etc.):

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "session-convert": {
      "command": "node",
      "args": ["/absolute/path/to/session-convert/dist/index.js"]
    }
  }
}
```

**Cursor / Windsurf** (`.cursor/mcp.json` or equivalent):
```json
{
  "mcpServers": {
    "session-convert": {
      "command": "node",
      "args": ["/absolute/path/to/session-convert/dist/index.js"]
    }
  }
}
```

## MCP Tools

### `list_sessions`
List available sessions from a harness. Filter by working directory prefix.

```
list_sessions({ harness: "claude", cwdPrefix: "~/apps" })
list_sessions({ harness: "codex" })
list_sessions({ harness: "opencode", searchPaths: ["~/projects"] })
```

### `convert_session`
Convert a session from one harness to another by session ID.

```
convert_session({ from: "claude", to: "opencode", sessionId: "abc-123" })
convert_session({ from: "codex", to: "claude", sessionId: "xyz-789" })
convert_session({ from: "opencode", to: "codex", sessionId: "oc-session-1", projectPath: "/path/to/project" })
```

### `preview_conversion`
Dry-run a conversion — shows message breakdown, tool call stats, and compatibility warnings without writing anything.

```
preview_conversion({ from: "claude", to: "opencode", sessionId: "abc-123" })
```

### `convert_by_path`
Convert a session file by its direct path. Auto-detects the format (Claude JSONL, Codex rollout JSONL, or OpenCode `.db`).

```
convert_by_path({ sourcePath: "/home/user/.claude/projects/.../sessions/abc.jsonl", to: "codex" })
convert_by_path({ sourcePath: "/home/user/myproject/.opencode/opencode.db", to: "claude" })
```

## Conversion Matrix

| From \ To | Claude Code | Codex CLI | OpenCode |
|-----------|:-----------:|:---------:|:--------:|
| **Claude Code** | — | ✅ | ✅ |
| **Codex CLI** | ✅ | — | ✅ |
| **OpenCode** | ✅ | ✅ | — |

## What Gets Preserved

| Content type | Claude → Codex | Claude → OpenCode | Codex → Claude | Codex → OpenCode | OpenCode → Claude | OpenCode → Codex |
|---|---|---|---|---|---|---|
| Text messages | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tool calls (name + args) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tool results | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Thinking / reasoning | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Images | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Session metadata (CWD, timestamps) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Model name | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Token usage | Approx | Approx | ✅ | Approx | Approx | Approx |

## How It Works

```
Source format  →  Unified Conversation  →  Target format
(JSONL/SQLite)     (typed Messages)         (JSONL/SQLite)
```

1. **Read** — Parse the source session (Claude JSONL, Codex rollout JSONL, or OpenCode SQLite) into a unified `Conversation` object with typed `Message` parts (`text`, `tool_call`, `tool_result`, `thinking`, `image`)
2. **Transform** — Map content types between format-specific representations (e.g., Claude's `tool_use` ↔ Codex's `function_call` ↔ OpenCode's double-wrapped `tool_call` part)
3. **Write** — Serialize to the target harness's native format and store it in the correct location

### Format-Specific Details

- **Claude Code** stores sessions as one JSON object per line in `.jsonl` files. Tool calls are `tool_use` blocks, results are `tool_result` blocks in the next user message. Thinking blocks are stored as `thinking` content type.
- **Codex CLI** uses a `session_meta` header line followed by `response_item` entries. Tool calls are separate `function_call` items with matching `function_call_output` items. Reasoning is a separate `reasoning` item type.
- **OpenCode** uses SQLite with a `sessions` table and a `messages` table. Parts are stored as JSON in a double-wrapped format: `[{ "type": "text", "data": { "text": "..." } }]`. This is the trickiest format and the main reason this tool exists.

## Testing

```bash
# Create the OpenCode SQLite test fixture
npm run test:fixtures

# Run all 34 tests (covers all 6 conversion directions + edge cases)
npm test

# Watch mode
npm run test:watch
```

Tests use 3 hand-crafted mini-sessions (one per harness) that include text, thinking, tool_call, and tool_result content parts. Each test reads from a fixture, writes to a target format, then reads back to verify roundtrip integrity.

## Known Limitations

- **Encrypted Codex reasoning** (`encrypted_content`) cannot be decrypted — only summary text is preserved
- **Claude sub-agent sessions** (Task tool spawning child sessions) are not followed — only the parent conversation converts
- **Token usage** is approximate when cross-converting (different tokenizers per provider)
- **OpenCode** must be restarted to discover newly imported sessions
- **System messages** are dropped for Claude (not stored in JSONL) or converted to user messages for Codex

## Comparison with Alternatives

| Feature | session-convert | agent-convert | ctxmv |
|---|:---:|:---:|:---:|
| Claude Code read/write | ✅ | ✅ | ✅ |
| Codex CLI read/write | ✅ | ✅ | ✅ |
| **OpenCode read/write** | **✅** | ❌ | ❌ |
| MCP interface | ✅ | ❌ | ❌ |
| SQLite support | ✅ | ❌ | ❌ |
| Session preview | ✅ | ❌ | ❌ |
| Path-based conversion | ✅ | ✅ | ❌ |

## Keywords

`mcp server`, `claude code session export`, `codex cli session migration`, `opencode session convert`, `ai coding agent session transfer`, `claude to codex`, `claude to opencode`, `codex to claude`, `opencode to claude`, `session migration tool`, `coding agent context switch`, `mcp tool`, `model context protocol`, `session converter`, `ai agent session backup`, `claude jsonl`, `codex rollout jsonl`, `opencode sqlite`, `coding session portability`

## License

MIT