# Security

ritsu is designed to be self-hosted on a tailnet or similar trusted network. The defaults are restrictive (auth required, no public exposure, encryption at rest for sensitive config). Operators who choose to expose ritsu more broadly should read the [Threat Model](./docs/threat-model.md) before doing so.

## What ritsu defends against

**Network exposure**
- MCP and admin servers bind to `127.0.0.1` by default. Public access requires either a manual config change or fronting with TLS (Tailscale Serve, reverse proxy, etc.).
- Tailscale-anchored is the documented happy path; the tailnet ACL is your real auth boundary.
- DNS rebinding protection on the MCP transport (`allowedHosts` enforced at the SDK layer).

**Auth surface**
- All MCP calls require a bearer token (`MCP_REQUIRE_AUTH=on`) or are blocked.
- Bearer tokens are sha256-hashed at rest; the plaintext is shown to the operator exactly once at mint time.
- Two non-interchangeable scopes:
  - `rt_*` MCP tokens → `/mcp` surface only.
  - `rat_*` admin tokens → `/admin/*` surface only.
- Optional `expires_at` on every token; expired tokens are rejected by `verify()` in SQL (one round-trip, no race window).
- OAuth 2.1 with Dynamic Client Registration (RFC 7591), PKCE-required (RFC 9728), and audience-bound access tokens (RFC 8707) for clients that don't fit the static-bearer model.

**Secrets at rest**
- Telegram bot tokens (and future API keys) are encrypted with AES-256-GCM before being written to the SQLite DB.
- Master key priority: `RITSU_MASTER_KEY` env var → `/etc/ritsu/master-key` → `/opt/ritsu/data/.master-key` (auto-bootstrapped on first run; logs a warning when colocated with the DB).
- Per-secret 96-bit random IV + 128-bit auth tag; tampered ciphertext fails authentication and is rejected.

**Per-agent isolation**
- Each agent has a `tools_allowlist` (SDK tool names like `Read`, `Write`, `Bash`) AND a `workspaces` list with per-path permissions (`read`, `write`, `exec`).
- The Claude Agent SDK's `canUseTool` callback enforces the permission map BEFORE the tool touches the filesystem — denied calls don't reach `Read`/`Write`/`Bash` at all.
- Inter-agent calls are gated by a per-agent `can_call` allowlist with bidirectional sync; the depth-3 loop guard prevents runaway A→B→C→D chains.
- Memory and inter-agent comms tools are wired per-agent (`createSdkMcpServer` with the agent_id closed over) so an agent can't impersonate another by passing a different id.

**Process isolation**
- Systemd unit ships with `ProtectHome=read-only`, `ProtectSystem=strict`, scoped `ReadWritePaths`, `NoNewPrivileges`, `PrivateTmp`.
- The `ritsu` service user has no shell, no sudo, no group membership beyond its own.

**Operator-inspectable state**
- Memory is plain SQLite rows with operator CRUD on the admin UI. No opaque vendor-managed "memory tool" with hidden state.
- Conversations + per-message caller attribution (`caller_label`: `admin-ui`, MCP token name, or calling agent id) means every turn has a verifiable origin.

**Audit**
- Per-MCP-tool-call audit: token id + tool + agent id + status, retained in `mcp_token_usage`.
- Per-admin-action audit: every mutating request (`POST`/`PATCH`/`PUT`/`DELETE`) on `/admin/api/*` is recorded with token id, IP, status, body sha256, and duration in `admin_audit`. View via `GET /admin/api/audit`.

**Defense-in-depth on the admin UI**
- Strict Content-Security-Policy (no remote scripts, no inline `eval`, no `data:` URIs except narrow image use).
- `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy` shutting off camera/mic/geo/cohort.
- Request body limit (`256kb`) + per-IP rate limit (`240 req/min` on `/admin/api/*`).

## What ritsu does NOT defend against

- **Operator-machine compromise.** If the box running ritsu is rooted, all bets are off. Master key, admin token, agent prompts, all readable.
- **Master-key colocation with DB.** The default fallback puts the master key in the same directory as the SQLite file. Operators who care should set `RITSU_MASTER_KEY` or `/etc/ritsu/master-key` to a separate location.
- **Compromised model providers.** Anthropic / OpenAI / etc. see the full prompt and response. If you wouldn't send a thing to those vendors, don't put it in an agent's system prompt or message.
- **Agent prompt injection.** Tool calls go through `canUseTool`, but the agent itself is an LLM and can be socially engineered via crafted messages. The workspace + tools_allowlist + can_call cap blast radius, but a determined adversary with chat access to an agent that has Bash + a writable workspace can probably exfiltrate that workspace.
- **Sub-process secrets.** The Claude Agent SDK shells out to `claude-cli`. We don't audit what the subprocess does internally.
- **Side-channel timing/info leaks** through verify() — the SQL prepared statement is deterministic per (hash, scope, expiry), but we don't claim formal constant-time guarantees.

## Security tooling (CI + repo hygiene)

What runs on every push / PR:

- **CI** (`.github/workflows/ci.yml`) — lint, typecheck, build, test on Node 22.
- **Sonar** (`.github/workflows/build.yml`) — SonarCloud scan with `c8` lcov coverage.
- **Security** (`.github/workflows/security.yml`) — runs all of:
  - `actionlint` workflow lint (catches malformed / unsafe workflow syntax)
  - `trufflehog --only-verified` against full git history
  - `gitleaks detect` against full git history (different rule set; SARIF uploaded as artifact)
  - `npm audit --audit-level=high`
  - `semgrep --config auto --error` (pinned to a numbered image tag, not `:latest`)
- **SBOM** (`.github/workflows/sbom.yml`) — on every published release, generates CycloneDX + SPDX SBOMs via `npm sbom` and attaches to the release.
- **Dependabot** — weekly grouped npm + github-actions update PRs.

What's enabled at the GitHub repo level:

- Dependabot vulnerability alerts: **on**
- Dependabot automated security updates (auto-PRs on vulnerable deps): **on**
- All GitHub Actions pinned to commit SHAs with a trailing `# vX.Y.Z` comment.

Local pre-push convenience:

- `npm run scan:secrets` — runs `gitleaks` against the working tree (install gitleaks first). Optional pre-commit hook: `ln -s ../../scripts/scan-secrets.sh .git/hooks/pre-commit`.

## Recommended GitHub repo settings

If you're forking or self-hosting ritsu, enable the following in the GitHub UI for defence in depth:

- **CodeQL code scanning** (free on public repos via Settings → Security → Code scanning → Default setup).
- **Secret scanning + push protection** (free on public repos).
- **Dependabot vulnerability alerts** + **automated security updates**.
- **Private vulnerability reporting** (Settings → Code security → Private vulnerability reporting).
- **Branch protection on `main`** — require PR + CI/Security workflows green before merge.

## Reporting

Found something? Open an issue or email `security@horizon-digital.dev`. No bounty program; just a thanks and credit if you want it.

## Supported configurations

Tested on:
- Ubuntu 24.04, Node 22+, `node:sqlite` (built-in), systemd unit included.
- Tailscale Serve fronting localhost binds for HTTPS.

Not tested / use at your own risk:
- macOS / Windows.
- Public-internet-exposed deployment without a reverse proxy enforcing auth at the edge.
- Multi-operator setups (audit assumes one admin identity).
