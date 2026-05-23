# Threat Model

The defense posture ritsu was built for. Read alongside [SECURITY.md](./SECURITY.md).

## Assumed deployment shape

- Single operator (or a small trusted team) self-hosting on a tailnet-anchored box.
- Backend network: trusted (Tailscale, WireGuard, or a private LAN). The tailnet ACL is the outer auth boundary.
- Frontends: a phone, a laptop, maybe a few CLI machines, all on the tailnet.
- Agents run claude-direct (`@anthropic-ai/claude-agent-sdk`) by default; future ritsu-agent runtime adds OpenAI-compat backends with operator-supplied API keys.

## Adversaries we defend against

### A1. External attacker on the public internet
**Capability:** Can probe public IPs, attempt to hit any exposed port.
**Defense:** ritsu's MCP and admin servers bind to `127.0.0.1` by default. Operators who front the service with a public reverse proxy (Tailscale Serve, nginx + TLS, Cloudflare Tunnel) must explicitly opt in by changing `MCP_HOST`/`ADMIN_HOST`. Even then:
- All MCP calls require a bearer token; admin endpoints reject any request without `Authorization: Bearer rat_…`.
- DNS rebinding protection on the MCP Streamable HTTP transport.
- Strict CSP on the admin UI. As of v0.4.0, both `script-src` and `style-src` are `'self'` only — no `'unsafe-inline'` on either. The page has no inline `<script>` / `<style>` blocks, no `onclick=`/`onsubmit=` attributes, no `style="…"` attributes; all JS goes through one delegated `data-action` listener loaded from `/admin/app.js`, all styling through `/admin/app.css`. A malicious page that managed to inject markup into a JS-rendered admin pane would still be denied script execution. `frame-ancestors 'none'` + `X-Frame-Options: DENY` prevent clickjacking from a hostile origin.
- Body validation on every mutating admin endpoint: each POST/PATCH/DELETE on `/admin/api/*` parses `req.body` through a zod schema before any handler logic touches it. A malformed body gets a structured 400, not a deep crash or an unsafe field access.

### A2. Tailnet member, non-operator
**Capability:** Can reach ritsu over the network.
**Defense:** Same as A1 — must possess a valid bearer token. Scope discrimination means an MCP token cannot reach `/admin/*`. Audit trail records who-did-what for forensics.

### A3. Token leak (CLI history, git commit, screenshot)
**Capability:** Holds a previously-valid token. Bot tokens, MCP bearers, OAuth client secrets are all stored hashed-at-rest, so server compromise alone doesn't yield the plaintext, but token leakage *from the operator side* is treated as a real risk.
**Defense:**
- Operator can mint with `ttl_seconds` to cap the blast-radius of a leak: even if the token leaks to a chat history that gets indexed, it stops working after the TTL.
- Operator can `revoke` an active token at any time; revocation takes effect on next `verify()` call (no in-process cache to invalidate).
- Per-token audit shows last_used_at + use_count so the operator can spot unusual activity.
- The `auth.clientId` (token name or OAuth client_id) flows into every audit row, so a leaked token's lateral movement is traceable.

### A4. SQLite DB file leak
**Capability:** Has the `ritsu.db` file.
**Defense:**
- Tokens are sha256-hashed; the plaintext is never written. Attacker cannot recover the bearer values.
- Sensitive channel config (Telegram bot tokens, future API keys) is AES-256-GCM encrypted. Recovery requires *also* leaking the master key.
- Master key is kept outside the DB directory when `RITSU_MASTER_KEY` or `/etc/ritsu/master-key` is configured. Default-fallback colocates it in `/opt/ritsu/data/.master-key`, logged with a WARN to nudge operators toward separation.
- Memories and conversation transcripts are NOT encrypted. If your agent system prompt is sensitive, the DB leak exposes it.

### A5. Prompt injection / malicious user input
**Capability:** A user (you, or someone on a channel allowlist) can craft a message that tries to coerce the agent into misbehaving — exfiltrating data, calling tools they "shouldn't", etc.
**Defense:**
- `tools_allowlist` + `workspaces` mean the agent only has access to what you explicitly gave it. An agent with no Bash + no writable workspace cannot exfiltrate files even if perfectly socially-engineered.
- `can_call` allowlist means an agent can only delegate to other agents you've approved. No "the prompt told me to ask the sensitive-data agent" escape.
- Per-tool permission enforcement via `canUseTool` is at the SDK level — happens BEFORE the SDK invokes the tool. A prompt-injected attempt to `Read /etc/shadow` from an agent whose workspace is `/home/$USER/projects` is denied without the read ever firing.
- `MAX_CALL_DEPTH` = 3 caps recursive delegation chains. A→B→C→D returns an error to the model, which the model sees in its tool result.

### A6. Lateral movement from a compromised agent
**Capability:** Suppose an agent's prompt injection succeeds enough to issue tool calls of its choice.
**Defense:**
- The agent only has the in-process MCP servers wired for it (memory + agent-comms). It cannot register new servers.
- All FS tool calls go through `canUseTool` → only writable inside allowed workspaces.
- All agent-to-agent calls go through `can_call` → only allowed agents reachable.
- Bash is treated as privilege escalation: the Bash-enabled agents have minimal workspace scope.
- Per-message audit means every tool call is logged with token id + agent id.

### A7. Memory poisoning
**Capability:** An attacker tries to plant false memories that the agent will treat as ground truth.
**Defense:**
- All memory writes go through `mcp__memory__remember` / `update_memory` / `forget` and are scoped to the calling agent (agent_id is closed over, not a tool arg).
- The operator can read/edit/delete any memory via the admin UI Memories tab.
- Memory is supersede-not-delete: the lineage history is preserved, so a malicious-looking edit can be audited.

## Adversaries we do NOT defend against

### Out of scope: A8. Compromise of the host OS
If `root` is compromised on the box running ritsu, attacker reads the master key, the SQLite DB, and every secret in memory. Defending against this needs hardware enclaves or remote attestation, which is outside ritsu's scope. The systemd sandbox makes a remote escalation harder but doesn't claim to prevent local privilege escalation.

### Out of scope: A9. Compromise of the model provider
Anthropic, OpenAI, etc. see every prompt + completion. Don't put data in agent prompts that you wouldn't send to those vendors. For high-confidentiality use cases, ritsu doesn't help — that's a different product (e.g. local Ollama via `litellm`).

### Out of scope: A10. Compromise of upstream npm dependencies
A malicious package update to `express` or any other prod dep could backdoor the server. Mitigations:
- `package-lock.json` is committed; CI verifies `npm ci` reproduces the lock.
- `npm audit` clean is a build prerequisite.
- Dependency surface is intentionally minimal (no helmet, no rate-limit lib; we wrote those by hand).

### Out of scope: A11. Side-channel attacks on bearer-token verification
The `verify()` SQL is deterministic in the sense that the same hashed input produces the same lookup, but we don't claim formal constant-time guarantees. An attacker with extremely fine-grained timing on the loopback interface might learn information about the hash distribution. Not believed exploitable in practice for sha256-prefixed 24-byte random tokens.

### Out of scope: A12. Multi-tenant isolation
ritsu is single-operator. If you give two people admin tokens, they share full control. There's no per-user agent ownership, no resource quotas. Multi-operator support is intentionally not built.

## Open security questions

- **Memory encryption at rest.** Conversations and memories aren't encrypted. They contain agent prompts + replies which could be sensitive. Slated for a future pass.
- **Token rotation hygiene.** v0.4.0 adds an age column with a tiered badge on both the Tokens and API Keys tabs (info <90d, warn 90-180d, error ≥180d), so the operator can spot rotation candidates at a glance. Still passive (no automated revoke / no email reminder) — that's the next step if rotation actually starts mattering at scale.
- **Network egress filtering.** Agents with `WebFetch` can reach arbitrary HTTPS URLs. We rely on the workspace + tools_allowlist to gate this. A future hardening pass could add a per-agent egress allowlist.
- **Secret rotation for the master key.** Implemented as `ritsu master-key rotate` (see [`cli.md`](./cli.md)). Generates a new key, re-encrypts every at-rest ciphertext under it in one SQLite transaction, atomically swaps the on-disk key file, backs up the old key for rollback.

- **Audit-log tamper evidence.** Each `admin_audit` row stores the body's sha256 — useful for replaying a known request to confirm a row wasn't selectively edited. Currently rows are not chained (no row N stores the hash of row N-1), so an adversary with DB write access could delete a row without leaving a gap in the chain. Planned: extend the schema with a `prev_hash` column and a `ritsu audit verify` CLI subcommand that walks the chain and reports breaks. Not yet shipped; the existing per-row body hash is the v1 evidence.
