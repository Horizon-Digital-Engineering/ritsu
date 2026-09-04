# Getting started

Zero to a working agent in five minutes, on your laptop. After this you'll
have ritsu running, an MCP token minted, a custom agent created, and a
real conversation with it from Claude Code (or curl).

For a real lab deployment (systemd, persistent install, Tailscale Serve
fronting, the `ritsu` operator CLI), see [`DEPLOY.md`](../DEPLOY.md). This
guide is the dev / evaluation flow.

## 1. Boot the server

```bash
git clone https://github.com/Horizon-Digital-Engineering/ritsu.git
cd ritsu
npm install
claude setup-token   # generate a subscription token; save it in the admin UI
cp .env.example .env # sets RITSU_ADMIN_TOKEN_FILE=./data/.admin-token for dev
mkdir -p data        # bootstrap path; the server refuses to start if it's missing
npm run dev          # MCP on :7333, admin on :7334
```

`claude setup-token` prints a long-lived token tied to your subscription
(valid about a year). It is account-scoped, not machine-scoped, so generate it
anywhere and paste it into the admin UI under **API Keys → subscription
session** — it is stored encrypted, and every host does not need its own login.
Agents on the direct runtime cannot dispatch until one is saved.

To pay per token instead, mint a provider key on the same page and set an
agent's runtime to `api`. The two are separate paths: a subscription token
authenticates the vendor CLI, and the metered API rejects it.

At this point you'll see something like:

```
{"level":"info","msg":"mcp.listening","host":"127.0.0.1","port":7333,"auth_mode":"auto"}
{"level":"info","msg":"admin.listening","host":"127.0.0.1","port":7334,"url":"http://127.0.0.1:7334/admin"}
```

## 2. Open the admin UI

```
http://127.0.0.1:7334/admin
```

First load prompts for an admin token. Get it with:

```bash
cat data/.admin-token
```

(That file is auto-generated on first boot — mode 0600, contents are an
`rat_*` bearer token. Paste it into the modal. The browser remembers it via
`localStorage`. The path comes from `RITSU_ADMIN_TOKEN_FILE`; if the write
fails the server revokes the token and exits non-zero, so an unreachable
bootstrap token can never get stranded in the DB.)

You should see the **Dashboard** tab with one tile: `hello-world`. That's
the smoke-test agent the server seeds on first run.

## 3. Talk to the seeded agent (sanity check)

Click the `hello-world` tile. The slide-in chat panel opens. Type
"hi" and hit Send. You should get a reply within a few seconds. If you
don't, check the **Logs** tab for the actual error — usually it's either:

- No subscription token saved (API Keys → subscription session), or
- No master key on the host, so nothing can be stored at all — the admin UI
  shows a banner and **System → Health** names it, or
- Network blocked by a corporate firewall

## 4. Create your own agent

Go to **Agents** → fill out the form:

| Field | Value |
|---|---|
| id | `notetaker` |
| type | `generic` |
| name | `Notetaker` |
| description | `Summarises text into bullet points.` |
| runtime | `direct` |
| provider | `claude` |
| model | `claude-sonnet-4-6` |
| memory backend | `sqlite` |
| system_prompt | (see below) |

System prompt:

```
You are a notetaker. When given any block of text, your job is to:
1. Extract the 3-5 most important facts as bullet points.
2. Identify any open questions or action items.
3. Be brief — no preamble, no recap, just the bullets.

Use mcp__memory__remember to store durable preferences ("user wants
markdown bullets"). Use the existing memories as your default.
```

Hit **Create**. The tile appears in the Dashboard. Click it → ask:

> Read this paragraph and summarise: [paste any article excerpt]

You should get back a clean bullet list. The conversation is saved — open
**Conversations** to see the transcript.

## 5. Mint an MCP token

The admin UI is for managing ritsu. Real agent calls come through the MCP
port (`:7333`). To call your agent from outside, you need a token.

Go to **Tokens** → **Mint a token** → name it `claude-code-laptop` →
Mint. The plaintext (`rt_…`) is shown **once** — copy it now.

## 6. Talk to your agent from Claude Code

```bash
claude mcp add --transport http --scope user ritsu http://127.0.0.1:7333/mcp \
  --header "Authorization: Bearer rt_YOUR_TOKEN"
```

Restart Claude Code. The `notetaker` agent is now reachable as
`mcp__ritsu__ask_agent`:

```
> Summarise this paragraph: [paste text]

(Claude Code calls mcp__ritsu__ask_agent with agent_id=notetaker, message=...)
```

You'll see the call land in the **Conversations** tab on the admin UI, with
the caller labeled as your token name (`claude-code-laptop`).

## 7. Talk to your agent from curl (no client config)

```bash
TOKEN="rt_YOUR_TOKEN"
curl -s -X POST http://127.0.0.1:7333/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "ask_agent",
      "arguments": { "agent_id": "notetaker", "message": "hi" }
    }
  }'
```

The response is JSON-RPC; the `result.content[0].text` field is the
agent's reply.

## What to explore next

- **Workspaces** tab — grant the agent filesystem access. Once an agent
  has a workspace with `read` permission, you can enable the `Read` tool
  in its `tools_allowlist` and ask it to read files for you.
- **Memories** tab — see what the agent has remembered across
  conversations. You can hand-edit, delete, or seed memories from here.
- **MCP** tab — copy-paste-ready snippets for Claude Code / Claude
  Desktop / curl, populated with the running server's URL.
- **Tools** tab — read-only inventory of what each agent can actually
  invoke (built-in SDK tools + MCP servers + workspaces).

For the long-form deployment guide (systemd, Tailscale Serve fronting,
the `ritsu` CLI for ops), see [`DEPLOY.md`](../DEPLOY.md). For the
operator CLI subcommands, see [`cli.md`](./cli.md). For example agent
definitions you can import, see [`examples/`](./examples).
