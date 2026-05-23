# Changelog

All notable changes to ritsu are recorded here. Format roughly follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); semantic
versioning per [semver](https://semver.org/).

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
