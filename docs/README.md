# ritsu docs

Design notes, architecture references, and future-work plans for the ritsu
multi-agent MCP server. The repo's `README.md` is the entry point; this
folder collects everything that's bigger than a code comment but doesn't
belong in `src/`.

## Future work plans

Forward-looking design memos for things we know we want but haven't built yet.
Each one is meant to outlast the session it was conceived in — read before
starting related work so you don't re-derive context.

- [agent-types-and-tools.md](./agent-types-and-tools.md) — splitting the
  agent runtime into `claude-sdk` (current, free-via-Max-plan, MCP-only
  custom tools) vs a future `ritsu-agent` type (own loop, plain plugin
  tools, pay-per-token) — plus a unified Tools tab that serves both.
