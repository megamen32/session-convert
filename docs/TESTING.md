# Verification

The offline release check builds the TypeScript and runs the conversion tests, including all six directions and the OpenCode fixture:

```bash
npm run test:release
```

The optional live check talks to a running OpenCode backend and requires an explicitly supplied `OPENCODE_SMOKE_PASSWORD`; it is separate from the offline check and is not needed to build the MCP server.
