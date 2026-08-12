# Using session-convert

session-convert runs as a local MCP server over stdio. Configure the built `dist/index.js` entry point in an MCP client, then use the tools below.

## Tools

- `list_sessions` finds sessions for `claude`, `codex`, or `opencode`.
- `preview_conversion` reports what will be written without changing files.
- `convert_session` converts a session by harness and session ID.
- `convert_by_path` converts a known `.jsonl` or `.db` path with format detection.

Example arguments:

```text
list_sessions({ harness: "claude", cwdPrefix: "~/projects" })
preview_conversion({ from: "claude", to: "opencode", sessionId: "..." })
convert_session({ from: "codex", to: "claude", sessionId: "..." })
```

The server does not upload sessions or provide a remote account. Back up important files before conversion and preview first when the source contains irreplaceable work.

See [the conversion reference](CONVERSION.md) for format details and [testing](TESTING.md) for reproducible checks.
