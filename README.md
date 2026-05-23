# ritsu

Multi-agent MCP server. Define agents as DB rows — name, system prompt, dispatcher, model, memory backend, filesystem workspace, tool allowlist — and talk to them from any MCP client. Real `@modelcontextprotocol/sdk` on the MCP port; admin UI on a separate port with bearer-token auth, live log tail, and Prometheus-format metrics.

Name: 律 (ritsu), from 自律 (jiritsu, "autonomous / self-governing").

## Quickstart

```bash
npm install
claude login                # one-time, reads ~/.claude/.credentials.json
cp .env.example .env
npm run dev                 # MCP on :7333, admin on :7334
```

Open <http://127.0.0.1:7334/admin>.

```bash
# health
curl -s http://localhost:7333/healthz
curl -s http://localhost:7334/metrics | head

# call an agent
curl -s -X POST http://localhost:7333/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ask_agent","arguments":{"agent_id":"hello-world","message":"hi"}}}'
```

## Docker

```bash
docker compose up --build              # ritsu only
docker compose --profile litellm up    # adds LiteLLM sidecar on :4000
```

The container bind-mounts your host's `~/.claude/` so the Max-plan dispatcher works without an API key. SQLite persists in the `ritsu-data` named volume. Both ports bound to `127.0.0.1` only by default.

## Auth

Default `MCP_REQUIRE_AUTH=auto` — open until you mint a token in the admin Tokens tab, then auto-locked. Set `MCP_REQUIRE_AUTH=on` in prod.

## Tests

```bash
npm test                # node:test, in-memory SQLite, fake dispatcher
npm run typecheck
npm run build
npm run test:coverage   # c8 lcov + text report
```

## Layout

```
src/
  index.ts                       boot, two ports
  db.ts                          openDatabase + schema + additive migrations
  memory-store.ts                MemoryStore: sqlite + flashback stub
  conversation-store.ts          ConversationStore: sqlite
  agent-definition-store.ts      AgentDefinitionStore: sqlite + seedIfEmpty
  workspace-store.ts             WorkspaceStore: per-agent filesystem roots
  agent-host.ts                  live agent map; addOrReplace/remove
  mcp-server.ts                  real MCP via SDK; bearer auth; 6 tools
  metrics.ts                     Prometheus exposition
  event-bus.ts                   in-memory log ring + emitter
  admin/
    server.ts                    Express CRUD + SSE + proxy + tokens
    ui.html                      tabbed single-page UI
    schema.ts                    zod for AgentDefinition
  agents/
    base.ts                      AgentBase: hooks + onMessage
    generic.ts                   pure-JSON agent
    registry.ts                  string → AgentCtor (extension point)
  auth/
    token-store.ts               mint/verify/revoke/recordUsage
    api-key-store.ts             encrypted-at-rest provider keys
    oauth-store.ts               OAuth 2.1 + DCR + PKCE
    oauth-routes.ts              /.well-known + /oauth/* endpoints
  model/
    dispatcher.ts                ModelDispatcher interface
    claude-direct-dispatcher.ts  Max-plan CLI via SDK; cwd + tools + canUseTool
    litellm-dispatcher.ts        HTTP to LiteLLM proxy
    factory.ts                   buildDispatcher(kind, model, opts)
  util/log.ts                    redacting JSON-line logger
```

## Standard endpoints

| Endpoint | Where | Notes |
|---|---|---|
| `/healthz`, `/readyz`, `/version` | MCP | liveness + readiness |
| `/metrics` | admin | Prometheus exposition |
| `/admin` | admin | tabbed UI |
| `/mcp` | MCP | JSON-RPC + SSE (Streamable HTTP transport) |

## Security

ritsu is built to be self-hosted on a tailnet and to defend against credible threats out of the box. Full details in [`SECURITY.md`](./SECURITY.md) and [`THREAT_MODEL.md`](./THREAT_MODEL.md). One-line summary of what's baked in:

- **No public exposure by default.** Binds to `127.0.0.1`; the tailnet ACL is the outer auth boundary.
- **Scoped bearer tokens** (`rt_*` MCP, `rat_*` admin) — sha256-hashed at rest, optional `expires_at`, audit-logged per use.
- **OAuth 2.1 + DCR + PKCE** (RFC 7591 / 9728 / 8414 / 8707) for clients that don't fit the static-bearer model.
- **Secrets encryption at rest** — bot tokens (and future API keys) are AES-256-GCM encrypted; master key prefers `RITSU_MASTER_KEY` or `/etc/ritsu/master-key`.
- **Per-agent isolation** — `tools_allowlist` + per-path workspace permissions enforced via the Claude SDK's `canUseTool` BEFORE any tool touches the FS.
- **Inter-agent allowlist** (`can_call`) with bidirectional sync + depth-3 loop guard.
- **Systemd sandbox** — `ProtectHome=read-only`, `ProtectSystem=strict`, scoped `ReadWritePaths`, `NoNewPrivileges`.
- **Operator-inspectable memory** — plain SQLite rows, full admin CRUD. No opaque vendor "memory tool" with hidden state.
- **Full audit trail** — per-tool MCP calls in `mcp_token_usage`; per-admin-action mutations in `admin_audit` with body sha256 for tamper-evidence.
- **Hardened admin UI** — strict CSP, `X-Frame-Options: DENY`, body-size + per-IP rate limits.
