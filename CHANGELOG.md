# Changelog

All notable changes to ritsu are recorded here. Format roughly follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); semantic
versioning per [semver](https://semver.org/).

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
