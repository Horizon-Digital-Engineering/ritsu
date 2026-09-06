# Changelog

All notable changes to ritsu are recorded here. Format roughly follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); semantic
versioning per [semver](https://semver.org/).

## [Unreleased]

## [0.12.3] — 2026-09-06

### Changed

- Static-analysis sweep across the codebase, no behavior changes: the
  backtracking-prone regexes in the HTML-to-text, code-fence, and prompt-
  variable parsers are now linear scans; oversized functions were split into
  named helpers (agent wiring, model clients, scheduler, tool guards, admin
  UI); accessibility labels and color contrast fixed in the admin pages;
  assorted modern-JS preference findings resolved. Compile target moved to
  ES2023 (runtime already required Node 20+).

## [0.12.2] — 2026-09-05

### Fixed

- JSON import hardening, so older exports restore completely:
  - Exports from before the `format` stamp existed are accepted as the
    version-1 shape instead of being rejected.
  - Rows now insert under deferred foreign-key enforcement with an explicit
    `foreign_key_check` before commit — alphabetical table order (attachments
    before messages) and self-referential references no longer fail the
    import, and a genuinely dangling reference rolls the whole import back.
  - The memory backend's tables are created before copying, so memory
    records survive import into a fresh database instead of being dropped as
    "unknown".
  - Data for tables the target schema doesn't have (typically uninstalled
    plugins) is now a hard error listing the tables, instead of a silent
    drop; `--skip-unknown` opts into skipping them, reported loudly.

## [0.12.1] — 2026-09-05

### Fixed

- The installer no longer tries to install an `update-ritsu` shortcut. The
  step could abort the script partway through — after building but before
  restarting the service — leaving the new version on disk but not running.
  Re-running `scripts/install.sh` from a clone is the supported update path.

## [0.12.0] — 2026-09-05

### Added

- **Three-area navigation.** A fixed icon rail on every admin page switches
  between the three surfaces by intent: **Workspace** (talk to agents),
  **Operations** (watch the system), **Studio** (build and configure). The
  rail carries a live pending-approvals badge on the Operations icon.
- **Operations board** at `/admin/ops` — one live "watch" page absorbing the
  monitoring loop: pending approvals (approve / two-step reject, spoof
  unmasking, escalation banners), recent decisions, blocked inter-agent
  calls, scheduled jobs with next-run times, channel status, health checks,
  and a live log tail with a warnings-only filter. Approvals and the tail
  update over SSE; the rail health dot reflects the worst health check.

### Changed

- The classic admin panel is now **Studio**: its nav regrouped around
  building — Agents (with the tile overview as its first tab), Extensions,
  Platform (channels / jobs / MCP), Access (tokens / API keys / OAuth), and
  Server. The Dashboard and Approvals tabs are gone; tiles live under
  Agents › Overview and the approvals queue lives on the Operations board.
  Inline approval cards in chat surfaces are unchanged.

## [0.11.1] — 2026-09-05

### Fixed

- The installer now detects an existing checkout even though the install
  directory is unreadable to the invoking user, and syncs it the same way
  the updater does (fetch + hard reset) instead of pulling. A non-repo
  obstruction in the install directory is reported with instructions
  instead of surfacing as a git fatal.

## [0.11.0] — 2026-09-05

### Added

- **Agent workspaces — a chat-first main page.** The admin port's root now
  lands on a per-agent workspace: pick an agent and live in its chats, rather
  than opening a panel from an admin grid. The classic admin panel is
  unchanged at `/admin`.
  - **Default chat.** Every agent has one stable thread — the same one a
    bound channel (e.g. Telegram) already feeds — pinned at the top and
    badged with the channel. Phone and desk land in the same conversation.
  - **Projects.** Named groups an operator files chats and workspace files
    under, per agent. Organizational only: deleting a project unfiles its
    members, never deletes them, and filing is refused across agents.
  - **Files.** Browse, upload, download, and delete files in the agent's
    workspace directories from the UI, behind the same containment guards
    (canonicalization, symlink refusal, pseudo-filesystem deny) the agent's
    own filesystem tools run behind. Containment is enforced; the agent's
    per-root permission flags gate the agent, not the operator. Downloads
    are always served as opaque attachments.
  - New API: project CRUD, conversation filing, file browse/upload/delete,
    file→project tags (real, contained files only), explicit new-conversation
    creation, and default-chat resolution.
  - **Message tree.** Every message records its parent; editing a turn
    branches instead of overwriting, regenerate produces sibling answers
    navigated in place, and a turn's context follows its own path — the
    other branch never leaks in. Fork still copies into a fresh chat.
  - **Skills.** Shared markdown instruction sets bound per agent with a lazy
    manifest — one line each in context, the body loaded on demand via
    view_skill on either runtime.
  - **Project instructions.** A project can carry a system prompt every chat
    filed under it inherits — a sub-persona without minting a new agent.
  - **Prompt library**, own-history tools (search_chats/view_chat: fenced,
    own chats only, held for approval on injection-exposed agents),
    URL-as-context and chat-as-context (both fenced), unread markers,
    chat search/pin/archive/fork/export, markdown replies with code copy,
    and optional auto-titling via the configured task endpoint.
  - **Rendering.** Mermaid diagrams and KaTeX math, self-hosted (vendored
    with their MIT licenses — the admin CSP allows no CDNs).

Denial visibility + opt-in escalation approval, plus a runtime-hardening pass.
Blocked inter-agent calls used to be invisible to the operator — a real,
working security block looked like a misbehaving agent. Now every `ask_agent`
denial is recorded and surfaced live, and capability escalation can be routed
to an operator decision instead of a flat hard-deny.

### Added

- **Claude session token in the admin UI.** The `claude-direct` credential
  (`claude setup-token`) is stored in the SecretStore and managed on the API
  Keys page instead of a root-owned env file. Saving reloads every agent, so a
  rotated token applies without restarting the service; the value is never
  returned by the API, only a short hint. An environment-provided token still
  works and is reported as such.

- **Two-tier runtime model.** Agents declare `runtime` (`direct` = vendor
  runtime on a subscription, `claude` today; `api` = ritsu's own tool loop on
  a metered key) + `provider`. Existing databases migrate automatically.
- **api providers:** `anthropic` / `openai` / `gemini` via their official
  SDKs, `xai` (Grok), `openrouter`, `litellm` (key optional), `custom`
  base_url. Tool calls stay in ritsu's loop — the approval gate applies
  unchanged. Sampling params are sent only when set in `provider_options`.
- **Health tab (System).** Live checks: core runtime, one free probe per
  stored provider key, and every configured connector.
- **Memory tab (System).** First-class config for the memory system:
  flashback url/token/mode (sqlite / dual / flashback), running-vs-next-boot
  state, and a reachability probe. Memory is core infrastructure, not a
  connector.
- **Blocked sub-tab (Approvals → Blocked).** Lists recent inter-agent call
  denials — caller → target, reason, detail, attempted message, age — live
  over the approvals SSE stream. Escalation denials are visually flagged as
  the security-relevant ones.
- **Denied inter-agent calls are persisted.** Every `ask_agent` block
  (allowlist / capability escalation / cycle / call-depth / in-flight) is
  recorded in a new `comms_denials` table and pushed on the approval bus as a
  `comms-denied` event. Recorded at every guard site in both runtimes (the
  MCP agent-comms path and the native ritsu-agent loop). Recording is
  best-effort — it sits on the security deny path and never throws.
  `GET /admin/api/comms-denials` lists recent denials.
- **Opt-in capability-escalation approval.** A new per-agent
  `escalation_approvable` flag (default off — hard-deny stays the safe
  baseline). When set, a capability-escalation `ask_agent` call is routed to
  the operator approval screen instead of being hard-denied; approve → the
  call proceeds, reject → denied with the operator's reason. Enforced in both
  runtimes. The approval card renders a distinct warning listing which
  capabilities approving would let the caller borrow.
- **Attempted-message capture.** Each denial records the message the caller
  was trying to send (truncated), rendered as a quoted line under the blocked
  row so the operator sees intent, not just the routing.

### Security

- **Injection-exposed agents can never escalate.** Agents that read untrusted
  content (the `crm` / `social` capabilities) always hard-deny capability
  escalation, ignoring `escalation_approvable` — a prompt-injected agent
  cannot escalate even if an operator clicks approve.
- `escalation_approvable` defaults off, so existing agents keep the strict
  hard-deny behavior until an operator explicitly opts a specific agent in.
- Operator-only agent fields (credentials, provider endpoint, capabilities,
  gating flags) are no longer settable from any agent- or MCP-initiated write.
- Fetched web pages are fenced as untrusted text, and web search runs through
  the same guarded fetch path as WebFetch.
- Every in-process tool group now honours `approval_tools`; previously some
  groups accepted the setting and ignored it. Where a runtime genuinely cannot
  enforce a gate, ritsu now says so — on save, in the agent form, and in the
  log — instead of reporting the tool as gated.
- Further hardening across the runtime, tool, auth, and plugin surfaces.

### Fixed

- **Restore is safe again.** The write-ahead log is cleared on restore and the
  result is integrity-checked before the command reports success.
- **Backups are verified and retention is honest.** A snapshot that fails its
  integrity check is discarded, `keep` is floored at 1, retention orders on
  sub-second mtime, and the boot snapshot is taken before migrations run.
  `backup list` / `prune` no longer open the database at all.
- **JSON export round-trips.** BLOB columns are base64-tagged instead of being
  rendered as an unusable digit map, the file carries a format stamp, and
  `ritsu backup import <export.json> <new.db>` rebuilds a database from one.
  It writes a new file and refuses to overwrite: an export omits credentials by
  design, so importing over a live database would leave it half-populated.
- Cross-conversation recall works: memory retrieval now excludes the live
  thread instead of scoping to it, on every backend.
- Scheduling reaches `direct`-runtime agents; it was silently dropped in the
  dispatcher option projection.
- CRM (`crm` / `social`) tools now exist on the `api` runtime, which is the
  runtime the docs point injection-exposed agents at.
- `Bash` no longer wedges a turn when a command backgrounds something.
- Plugin uninstall takes the plugin out of service instead of leaving its tools
  wired and reinstalling it on the next boot.
- `?limit=` is clamped at both ends; a negative value used to mean unlimited.
- Rate-limit buckets are swept, the MCP transport is closed on the error path,
  and messages persist with their attachments in one transaction.
- An agent's memory chain root survives a config edit that rebuilds the agent.
- One action raises one approval. Tools that always ask the operator themselves
  are no longer gated a second time by the runtime loop, which produced two
  identical cards for a single send.

## [0.10.0] — 2026-07-21

A plugin system, agents that can use plugins, and a security-hardening pass.

### Added

- **Plugin system** — a plugin runtime with a scoped per-plugin datastore, a
  manifest-driven admin UI, agent-facing tools, and a registry that tracks each
  plugin's version and owned tables. Plugins can be enabled/disabled (reversible,
  data kept) or uninstalled, managed from a Plugins tab.
- **Projects plugin** — a configurable multi-project manager, each project with a
  working directory, plus per-project and aggregated task backlogs.
- **Agents can use plugins** — a per-agent allowlist wires an allowed plugin's
  tools into the agent's turn; write tools stay behind the approval gate.
- **Unified tool gateway** — one mechanism assembles every agent tool group,
  built-in and plugin alike.

### Security

- Hardening across the plugin, agent-management, auth, and admin surfaces:
  tighter per-agent tool authorization, input validation and output handling on
  the plugin surface, rate limiting, and correct client attribution behind a
  reverse proxy.

### Fixed

- Column backfills for databases created before newer columns existed.

## [0.9.0] — 2026-06-05

Extensions + the CRM: agents read/draft freely, every send/publish is held
for operator approval, and credentials never touch the model. Built on the
v0.8.0 approval gate. Also adds image paste in the chat panel so vision
agents can see operator-pasted screenshots.

### Added

- **Plugin secret store** (`plugin_secrets` + `SecretStore`). Connector
  credentials encrypted at rest (AES-256-GCM, AAD-bound to namespace+name).
  `get()` is the only decrypt path and is reachable only from in-process
  tool handlers — no agent-callable accessor. The admin API returns metadata
  only, never values.
- **Approval enforcement on the ritsu-agent runtime** — gating moved to the
  layer we own. The claude-direct Max-session SDK runs its built-in tools
  itself and never consults `canUseTool` (proven by event-stream tracing),
  so gating lives in the MCP tool handlers (claude-direct) and the
  tool-dispatch loop (ritsu-agent). The ritsu-agent gate is unconditional —
  a plain `await`, no SDK/timeout to bypass it.
- **CRM email extension** (`crm` capability) — `read_inbox` / `read_email`
  (ungated) + `send_email` (always gated). IMAP+SMTP via
  imapflow/nodemailer/mailparser, any provider.
- **CRM social extension** (`social` capability) — X/Twitter
  (`read_mentions` / `read_my_posts` ungated, `post_tweet` gated; OAuth 1.0a
  via twitter-api-v2) and LinkedIn (`post_linkedin` gated, publish-only).
- **Extensions admin tab** — configure each connector's credentials; per-agent
  on/off via the capability checkboxes; the extension stays dormant until
  configured. Table-driven so new connectors are a few rows.
- **`update-ritsu --branch`** to deploy a PR branch to the box for testing.
- **Image paste in agent chats** — operators paste/drag/pick images in the
  chat panel and vision-capable agents see them (Anthropic image blocks on
  claude-direct via the SDK's streamed-message form; OpenAI `image_url` parts
  on ritsu-agent). Downscaled client-side to the model's resolution cap
  (2576px for Opus 4.7/4.8, else 1568px); persisted in a `message_attachments`
  sidecar for transcript re-render. `POST /ask` accepts the larger body and
  zod caps it (≤4 images, ≤5MB each).

### Security

- Adversarial review (3 red-team passes + 1 verifier) before merge. Closed:
  - **CRITICAL** — a `manage_agents` agent could grant itself/another the
    `crm`/`social` capability and read the inbox ungated. `crm`/`social` are
    now operator-only (`assertGrantableCapabilities` at all six agent-admin
    write surfaces) + a self-modification guard.
  - **HIGH** — SMTP/IMAP plaintext-auth fallback. `requireTLS` + TLSv1.2
    floor (SMTP) and `doSTARTTLS` (IMAP); both abort rather than send the
    password in the clear.
  - **MEDIUM** — `send_email` header-injection + unbounded input. CRLF
    rejected on header-bound fields; length bounds on subject/body.
  - `scrubSecrets()` on model-facing connector error messages.

## [0.8.0] — 2026-05-30

Human-in-the-loop approvals — the first core capability of the plugin
era. Plus a deploy-script change to test PR branches on the box.

### Added

- **Approval gate.** An agent definition can list tools in a new
  `approval_tools` field (e.g. `["Bash","Write"]`). When the agent tries
  to use a gated tool, its turn blocks on a pending approval until the
  operator approves (the call proceeds) or rejects (the call is denied
  and the operator's reason is fed back to the model). Honored by the
  claude-direct dispatcher's `canUseTool`, after the workspace-permission
  check. No timeout — agents have no deadline; staleness is surfaced in
  the UI instead.
- **Approvals admin tab** with a live pending-count badge (updates on
  every tab via a global SSE subscription). Pending / Decided sub-tabs.
  Pending cards: tool glyph, agent + age, expandable args, one-click
  Approve, two-step Reject with an optional reason. Staleness ladder
  tints the card border at 4h / 24h / 7d. Decided cards are ✓/✗ stamps.
- **Inline approval cards** in the slide-in chat panel — a gated call the
  open thread is waiting on appears right in the transcript; approve or
  reject without leaving the chat.
- **Agent form** gains a "require approval" multi-select writing
  `approval_tools`. The MCP `create_agent` tool accepts it too.
- New `tool_approvals` table; `approval-bus.ts` + `approval-store.ts`
  (request/decide with an in-memory resolver map, `reconcileOnBoot()` to
  close orphaned pendings from a prior process). Endpoints:
  `GET /admin/api/approvals`, `/approvals/count`, `/approvals/stream`
  (SSE), `POST /approvals/:id/decide`.
- 9-case `approval-store.test.ts` (request→resolve, reject-reason
  feedback, idempotent decide, ordering, per-conversation scope,
  reconcile-orphans, bus events). 312 tests green.

### Deploy

- **`update-ritsu --branch <name>`** mirrors the install to
  origin/&lt;branch&gt; (fetch + checkout -B + reset --hard) so a PR
  branch can be deployed + tested on the host without merging to main.
  `--force` discards local box edits; no flag = back to origin/main.

### Known gaps

- The ritsu-agent dispatcher does not honor `approval_tools` yet — only
  claude-direct (the deployed path). In-process MCP tools (memory, comms,
  admin, monitor) are intentionally never gated.

## [0.7.2] — 2026-05-30

Empty-reply fix when the agent's final action is a tool call.

### Fixed

- **Agents returning empty text after a `mcp__memory__update_memory`
  (or any tool) as their last turn.** The claude-direct dispatcher
  only watched the SDK's terminal `result` message and pulled
  `event.result`, which is `""` whenever the model ends on a
  tool_use block without a follow-up text turn. The telegram channel
  surfaced this as `telegram sendMessage: Bad Request: message text
  is empty`; the admin chat panel surfaced it as `(empty reply)`.

  Fix: cache the most recent non-empty text content from each
  `assistant` event as the stream flows by, and use it as the
  fallback when the result message has an empty `result` field.
  New helper `extractAssistantText(event)` walks `BetaMessage.content`
  blocks, joins every `{ type: 'text' }` block and drops the rest.

- **Test (`src/__tests__/claude-direct-dispatcher.test.ts`)** —
  5 cases covering the text-only happy path, mixed
  text+thinking+tool_use, tool-only (the regression), non-assistant
  events, and malformed shapes.

## [0.7.1] — 2026-05-26

Chat panel resume-from-background polish — primarily for iOS Safari.

### Fixed

- **"Load failed" on resume.** When iOS suspended a backgrounded tab
  with the chat panel open, in-flight `/ask` fetches died with
  `TypeError: Load failed` and the user's typed message vanished
  into the error bubble. Send-failure path now restores the
  optimistic user bubble out of the transcript, puts the message
  text back in the input, and renders a friendlier "connection
  dropped — tap Send to retry" instead of the raw browser error.
- **Stale transcript after backgrounding.** Added a
  `visibilitychange` handler that, on every transition back to
  `visible` with the panel open, force-reconnects the SSE stream
  (Safari sometimes leaves the socket in a delivers-nothing zombie
  state) and reloads the transcript so any messages that landed
  while the tab was asleep show up immediately. No more hard-refresh
  needed.

## [0.7.0] — 2026-05-26

Slide-in chat panel: live conversation sync across tabs/devices, animated
typing indicator, wider desktop layout. Plus a stealth-fix for the logs
Live tail (silently 401-ing since admin auth tightened).

### Added

- **Live conversation sync.** New `/admin/api/conversations/stream` SSE
  endpoint backed by `src/conversation-bus.ts` (singleton EventEmitter).
  `SqliteConversationStore.append()` publishes a `message` event on
  every turn so any tab with the slide-in chat panel open re-renders
  the transcript without a manual refresh. Covers cross-tab,
  cross-device, agent-to-agent, and channel-bot (telegram)
  message-source paths.
- **Animated typing indicator.** The pending assistant bubble now
  renders three CSS-animated bouncing dots. Driven by `ask-start` /
  `ask-end` events from the same bus, so the indicator follows the
  *caller* — open the panel on your desktop while your phone is
  asking the agent, you see the dots.
- **Test (`src/__tests__/conversation-bus.test.ts`)** covering
  message-event publish on append, ask-start/end round-trip, and
  null caller_label default.

### Changed

- **Desktop chat panel widened** from `min(440px, 100vw)` to
  `min(640px, 45vw)`. Tablet (≤900px) sits in the middle on the 45vw
  side of the clamp; mobile (≤540px) stays at 100vw.

### Fixed

- **Authenticated SSE streams.** Both the logs Live tail and the new
  conversation stream now consume `text/event-stream` via streaming
  `fetch()` + a small in-browser parser, with the admin token riding
  in the `X-Ritsu-Admin-Token` header. The previous `new EventSource`
  could not attach the header and was 401-ing silently (the page
  showed only the static backfill from `/events/recent`). New helper
  `sseFetch(path, onEvent, signal)` in `admin/app.js`; AbortController
  for clean teardown + transparent 2s-delay auto-reconnect.

## [0.6.2] — 2026-05-23

Patch release for an admin-UI regression that 0.6.1 was carrying
(though the symptom only surfaced after a clean browser fetch — the
no-cache headers on the static assets in 0.6.1 are what forced the
hidden bug into the open).

### Fixed

- **Admin UI was permanently stuck on "loading…"** because
  `admin/app.js` uses top-level `await` at its bootstrap section, but
  `ui.html` loaded it as a classic `<script src="…" defer>` without
  `type="module"`. Browsers parse-error and no JS runs. Likely
  introduced by a cognitive-complexity refactor that flattened an
  IIFE; browser caching masked it on 0.6.0 / 0.6.1 until a clean
  fetch hit. Script tag now correctly says `type="module"` (modules
  are deferred by default, so the prior `defer` attribute folds in).

### Added

- **Test (`src/__tests__/admin-app-js-parse.test.ts`)** to make this
  class of bug visible in CI without needing a browser:
  - Dynamic-imports `admin/app.js` and asserts no `SyntaxError` —
    catches top-level-await mismatches, unclosed template literals,
    anything that parse-fails. Runtime errors past parse (no
    `document` in Node) are ignored.
  - Regex check on `ui.html` that the app.js script tag carries
    `type="module"`. Guards against the exact regression we just hit
    if someone copy-pastes a classic `<script>` tag back in.

## [0.6.1] — 2026-05-23

Supply-chain + CI hardening follow-up to 0.6.0. No runtime behavior
change.

### Security / CI

- **Release artifacts are now keyless-signed with Sigstore cosign.**
  The SBOM workflow signs each `ritsu-<version>-sbom.*.json` it
  produces; `.sig` + `.pem` certificates are attached to the release
  alongside the SBOMs. The signing identity is this repo's GitHub
  Actions OIDC token — no private key on disk anywhere. Verify with:
  ```
  cosign verify-blob \
    --certificate-identity-regexp "^https://github.com/Horizon-Digital-Engineering/ritsu/" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    --signature ritsu-v0.6.1-sbom.cdx.json.sig \
    --certificate ritsu-v0.6.1-sbom.cdx.json.pem \
    ritsu-v0.6.1-sbom.cdx.json
  ```
- **Explicit CodeQL workflow** (`.github/workflows/codeql.yml`) using
  `github/codeql-action` directly, replacing CodeQL "default setup".
  Same `security-extended` query suite the default setup was running,
  so dismissed-alert history carries over. Detectable by Scorecard's
  SAST check, which only sees explicit workflow files.
- **`main` branch protection enabled** (admin bypass left on so
  direct push to main still works for the solo-dev workflow).
- **Workflow token permissions tightened.** `build.yml` and
  `sbom.yml` now default to `contents: read` at the top level; the
  one job that needs `contents: write` (SBOM attach) carries the
  elevated perms at job scope.

### Fixed

- **Type-confusion guard on `stripTrailingSlashes`.** The helper is
  reachable from HTTP query params, which Express may parse as
  arrays. `s.codePointAt(...)` returns undefined on an array, so the
  trim loop would no-op and the array would silently pass through
  where the caller expected a string. Now throws TypeError on
  non-string input. Closes a critical CodeQL alert
  (`js/type-confusion-through-parameter-tampering`).
- **Rate-limiter on `/oauth/authorize` + `/oauth/token`** (60/min/IP
  default, `RITSU_OAUTH_MAX_PER_MIN` to override). The pre-existing
  `/oauth/register` limiter doesn't cover these endpoints.
- **Admin UI static assets served from memory.** `/admin`,
  `/admin/app.js`, `/admin/app.css` now read their files ONCE at boot
  instead of on every request. Removes the per-request filesystem
  access CodeQL was flagging on non-rate-limited routes. Server
  refuses to start if any of `dist/admin/*` is missing at boot —
  fail-loud matches the rest of the bootstrap posture.

### Pinned

- `node:22-bookworm-slim` pinned by digest in the Dockerfile (both
  builder + runtime stages).
- `scripts/setup-litellm.sh` pins pip + litellm versions explicitly.

## [0.6.0] — 2026-05-23

Security-focused release. A parallel-agent audit of the auth surface,
injection vectors, crypto + secrets, admin UI, and agent sandbox
surfaced 2 CRITICAL + 7 HIGH + 10 MEDIUM findings. This release ships
the fixes for all of them except two: cross-agent monitor scope
tightening (needs a new `allow_monitor_from` schema field) and HMAC-
pepper token hashing (needs a schema migration on `mcp_tokens`). Both
deferred so they get their own design pass; tracked in the private
ops backlog.

Upgrade is mostly transparent. The behavior changes worth flagging are
called out under **Changed** below; in particular:
- Bash no longer inherits `process.env`; only an allowlist of generic
  vars is forwarded. Anything an agent expected from the parent env
  (custom `RITSU_*` vars, `*_API_KEY`, etc.) won't be there.
- The colocated master-key fallback at `/opt/ritsu/data/.master-key`
  is now refused unless `RITSU_ALLOW_COLOCATED_KEY=1` is set.
- The admin-token bootstrap refuses to overwrite a pre-existing file.

### Security

- **WebFetch SSRF guard.** Four-layer defense: URL parse (reject
  `userinfo` + IP-literal URLs in private ranges), manual redirect
  handling with per-hop revalidation, custom undici dispatcher whose
  `connect.lookup` rejects DNS-resolved private IPs (closes DNS
  rebinding), and existing caller-side timeout + size caps. Comprehensive
  IPv4 + IPv6 range list including the IPv4-mapped-IPv6 trick
  (`[::ffff:127.0.0.1]`). Escape hatch via
  `RITSU_WEBFETCH_ALLOW_PRIVATE_HOSTS`.
- **Bash environment allowlist.** The Bash tool no longer forwards
  `process.env` to the child shell — only `PATH`, `HOME`, `USER`,
  `LANG`, `LC_ALL`, `TERM`. A prompt-injected agent that runs `env`
  no longer harvests `ANTHROPIC_API_KEY`, `RITSU_ADMIN_TOKEN`, or any
  operator-loaded credentials.
- **Bash sandbox (opt-in).** Set `RITSU_BASH_SANDBOX=1` to wrap every
  Bash call in `bwrap` (bubblewrap): ro-bind `/`, rw-bind only the
  workspace, private `/tmp`, `--die-with-parent`, `--unshare-pid/uts/ipc`,
  `--cap-drop ALL`. Network is intentionally NOT unshared (the
  WebFetch SSRF guard is the trade-off; layer firewall rules on the
  ritsu user if you need more). Fails loud with a remediation hint
  when set but `bwrap` isn't installed.
- **Symlink-safe FS tools.** `permissions.ts` now resolves through
  `fs.realpath` and re-checks workspace containment against the
  canonical path. An agent that drops `workspace/secret -> /etc/shadow`
  via Write can no longer Read it back. Glob/Grep walkers skip
  symlink dirents outright. `/proc /sys /dev` are deny-listed even
  if a workspace happens to cover them.
- **Workspace path-traversal prefix-confusion.** Admin-side workspace
  creation compared `combined.startsWith(root)` without a path
  separator — `root="/srv/foo"` matched `/srv/foobar/x`. Fixed; also
  made `checkWorkspaceUnderSandbox` fail-closed when `systemctl`
  can't enumerate the ReadWritePaths (was falling open on dev hosts
  without the unit installed).
- **OAuth consent CSRF + server-side state.** The `POST /oauth/authorize`
  handler used to trust client-supplied `code_challenge` / `redirect_uri`
  / `scope` from the form body. An attacker who registered a client via
  DCR and tricked the operator into signing a forged POST could bind
  their own PKCE to the authz code. Fixed: GET creates a server-side
  `oauth_authorize_requests` row (10-min TTL, single-use); the
  consent page renders only `request_id`; POST reconstructs PKCE +
  redirect from that row. POSTs with a mismatched `Origin` header
  are refused with 403.
- **OAuth DCR rate-limit + unverified-client badge.** `POST /oauth/register`
  is RFC-unauthenticated but is now per-IP rate-limited (5/hour by
  default, override via `RITSU_DCR_MAX_PER_IP`). The consent page now
  badges every self-registered client name as `(self-registered,
  unverified)` so an operator second-guesses a phishing-grade lookalike.
- **AES-GCM ciphertext binding (`enc:v2:`).** GCM provides integrity
  of *what* was encrypted, not *where* it lives. Without AAD, an
  attacker with DB-write could swap `key_enc` between rows and
  `reveal(id=anthropic)` would silently return the OpenAI key. New
  format binds each ciphertext to its row context (`api_key:id=42:key_enc`,
  `channel:id=7:bot_token`). Legacy `enc:v1:` reads still work; rotation
  is the v1→v2 upgrade path.
- **Atomic admin-token bootstrap.** `writeFileSync(path,..,{mode:0o600})`
  silently ignores the mode when the file exists. An attacker
  pre-creating the bootstrap path at 0644 would otherwise get the
  admin token at world-readable mode. Now uses `O_WRONLY|O_CREAT|O_EXCL`;
  if anything is at the path, the just-minted token is revoked and
  the process exits 70.
- **Master-key location + perms.** The fallback path
  `/opt/ritsu/data/.master-key` (next to the SQLite DB it protects)
  defeats the stated DB-only-theft threat model. Now refused unless
  `RITSU_ALLOW_COLOCATED_KEY=1` is set, with a remediation list
  pointing at `RITSU_MASTER_KEY` or `/etc/ritsu/master-key`. Read
  path now `statSync`s the key file (refuses anything but mode 0600)
  and its parent directory (refuses group/world-writable).
- **`ask_agent` confused-deputy + cycle + concurrency.** Refuses
  calls where the callee holds capabilities the caller doesn't (A with
  no `manage_agents` can't bounce off B to mint a wider-permission
  agent). Refuses if `target` is already in the call chain (cycle
  detection up front, not after burning tokens on the way down).
  Per-caller in-flight cap of 2 — no more 50-way fan-out.
- **Bash concurrency cap + timeout ceiling.** Per-workspace ceiling
  of 2 in-flight calls. `timeout_ms` upper bound lowered from 5
  minutes to 60 seconds.
- **`/admin/api/test` validation.** The last admin-side mutating-ish
  endpoint that used a direct `as` cast on `req.body` now parses
  through zod (`TestPaneBody`) and runs every ephemeral workspace
  through `checkWorkspaceUnderSandbox`.
- **HSTS** on admin responses (when the request reached us over TLS).
- **Log redactor split into EXACT + CONTAINS lists.** Substring match
  on `'key'` previously redacted `monkey` / `keyboard_shortcut`;
  exact-match for short names fixes the over-redaction. Added
  `plaintext`, `bearer`, `master_key`, `auth_tag`.
- **DDL identifier whitelist** in `addColumnIfMissing`. Currently
  every call site passes hardcoded literals — this is a future-
  maintainer guardrail against a regression that pipes user input
  through.

### Added

- **New env vars** (all opt-in):
  - `RITSU_BASH_SANDBOX=1` — enable bwrap sandbox for Bash.
  - `RITSU_ALLOW_COLOCATED_KEY=1` — accept the fallback master-key
    path; default is now refuse.
  - `RITSU_WEBFETCH_ALLOW_PRIVATE_HOSTS=docs.internal,...` — allow
    specific internal hostnames through the SSRF guard.
  - `RITSU_DCR_MAX_PER_IP=<N>` — override the DCR rate-limit (default 5).
  - `RITSU_SKIP_SANDBOX_CHECK=1` — opt-out of the workspace
    sandbox-roots check when `systemctl` is unavailable (dev mode).
- **`src/tools/ritsu-agent/ssrf-guard.ts`** with the IPv4/IPv6 range
  classifier, URL validator, custom undici dispatcher, and a
  `safeFetch` wrapper that does manual redirect handling.
- **`src/bootstrap-admin-token.ts`** extracted from `src/index.ts`
  so the precondition + fail-closed write are unit-testable without
  standing up the full server.
- **OpenSSF Scorecard** workflow + badge (`.github/workflows/security.yml`).
  Pushes SARIF to code-scanning + publishes to scorecard.dev.
- **`scripts/scan-secrets.sh` modernized** to the current `gitleaks
  git` API (was on the deprecated `gitleaks protect` / `gitleaks detect`).

### Changed

- **Single `src/config.ts` for runtime config.** Server (`src/index.ts`)
  and operator CLI now load through one validating module. Misconfig
  (invalid port, duplicate ports, unrecognised `MCP_REQUIRE_AUTH`)
  raises `ConfigError` listing every issue at once and exits 78
  (`EX_CONFIG`).
- **`RITSU_ADMIN_TOKEN_FILE`** is the canonical knob for the bootstrap
  admin-token path; default `./data/.admin-token` for dev,
  `/opt/ritsu/data/.admin-token` for the installer-written prod env.
- **Bash env** is allowlisted (see Security). Anything an existing
  setup relied on inheriting from the ritsu service env will need to
  be set explicitly in the workspace's environment.
- **Bash `timeout_ms`** ceiling lowered from 300_000 to 60_000.
- **README IMPORTANT callout** updated: the admin UI's bearer auth is
  documented, "not the open internet, yet" replaces the categorical
  "not the open internet". DEPLOY.md framing updated to match.
- **License switched to BUSL-1.1** (`package.json`, `LICENSE`).
- **CodeQL false-positive dismissals** for 2× `js/clear-text-logging`
  (`stats.apiKeys` is a row count, not a key) and 1× `js/missing-rate-limiting`
  on the admin middleware (rate limit is applied earlier in the chain).

### Fixed

- **Six broken HTML template literals** in `admin/app.js` — missing
  `>` on opening tags meant Memory content / superseded-by badges /
  tool badges / panel-nested sections rendered as attribute-name
  garbage. `esc()` was always there so it wasn't an XSS, just dead
  UI in the affected tabs.
- **`dotenv-lite` precedence** for the CLI: `/etc/ritsu/env` is now
  loaded automatically when a CLI subcommand runs on a prod host,
  matching what the systemd service sees.

## [0.5.0] — 2026-05-23

First public release of the rebuilt repo. The 0.4.0 codebase was
re-published from a clean working tree after a history scrub; this
release adds key-rotation tooling, a real OAuth HTTP integration
suite, supply-chain provenance in CI, and a docs reframe positioning
ritsu as a lab tool (not an internet-facing service). Zero behavior
change for existing operators — every addition is opt-in or
infrastructure-side.

### Added
- **`ritsu master-key rotate` CLI subcommand.** Re-encrypts every
  `enc:v1:*` payload (API keys, channel bot tokens) under a fresh
  AES-256-GCM key inside one SQLite transaction, then atomically
  swaps the on-disk key file with a `.prev` backup. Refuses to rotate
  when the key is sourced from `RITSU_MASTER_KEY` env (env-mode
  rotation requires restarting the service with a new env). Documented
  in `docs/cli.md` and `docs/threat-model.md`.
- **OAuth HTTP integration suite** (`src/__tests__/oauth-routes.test.ts`,
  29 tests). Spins up the real OAuth router on an ephemeral port over
  an in-memory SQLite DB and exercises DCR / authorize / token /
  refresh / revoke / RFC 8707 audience binding / PKCE / metadata
  endpoints end-to-end.
- **Workspace path-traversal tests** (`src/__tests__/admin-workspace-path.test.ts`,
  11 tests) covering every reject branch of `resolveWorkspaceTarget`
  — `..` escape, absolute-path replacement, symlink chases, path
  normalization edge cases.
- **Supply-chain hardening in CI.** The security workflow now runs
  `npm audit signatures` (Sigstore tarball verification — catches a
  compromised registry mirror or a modified tarball between publish
  and install). The release/SBOM workflow attaches SLSA build
  provenance via `actions/attest-build-provenance` so the published
  artifact is cryptographically tied to the workflow run.
- **Getting-started + CLI reference docs** under `docs/`:
  `getting-started.md`, `cli.md`, plus three example agent JSONs
  (`notetaker`, `code-reader`, `research-assistant`).
- **"Agents as Infrastructure" framing in the README** with an
  explicit `IMPORTANT` callout that ritsu is a lab tool, not an
  internet-facing service.

### Changed
- **Security utilities replacing suppression annotations.** Where
  the previous pass had suppressed lints with comments, this release
  swaps in real engineering controls:
  - `re2-wasm` replaces native `RegExp` on every user-supplied
    pattern (ReDoS-immune).
  - `src/util/safe-html.ts` exports a branded `SafeHtml` type +
    tagged-template literal; the admin HTML assembly path now refuses
    string concatenation of untrusted segments at the type level.
  - `src/util/safe-spawn.ts` resolves binaries against
    `TRUSTED_BIN_DIRS` rather than blessing hardcoded `/usr/bin/...`
    paths.
  - `src/util/path-utils.ts#stripTrailingSlashes` — regex-free O(n)
    replacement for the prior `/\/+$/` pattern.
- **Threat model moved to `docs/threat-model.md`** (was
  `THREAT_MODEL.md` at the repo root). Cross-referenced from the
  README and from `cli.md`.
- **`sonar-project.properties` excludes test fixtures cleanly**
  (`__tests__/**`, `*.test.ts`) so SonarCloud no longer fires
  production-code rules on test data.

### Fixed
- Gitleaks false-positive on the admin UI's `rt_YOUR_TOKEN` placeholder
  snippets (curl / mcp-remote / Claude Desktop config copy-paste
  blocks). `.gitleaks.toml` now uses `regexTarget = "line"` so the
  allowlist matches the snippet line, not just the captured secret.
- Actionlint SC2129 style findings in `.github/workflows/security.yml`
  — the per-line `>> $GITHUB_STEP_SUMMARY` writes are now collapsed
  into a single grouped redirect.
- Cognitive-complexity findings (S3776) cleared from the master-key
  rotation command, the OAuth router, and the admin app — every
  function is now under the Sonar threshold without behavior change.
- Single-case `switch` in `master-key.ts` flattened to `if`.
- `void operator` replaced with `.catch(() => undefined)` in the MCP
  server shutdown path.
- Positional-param + `[` vs `[[` style issues in `scripts/install.sh`
  and `scripts/scan-secrets.sh`.

### Security
- The pre-release history-rewrite + repo recreation removed internal
  hostnames and agent names from the public git log. No secrets were
  ever committed; the leak surface was operational metadata only. The
  SonarCloud project was deleted and recreated alongside the repo so
  no cached analyses retain references to the scrubbed strings.

## [0.4.0] — 2026-05-23

A two-day sweep that hardens the admin UI's CSP, drops every native +
heavyweight dep, and turns lint into real type-aware coverage. No
runtime-API breakage; two new admin tabs; the rest is correctness +
hygiene.

### Added
- **Admin UI: Audit tab** under the System nav group. Surfaces the
  `admin_audit` table (every mutating POST/PATCH/DELETE on
  `/admin/api/*`) with filters for path, token name, and method.
  Status-code colored via the existing log-level palette; row tooltip
  carries the body sha256 for tamper-evidence verification.
- **Admin UI: Tools tab** under the Agents nav group. Read-only
  per-agent tool inventory — built-in SDK tools, MCP tools gated by
  capabilities/can_call/memory backend, plus the workspaces backing
  any FS-touching tool. Documented in `docs/agent-types-and-tools.md`.
- **Two-row grouped admin nav.** Row 1 = top-level groups (Dashboard
  / Agents / Comms / Auth / System); row 2 = the active group's
  sub-tabs (hidden for singleton groups). Replaces the 10 flat tabs.
  `NAV_GROUPS` in `src/admin/app.js` is the single config source.
- `src/util/dotenv-lite.ts` — ~50-line replacement for the `dotenv`
  package. Same shape ritsu used (`KEY=value`, quotes, `export`
  prefix, comments, no-overwrite of shell-set keys). 8 covering tests.
- `src/util/cast.ts#asString` — type-narrowing helper for `unknown`
  inputs that need to flow into template literals / `String()` calls
  without the `"[object Object]"` foot-gun.

### Changed
- **CSP `script-src` and `style-src` are now `'self'`** (no
  `'unsafe-inline'` on either). The inline `<script>` block moved to
  `/admin/app.js`; the inline `<style>` block moved to
  `/admin/app.css`; every `onclick=`/`onsubmit=` attribute and every
  `style="…"` attribute (135 of them, static + JS-generated) is gone.
  Static assets served same-origin with no-cache headers. Per-agent
  glyph hue switched from inline HSL to discrete `data-hue-idx` + 8
  CSS rules. Headless Chromium load reports zero JS errors and zero
  CSP violations.
- **Tiles tab renamed to Dashboard** (visible label only; the
  underlying pane id stays `pane-tiles` so the diff is small).
- **`better-sqlite3` → `node:sqlite`.** Native dep removed.
  `src/db.ts` installs three small shims on every `DatabaseSync`:
  coerces `run().changes/lastInsertRowid` from BigInt to Number,
  clones rows from null-prototype to plain objects (so
  `deepStrictEqual` works and downstream code sees the same shape
  better-sqlite3 always exposed), and adds a `transaction(fn)`
  helper that mirrors better-sqlite3's BEGIN/COMMIT/ROLLBACK-on-throw
  API. On Node 22.22 (production host) `node:sqlite` emits one
  ExperimentalWarning at boot; stable in Node 24+.
- **`vitest` → `node:test`.** All 19 test files converted from
  `expect(...).matcher()` to `assert.*` (toBe → equal, toEqual →
  deepEqual, toBeNull → equal(null), toThrow → throws,
  rejects.toThrow → rejects, etc.). Test script is
  `tsx --test src/__tests__/*.test.ts`. ~70 transitive deps gone.
- **ESLint v9 flat config, type-aware.**
  `typescript-eslint/recommended-type-checked` is on with
  `parserOptions.project` against `tsconfig.json`. Tuned only where
  rules fire on framework-correct patterns: `no-floating-promises`
  allowlists node:test's `describe/it/test/etc`;
  `no-misused-promises` runs with `checksVoidReturn: false` (Express
  async handlers); `require-await` is off (mock impls and interface
  conformance). No `no-unsafe-*` exception remains.
- **Every mutating admin handler now zod-parses its body.** Nine
  schemas (`LogLevelBody`, `AskBody`, `MemoryCreateBody`,
  `MemoryPatchBody`, `WorkspaceCreateBody`, `TokenMintBody`,
  `ApiKeyMintBody`, `ChannelPatchBody`, `BindChatBody`) plus the
  `/oauth/token` grant_type dispatcher run through a new `parseBody`
  helper that returns 400 + structured `error.flatten()` on failure.
  Replaced the earlier inline `as { … }` casts (which satisfied lint
  but didn't validate at runtime).

### Removed
- `dotenv` dependency (replaced by `dotenv-lite`).
- `vitest` and `vitest.config.ts` (replaced by `node:test` + `tsx --test`).
- `better-sqlite3` and `@types/better-sqlite3` (replaced by `node:sqlite`).
- The flat 10-tab admin nav (replaced by two-row grouped nav).
- Every inline `<script>`, inline `<style>`, `onclick=`, `onsubmit=`,
  and `style=""` attribute in the admin UI.

### Security
- CSP tightened — see `docs/threat-model.md` § A1.
- Admin API body validation is now real (zod) instead of cosmetic
  (`as` cast).

### Maintenance
- ESLint v9 flat config (`eslint.config.js`); the lint script
  switched from the deprecated `--ext .ts` flag to plain `eslint src`.
- `@types/node` bumped 20 → 22 (`node:sqlite` types ship in 22+).

### Known noise
- Node 22.22 prints one `ExperimentalWarning: SQLite is an
  experimental feature` at boot. Accurate signal — node:sqlite is
  stable in Node 24+; left visible deliberately.

## [0.3.0] — earlier

Last tagged release on package.json. Significant work merged since
without a bump (OAuth 2.1 surface, channels, ritsu-agent runtime,
per-agent capabilities, security hardening pass) — that history
lives in `git log`. 0.4.0 is the first explicit bump since.
