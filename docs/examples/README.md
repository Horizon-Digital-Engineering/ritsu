# Example agent definitions

JSON snippets you can paste into ritsu's admin UI (Agents → Create) or
POST to `/admin/agents` directly. Each one shows a different
shape — none of these are required; they're shipped as starting points.

The seeded `hello-world` agent that ritsu creates on first boot is
intentionally minimal. These examples show what a real, useful agent
looks like.

## Pasting via the UI

Each example below maps to the **Agents → Create / edit** form:

| Example JSON field | Form field |
|---|---|
| `id` | id |
| `type` | type (always `generic` unless you've registered a subclass) |
| `name` | name |
| `description` | description |
| `system_prompt` | system prompt (textarea) |
| `dispatcher` | dispatcher |
| `model` | model |
| `tools_allowlist` | tools allowlist (checkboxes) |
| `can_call` | can call (checkboxes — only enabled agents appear) |

`provider` / `api_key_ref` / `provider_options` are for the ritsu-agent
runtime (your-own-API-key path); leave them at `null` / `{}` for the
default Max-plan claude-sdk dispatcher.

## Pasting via curl

```bash
TOKEN=$(sudo cat /opt/ritsu/data/.admin-token)   # or use a rat_* admin token
curl -s -X POST http://127.0.0.1:7334/admin/agents \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d @notetaker.json
```

The admin endpoint zod-validates the body and rebuilds the live agent
immediately — no restart needed.

## The examples

- [`notetaker.json`](./notetaker.json) — bullet-point summariser. No
  filesystem tools, no inter-agent calls. The simplest useful agent.

- [`code-reader.json`](./code-reader.json) — read-only code explorer with
  `Read` + `Glob` + `Grep` against a project workspace. Pairs with a
  workspace at, say, `~/code/some-project` granted `read` permission.

- [`research-assistant.json`](./research-assistant.json) — research agent
  with `WebFetch` + `WebSearch` (uses your `RITSU_SEARXNG_URL`) plus
  memory for accumulating findings across sessions.

After importing any of these you still need to:

1. Add a **workspace** if the agent uses `Read` / `Write` / `Bash` /
   `Glob` / `Grep` — the Workspaces tab. Without one those tools will be
   denied at call time.
2. Mint an **MCP token** if you want to reach the agent from outside the
   admin UI (Claude Code, Claude Desktop, curl).
