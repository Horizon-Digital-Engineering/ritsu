# ritsu

### Agents as Infrastructure.

> **Stop maintaining a folder of `agent.md` files.** ritsu is a self-hosted multi-agent server with a real admin UI. Click "new agent," type a prompt, hit save — it's live. Edit, reload, delete, all from the browser. No commits, no redeploys, no .md sprawl. Agents become durable infrastructure: they have configs, audits, observability — like any other service on your box.

[![CI](https://github.com/Horizon-Digital-Engineering/ritsu/actions/workflows/ci.yml/badge.svg)](https://github.com/Horizon-Digital-Engineering/ritsu/actions/workflows/ci.yml)
[![Security](https://github.com/Horizon-Digital-Engineering/ritsu/actions/workflows/security.yml/badge.svg)](https://github.com/Horizon-Digital-Engineering/ritsu/actions/workflows/security.yml)
[![SonarCloud](https://sonarcloud.io/api/project_badges/measure?project=Horizon-Digital-Engineering_ritsu&metric=alert_status)](https://sonarcloud.io/dashboard?id=Horizon-Digital-Engineering_ritsu)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Name: 律 (*ritsu*), from 自律 (*jiritsu*, "autonomous / self-governing").

---

## Why ritsu

Every AI-agent project hands you a folder of markdown files. `agents/researcher.md`, `agents/coder.md`, `agents/pm.md`. Add an agent = new file. Edit a prompt = git commit + push + redeploy. Iterate on a system prompt = open the file in your editor, save, restart, repeat. It sucks.

ritsu kills that loop:

- **Agents live in a form, not a file.** New agent? Click "Create." Edit a prompt? Type into the textarea. Hit save → the runtime hot-reloads it. No commits, no redeploys.
- **See what your agents are actually doing.** Browse every conversation, every memory, every tool call. Live log tail. No opaque "memory" black box you can't open.
- **Talk to your agents from anything that speaks MCP.** Claude Code, Claude Desktop, Cursor, raw curl — all hit the same `/mcp` endpoint. OAuth 2.1 for spec-compliant clients (claude.ai web), `rt_*` bearer tokens for header clients.
- **Two runtimes.** Run on your Claude Max plan via `@anthropic-ai/claude-agent-sdk` ($0 per turn). Or point an agent at OpenAI / OpenRouter / a local LiteLLM. Same tools, same memory, same UI.
- **Real isolation.** Per-agent tool allowlists + per-path workspace permissions enforced *before* tools touch the disk. An agent with no Bash and no writable workspace can't exfiltrate files even if perfectly socially-engineered.
- **Secrets at rest are encrypted.** Bot tokens, API keys — AES-256-GCM with a separate master key. Audit log + bearer-token hygiene + strict CSP by default. (Full posture: [`docs/threat-model.md`](./docs/threat-model.md).)

---

## Quickstart

```bash
npm install
claude login                # one-time, reads ~/.claude/.credentials.json
cp .env.example .env
npm run dev                 # MCP on :7333, admin on :7334
```

Open <http://127.0.0.1:7334/admin> and mint a token in the **Tokens** tab.

```bash
# health
curl -s http://localhost:7333/healthz

# call an agent
curl -s -X POST http://localhost:7333/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer rt_YOUR_TOKEN' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ask_agent","arguments":{"agent_id":"hello-world","message":"hi"}}}'
```

For the full walkthrough (create a real agent, wire Claude Code to it,
inspect the conversation from the admin UI), see
[`docs/getting-started.md`](./docs/getting-started.md). For drop-in
agent definitions you can paste in, see [`docs/examples/`](./docs/examples).

### Docker

```bash
docker compose up --build              # ritsu only
docker compose --profile litellm up    # adds LiteLLM sidecar on :4000
```

Bind-mounts the host's `~/.claude/` so the Max-plan dispatcher works without an API key. State persists in the `ritsu-data` named volume. Both ports bound to `127.0.0.1` by default.

---

## What's inside

| Surface | What it does |
|---|---|
| `GET /mcp` (port 7333) | Real `@modelcontextprotocol/sdk` Streamable HTTP transport. Bearer-token-gated (`rt_*`). |
| `POST /oauth/{register,authorize,token}` | RFC 7591/8414/9728/8707 OAuth 2.1 + DCR + PKCE for spec-compliant clients (claude.ai web, Claude Desktop Connectors). |
| `/admin` (port 7334) | Tabbed UI: Dashboard, Agents, Workspaces, Memories, Conversations, Tools, MCP, Channels, Tokens, API Keys, OAuth Clients, Logs, Audit. |
| `GET /healthz`, `/readyz`, `/version` | Liveness / readiness. |
| `GET /metrics` | Prometheus exposition. |
| `ritsu` CLI | Operator commands: `service`, `env`, `path`, `token`, `admin-token`, `url`, `doctor`. Full reference: [`docs/cli.md`](./docs/cli.md). |

### MCP tools (current)

`list_agents`, `ask_agent`, `read_agent_memory`, `create_agent`, `update_agent`, `reload_agent`

Each agent additionally has these in-process per-agent MCP tools:
- `mcp__memory__{remember,update_memory,forget,list_memories}` — agent-scoped CRUD
- `mcp__agent_comms__{ask_agent,list_agents}` — gated by `can_call` allowlist, depth-3 loop guard
- `mcp__agent_admin__*` — only if the agent has the `manage_agents` capability
- `mcp__agent_monitor__*` — only if the agent has the `monitor_agents` capability

### Comm channels

Telegram is the only kind today. One bot ↔ one operator agent ↔ one bound chat (no group spam). Bot tokens are AES-256-GCM encrypted at rest. Discord / Slack land later; the kind enum is the extension point.

---

## Layout

```
src/
  index.ts                          two ports, schema bootstrap, admin token bootstrap
  db.ts                             openDatabase + additive migrations
  mcp-server.ts                     MCP HTTP surface (SDK transport, OAuth, bearer auth)
  agent-host.ts                     live agent map; addOrReplace/remove
  agent-definition-store.ts         CRUD over agent_definitions
  workspace-store.ts                per-agent filesystem roots + permissions
  memory-store.ts, conversation-store.ts
  channels/                         channel registry + telegram impl
  auth/                             token-store, api-key-store, oauth-store, oauth-routes
  admin/                            express CRUD + UI (ui.html / app.js / app.css)
  agents/                           AgentBase, GenericAgent, type registry
  model/                            dispatcher interface, claude-direct, litellm, ritsu-agent
  tools/
    mcp-internal/                   per-agent in-process MCP servers (memory + comms + admin + monitor)
    ritsu-agent/                    native FS/process/network tools for the ritsu-agent runtime
    permissions.ts                  shared tool→permission map + checkToolUse
  cli/                              `ritsu` operator CLI
  util/                             logger (with redaction), dotenv-lite, secret-crypto (AES-256-GCM)
systemd/                            ritsu.service + litellm-proxy.service
scripts/                            install.sh / configure.sh / update.sh / bootstrap-remote.sh
```

---

## Tests

```bash
npm test                # node:test, in-memory SQLite, fake dispatcher (152 tests)
npm run typecheck
npm run lint            # ESLint v9 flat config, type-aware
npm run build
npm run test:coverage   # c8 → coverage/lcov.info (consumed by SonarCloud)
```

---

## Deploying

See [`DEPLOY.md`](./DEPLOY.md). Two paths:
- `scripts/bootstrap-remote.sh` — drive an install over SSH from your laptop. Recommended.
- `scripts/install.sh` — run on the target host directly.

Targets a Linux + systemd box. Footprint ~200 MB working set. Tailscale-anchored is the documented happy path; the tailnet ACL is the outer auth boundary.

---

## Security

See [`SECURITY.md`](./SECURITY.md) (reporting + posture summary) and [`docs/threat-model.md`](./docs/threat-model.md) (deep-dive on the adversary model) for the full posture. One-line summary of what's baked in:

- No public exposure by default (`127.0.0.1` binds; tailnet ACL is the outer auth boundary).
- Scoped bearer tokens (`rt_*` MCP, `rat_*` admin) — sha256 at rest, optional `expires_at`, audit-logged.
- OAuth 2.1 + DCR + PKCE + RFC 8707 audience binding for spec-compliant clients.
- AES-256-GCM secrets at rest with master key separation (`RITSU_MASTER_KEY` env or `/etc/ritsu/master-key`).
- Per-agent isolation enforced by the SDK's `canUseTool` BEFORE tools fire.
- Strict CSP (`script-src 'self'; style-src 'self'`), `X-Frame-Options: DENY`, body-size + per-IP rate limits.
- Full audit trail: per-tool MCP calls in `mcp_token_usage`, per-admin-action mutations in `admin_audit` with body sha256.

Reporting: see [`SECURITY.md#reporting`](./SECURITY.md#reporting).

---

## License

[Apache 2.0](./LICENSE).
