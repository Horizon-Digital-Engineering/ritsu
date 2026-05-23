# Agent types + unified tool/plugin management

**Status:** future direction, not yet implemented. Captured 2026-05-17.

## The split

Today every ritsu agent is implicitly a Claude Agent SDK consumer (the `claude-direct` dispatcher). That gives us $0 marginal cost (Max plan) and built-in tools (Read/Write/Bash/etc.), but it constrains custom-tool registration to MCP shape — `createSdkMcpServer` is the only registration ABI the SDK exposes.

Going forward we treat **agent type** as a real discriminator with two flavors:

| Agent type | Runtime | Custom tools | Cost | Plugins |
|---|---|---|---|---|
| `claude-sdk` (today's behaviour) | Claude Agent SDK via `query()` | MCP-only (in-process via `createSdkMcpServer`) | $0 (Max plan via `~/.claude/.credentials.json`) | Limited to MCP servers |
| `ritsu-agent` (new) | Our own loop directly against the Anthropic Messages API (and eventually other providers) | Plain JSON schemas (provider-native tool format) | Pay per token via API key | First-class ritsu plugins with native handlers |

The shape mirrors openclaw's architecture (which doesn't use the Claude Agent SDK at all — its `extensions/` are pure plugin handlers wired into a homegrown agent loop).

### Why dual-track instead of switching wholesale

- Cost: Max plan via the SDK is free for the boxes already running Claude Code. Throwing that away for every agent would burn real money on tasks that don't need plugin tools.
- Loop / built-in tools: the SDK gives us Read/Write/Bash/Glob/Grep/WebFetch/WebSearch + multi-turn tool dispatch + planning + todo tracking for nothing. Replacing all of that is openclaw-scale work.
- Plugin ergonomics: ritsu-native plugins (plain function handlers, JSON schemas) are nicer to author than spinning up an MCP server. Some agents will want that ergonomics; the SDK can't deliver it.

Each agent picks the runtime that fits its needs.

## Plugin / tool model (ritsu-agent only)

Plugins live in a registry — name, version, exported tools, capabilities. An agent's definition references which plugins are mounted; tools from those plugins are then visible in the agent's tool list at query time.

```
plugin: filesystem-ops
  tools: read_file, write_file, search_files
  capabilities: requires-workspace

plugin: example-domain-lookup
  tools: lookup_domain_reputation, suggest_keyword
  capabilities: network
```

Plugins are **only** available to ritsu-agents. claude-sdk agents continue to use the SDK's built-in tools + MCP servers. The reason for the wall: SDK agents can't see arbitrary in-process function handlers — they'd need everything re-wrapped as MCP, which defeats the ergonomics gain of being a plugin in the first place.

## Unified tool/plugin management UI

The current admin layout has two scattered places for tool config:
- Agents tab → `tools_allowlist` checkboxes (SDK built-ins only)
- Workspaces tab → filesystem perms (governs what those tools can touch)

That doesn't scale once plugins exist. Replace with a dedicated **Tools** tab that's dual-aware:

```
TOOLS

filter: [all agents ▼]  [type: any ▼]  [search…]

┌──────────────────────────────────────────────────────────────────┐
│ agent-one  (claude-sdk)                               │
│  ├─ built-in     Read, Write, Edit, Bash, Glob, Grep, WebFetch   │
│  ├─ mcp__memory  remember, update_memory, forget, list_memories  │
│  └─ + add MCP server                                             │
├──────────────────────────────────────────────────────────────────┤
│ agent-two  (ritsu-agent)                                         │
│  ├─ plugin: filesystem-ops    read_file, write_file              │
│  ├─ plugin: domain-rep        lookup_domain_reputation           │
│  ├─ plugin: memory            remember, list_memories            │
│  └─ + mount plugin                                               │
└──────────────────────────────────────────────────────────────────┘
```

Reading both rows in one place makes the "agent X has these capabilities" question one-screen-answerable regardless of agent type.

Edit affordance per agent:
- Claude-SDK: toggle built-in tools, add/remove MCP server connections
- Ritsu-agent: toggle plugins (each plugin contributes its full tool set in one click; per-tool toggles inside the plugin are V2)

## Near-term cleanup (independent of ritsu-agent landing)

Even without ritsu-agents existing yet, the current tools UX is muddled:

1. The Agents edit form mixes prompt + dispatcher + tools allowlist in one tall form. The tool checkboxes belong in their own scoped UI.
2. The new MCP memory tools (`mcp__memory__*`) are invisible in the admin UI — operators have no idea they exist or which agents have them.
3. Workspaces are separate from tools but tightly coupled (Write means nothing without a writable workspace).

A "Tools" tab that surfaces (a) which built-in SDK tools the agent has, (b) which MCP tools are mounted, (c) which workspaces back them, all in one view — is worth building even before ritsu-agents are real. Then when ritsu-agents land, that tab adds a plugin row per agent without restructuring.

## Open questions to resolve when this work starts

- Authoring plugins: TypeScript module in `src/plugins/<name>/index.ts` that exports a manifest + tool handlers? Or sibling repo like openclaw's `extensions/`?
- Plugin permissions: do plugins declare required capabilities (filesystem, network, secrets) that the operator approves at mount time? Probably yes — same OAuth-consent pattern we built for the MCP server.
- Cross-type tools: should some tools (e.g. memory) be available to both agent types? Currently MCP memory exists for claude-sdk agents; for ritsu-agents the same store could be exposed as a plugin. Same data, different surface. Decide: one canonical tool spec compiled to both surfaces, or two implementations.
- Dispatcher routing: keep `claude-direct` / `litellm` dispatcher field, OR collapse it into agent type? Probably a `type` field with subtypes — `claude-sdk` (always uses Claude Agent SDK), `ritsu-agent-anthropic`, `ritsu-agent-openai`, etc.
- Cost guardrails: ritsu-agents burn API tokens. Per-agent monthly cap? Per-call usage metric in the admin UI?

## Inspiration / cross-reference

- openclaw's architecture: https://github.com/openclaw/openclaw — esp. `packages/plugin-sdk`, `extensions/active-memory`, the way `extensions/anthropic` registers as a provider plugin
- Anthropic Memory tool — server-side, opaque persistence; useful as a comparison point for what we DON'T want (we want operator-inspectable memory)
