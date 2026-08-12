# Conversion reference

## Matrix

| Source | Claude Code | Codex CLI | OpenCode |
|---|:---:|:---:|:---:|
| Claude Code | — | yes | yes |
| Codex CLI | yes | — | yes |
| OpenCode | yes | yes | — |

The readers consume Claude JSONL, Codex rollout JSONL, and current or legacy OpenCode SQLite databases. Writers create the corresponding native target representation.

Text, tool calls and results, thinking/reasoning when represented by the source, images, session metadata, and model names are mapped by the unified conversation model. Token usage is approximate across providers. Encrypted Codex reasoning cannot be decrypted, Claude child sessions are not followed, and OpenCode may need a restart before an imported session appears.
