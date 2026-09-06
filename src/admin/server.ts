import express, { type Request, type Response } from 'express';
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, sep, resolve as resolvePath, normalize as normalizePath } from 'node:path';
import { spawnSync } from '../util/safe-spawn.js';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AgentDefinitionStore } from '../agent-definition-store.js';
import type { AgentHost } from '../agent-host.js';
import type { TokenStore } from '../auth/token-store.js';
import type { ApiKeyStore } from '../auth/api-key-store.js';
import { API_KEY_PROVIDERS } from '../auth/api-key-store.js';
import type { WorkspaceStore, Permission } from '../workspace-store.js';
import type { PluginHost } from '../plugins/host.js';
import type { MemoryStore } from '../memory-store.js';
import type { ConversationStore } from '../conversation-store.js';
import type { ApprovalStore } from '../approval-store.js';
import type { SecretStore } from '../auth/secret-store.js';
import type { BackupManager } from '../backup.js';
import { EMAIL_NS, EMAIL_SECRET_KEYS } from '../connectors/email.js';
import { FLASHBACK_NS, FLASHBACK_SECRET_KEYS, loadMemoryConfig } from '../memory/config.js';
import { TWITTER_NS, TWITTER_SECRET_KEYS } from '../connectors/twitter.js';
import { LINKEDIN_NS, LINKEDIN_SECRET_KEYS } from '../connectors/linkedin.js';
import { LITELLM_NS, LITELLM_SECRET_KEYS } from '../model/ritsu-agent/client.js';
import { runHealthChecks } from './health.js';
import { CLAUDE_NS } from '../model/claude-direct-dispatcher.js';
import { masterKeyStatus } from '../util/secret-crypto.js';
import { INGEST_NS, INGEST_SECRET_KEYS } from '../ingestion/extractors.js';
import type { ChannelStore } from '../channels/channel-store.js';
import type { JobStore, JobUpsert } from '../scheduler/store.js';
import { nextRun } from '../scheduler/schedule.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { OAuthStore } from '../auth/oauth-store.js';
import { ChannelKindSchema, TelegramConfigSchema } from '../channels/types.js';
import { z } from 'zod';
import { AgentDefinitionSchema, AgentDefinitionPatchSchema } from './schema.js';
import { AGENT_TYPES } from '../agents/registry.js';
import { eventBus } from '../event-bus.js';
import { conversationBus, type ConversationEvent } from '../conversation-bus.js';
import { approvalBus, type ApprovalEvent } from '../approval-bus.js';
import type { CommsDenialStore } from '../comms-denial-store.js';
import { metricsHandler } from '../metrics.js';
import { RateLimiter } from '../util/rate-limit.js';
import { ProjectStore } from '../project-store.js';
import { SkillStore } from '../skill-store.js';
import { PromptStore } from '../prompt-store.js';
import {
  listFiles, readWorkspaceFile, writeWorkspaceFile, deleteWorkspaceFile, canonicalIfContained,
} from '../agent-files.js';
import { validateUrl, safeFetch } from '../tools/ritsu-agent/ssrf-guard.js';
import { fenceUntrusted } from '../util/untrusted.js';
import { logger } from '../util/log.js';
import { stripTrailingSlashes } from '../util/path-utils.js';
import { TOOL_NAMES, TOOL_INFO } from '../mcp-server.js';
import type { AuthMode } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Narrow an express 5 route param (`string | string[] | undefined`) to a
 * single string. All our routes use single-segment params (`/:id`,
 * `/:client_id`, ...) so the array form never appears in practice; this
 * helper just keeps TypeScript happy without per-call casts.
 */
function param(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/**
 * Clamp a `?limit=` query param into [1, max]. Math.min alone is not enough:
 * SQLite reads a negative LIMIT as unlimited, so `?limit=-1` dumps the whole
 * table (attachments included), and `?limit=abc` reaches the driver as NaN
 * and 500s on a datatype mismatch.
 */
/**
 * Remove `<tag ...>content</tag ...>` containers (script/style) with a linear
 * scan — the lazy-regex version backtracks super-linearly on adversarial
 * unclosed tags, and this runs on fetched pages. Semantics match the regex it
 * replaces: the open tag name must end at a word boundary, the closer
 * tolerates attributes/whitespace, and an opener with no closer is left in
 * place for the generic tag strip to eat.
 */
function stripContainers(html: string, tag: string): string {
  const lower = html.toLowerCase();
  const open = `<${tag}`;
  const close = `</${tag}`;
  const wordChar = /[a-z0-9_]/;
  let out = '';
  let i = 0;
  while (i < html.length) {
    const s = lower.indexOf(open, i);
    if (s === -1) { out += html.slice(i); break; }
    const boundary = lower[s + open.length];
    const gt = boundary !== undefined && !wordChar.test(boundary) ? html.indexOf('>', s + open.length) : -1;
    let closedAt = -1;
    for (let c = gt === -1 ? -1 : gt + 1; c !== -1 && c < html.length;) {
      const e = lower.indexOf(close, c);
      if (e === -1) break;
      const after = lower[e + close.length];
      if (after !== undefined && wordChar.test(after)) { c = e + 1; continue; }
      const egt = html.indexOf('>', e + close.length);
      if (egt === -1) break;
      closedAt = egt;
      break;
    }
    if (closedAt === -1) {
      // Not a removable container here — emit one char and rescan, exactly
      // like the regex engine advancing past a failed match position.
      out += html.slice(i, s + 1);
      i = s + 1;
    } else {
      out += html.slice(i, s) + ' ';
      i = closedAt + 1;
    }
  }
  return out;
}

/** Crude but safe page-to-text: scripts/styles dropped, tags to spaces, a few
 *  entities decoded, whitespace collapsed. Extraction quality is not the goal
 *  — the result is fenced context, not rendered content. */
export function htmlToText(html: string): string {
  return stripContainers(stripContainers(html, 'script'), 'style')
    .replace(/<[^>]*>/g, ' ')
    // Entities: &amp; is decoded LAST, so "&amp;lt;" yields the four
    // characters "&lt;" rather than a freshly minted "<".
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function clampLimit(raw: unknown, fallback: number, max: number): number {
  let n: number;
  // Number(Symbol) throws; nothing HTTP hands us can be one, but a guard
  // function has no business being the thing that crashes.
  try { n = Number(raw ?? fallback); } catch { return fallback; }
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), max);
}

export interface AdminDeps {
  defStore: AgentDefinitionStore;
  host: AgentHost;
  tokens: TokenStore;
  apiKeys: ApiKeyStore;
  workspaces: WorkspaceStore;
  pluginHost: PluginHost;
  memory: MemoryStore;
  conversations: ConversationStore;
  approvals: ApprovalStore;
  commsDenials: CommsDenialStore;
  backup: BackupManager;
  projects: ProjectStore;
  skills: SkillStore;
  prompts: PromptStore;
  secrets: SecretStore;
  channels: ChannelStore;
  channelRegistry: ChannelRegistry;
  jobs: JobStore;
  oauth: OAuthStore;
  version: string;
  authMode: AuthMode;
  /** Base URL of the in-process MCP server, used by the /admin/api/mcp/* proxy. */
  mcpUrl: string;
  /** Memory config resolved at boot — what the running process is actually
   *  using (stored secrets may differ until the next restart). */
  memoryBoot?: { mode: string; remote: string | null };
  /** Operator-tunable runtime knobs. Absent = the settings UI reports 503. */
  settings?: import('../settings-store.js').SettingsStore;
}

/**
 * SDK tool names available to claude-direct agents. Sourced from the Claude
 * Agent SDK's claude_code preset. The UI uses this to render the per-agent
 * tools_allowlist multi-select.
 */
export const AVAILABLE_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
] as const;

const PERMISSION_VALUES: ReadonlyArray<Permission> = ['read', 'write', 'exec'];

// ---- request-body schemas for mutating admin endpoints --------------------
// Every mutating /admin/api/* handler parses req.body through one of these
// before touching its fields. An `as` cast would satisfy the no-unsafe-*
// lint at compile time but silently lies to TS about a runtime shape the
// caller may not honor. Real validation here.

const LogLevelBody = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
});

// Attachments are operator-pasted images. Hard caps here are the server-side
// backstop to the client's downscaling: ≤4 images/turn, each ≤~5MB binary
// (~6.8M base64 chars), matching the Anthropic per-image API limit. Charset is
// validated so a non-base64 blob can't slip through to a provider.
const AttachmentBody = z.object({
  media_type: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  data: z.string().min(1).max(6_800_000).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'data must be base64'),
});

const AskBody = z.object({
  // Empty is allowed only when an image rides along (an image-only "look at
  // this" turn); the refine below enforces "text OR image".
  message: z.string().trim().default(''),
  conversation_id: z.number().int().optional(),
  // Message-tree anchor: edit-a-turn passes the edited message's own parent,
  // creating a sibling branch instead of appending to the leaf.
  parent_message_id: z.number().int().positive().nullable().optional(),
  attachments: z.array(AttachmentBody).max(4).optional(),
}).refine(
  b => b.message.length > 0 || (b.attachments?.length ?? 0) > 0,
  { message: 'message or an image is required' },
);

const MemoryCreateBody = z.object({
  agent_id: z.string().trim().min(1, 'agent_id required'),
  content:  z.string().trim().min(1, 'content required'),
});

const MemoryPatchBody = z.object({
  content: z.string().trim().min(1, 'content required'),
});

/** Two accepted shapes (legacy `{path}` + new picker `{root, subpath}`).
 *  The refine() enforces "at least one of path or root is present"; the
 *  handler still does path-traversal + sandbox-root checks after this. */
const WorkspaceCreateBody = z.object({
  root:        z.string().trim().min(1).optional(),
  subpath:     z.string().trim().optional(),
  path:        z.string().trim().min(1).optional(),
  permissions: z.array(z.enum(['read', 'write', 'exec'])).optional(),
}).refine(b => b.root !== undefined || b.path !== undefined, {
  message: 'path (or root + subpath) required',
});

const TokenMintBody = z.object({
  name:        z.string().trim().min(1, 'name required'),
  scope:       z.enum(['mcp', 'admin']).optional(),
  // The UI may send a number, a string the operator typed in, null
  // (explicit "no expiry"), or omit the field entirely. All four are
  // valid; the handler resolves the string/number form into seconds.
  ttl_seconds: z.union([z.number(), z.string()]).nullable().optional(),
});

const ApiKeyMintBody = z.object({
  name:      z.string().trim().min(1, 'name required'),
  provider:  z.enum(API_KEY_PROVIDERS),
  plaintext: z.string().trim().min(1, 'plaintext key required'),
});

const ChannelPatchBody = z.object({
  name:              z.string().trim().min(1).optional(),
  operator_agent_id: z.string().trim().min(1).optional(),
  enabled:           z.boolean().optional(),
  // config is validated by `validateChannelConfig(kind, config)` after this
  // parse — its shape varies per kind so we keep it unknown here.
  config:            z.unknown().optional(),
});

const BindChatBody = z.object({
  chat_id: z.number().int(),
});

const ApprovalDecideBody = z.object({
  decision: z.enum(['approved', 'rejected']),
  // Operator's optional note. On reject it's fed back to the model as the
  // tool-denial reason so it can adapt; on approve it's just an audit note.
  reason: z.string().trim().max(2000).optional(),
});

/** `claude setup-token` output. Long, opaque, prefixed — checked loosely so a
 *  future prefix change doesn't lock the operator out of their own UI. */
const ClaudeTokenBody = z.object({
  token: z.string().trim().min(20).max(2048),
});

const SecretSetBody = z.object({
  namespace: z.string().trim().min(1).max(64),
  name:      z.string().trim().min(1).max(64),
  value:     z.string().min(1).max(8192),
});

/** Test-pane body. Mirrors the agent-edit form's draft state — never
 *  persisted. The workspaces array MUST be validated and sandbox-checked
 *  like the persistent workspace-create path; without that the test pane
 *  becomes a "run anywhere reachable by the service account" gadget. */
const TestPaneBody = z.object({
  system_prompt:   z.string().min(1),
  message:         z.string().min(1),
  runtime:         z.enum(['direct', 'api']).default('direct'),
  provider:        z.string().default('claude'),
  api_key_ref:     z.number().int().positive().nullable().default(null),
  provider_options: z.record(z.string(), z.unknown()).default({}),
  model:           z.string().trim().min(1),
  tools_allowlist: z.array(z.string()).optional(),
  workspaces:      z.array(z.object({
    path:        z.string().trim().min(1),
    permissions: z.array(z.enum(['read', 'write', 'exec'])).min(1),
  })).optional(),
});

/**
 * Parse `req.body` against `schema`. On failure, respond 400 with the
 * structured zod issues and return null so the handler can early-return.
 * On success, return the parsed (typed!) body — no `as` cast needed.
 */
function parseBody<T>(req: Request, res: Response, schema: z.ZodType<T>): T | null {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    // z.treeifyError replaces zod 3's deprecated `.flatten()`; structurally
    // similar payload (top-level `errors` + per-path child trees).
    res.status(400).json({ error: 'invalid request body', issues: z.treeifyError(parsed.error) });
    return null;
  }
  return parsed.data;
}

/** Validate a channel's config payload against the right schema for the kind.
 *  Used by the create + patch endpoints; lifted out of createAdminApp so the
 *  surrounding closure stays small. */
function validateChannelConfig(kind: string, config: unknown): unknown {
  if (kind === 'telegram') return TelegramConfigSchema.parse(config);
  throw new Error(`unknown channel kind: ${kind}`);
}

/** Redact secrets before returning a channel row to the client — bot tokens
 *  must never round-trip through the API. Pure transform; module-scope so
 *  closure overhead doesn't compound across the channel handlers. */
function redactChannel<T extends { config: unknown } | null>(row: T): T {
  if (!row) return row;
  const config = row.config && typeof row.config === 'object'
    ? { ...(row.config as Record<string, unknown>) }
    : row.config;
  if (config && typeof config === 'object' && 'bot_token' in config && typeof config.bot_token === 'string') {
    const t = config.bot_token;
    (config as Record<string, unknown>).bot_token = t.length > 8 ? `${t.slice(0, 4)}…${t.slice(-4)}` : '…';
  }
  return { ...row, config };
}

/**
 * Resolve the workspace's target path from one of the two accepted body
 * shapes (legacy {path}, or new picker {root, subpath}). Returns the
 * normalized absolute path, or null after responding 400 — rejects any
 * subpath that would traverse outside the chosen root.
 *
 * Exported for direct unit testing; the route handler in createAdminApp
 * is the only production caller.
 */
export function resolveWorkspaceTarget(
  body: { root?: string; subpath?: string; path?: string },
  res: Response,
): string | null {
  if (body.root) {
    const sub = (body.subpath ?? '').replace(/^\/+/, '');
    const combined = normalizePath(resolvePath(body.root, sub));
    const root = normalizePath(body.root);
    // root === combined: subpath was empty, picker landed on the root itself.
    // Otherwise combined must sit STRICTLY under `root + sep` — without the
    // separator, root="/srv/foo" matches "/srv/foobar/x" via prefix
    // confusion.
    if (combined !== root && !combined.startsWith(stripTrailingSlashes(root) + sep)) {
      res.status(400).json({ error: 'subpath traversal outside root not allowed' });
      return null;
    }
    return combined;
  }
  if (body.path) return normalizePath(resolvePath(body.path));
  res.status(400).json({ error: 'path (or root + subpath) required' });
  return null;
}

/**
 * Check that `target` sits under one of the systemd unit's
 * ReadWritePaths. Returns true on pass, or false after responding 400.
 *
 * Two failure modes:
 *
 *   - `systemctl` not available or `ritsu.service` not registered:
 *     fail CLOSED unless RITSU_SKIP_SANDBOX_CHECK=1 is set. Earlier
 *     versions returned `true` here ("the systemd sandbox will enforce
 *     at runtime"), which is fine in prod where systemd is the boundary
 *     — but on a dev box without the unit installed it meant ANY
 *     admin-supplied path was accepted, sidewise-escape-style. The env
 *     opt-out exists so `npm run dev` doesn't lock you out.
 *   - target is not under any ReadWritePaths entry: reject with a 400.
 */
function checkWorkspaceUnderSandbox(target: string, res: Response): boolean {
  const rootsRes = spawnSync('systemctl', ['show', 'ritsu.service', '-p', 'ReadWritePaths', '--value'], {
    encoding: 'utf8',
  });
  const allowedRoots = rootsRes.status === 0
    ? rootsRes.stdout.trim().split(/\s+/).filter(Boolean)
    : [];
  if (allowedRoots.length === 0) {
    if (process.env.RITSU_SKIP_SANDBOX_CHECK === '1') return true;
    res.status(400).json({
      error: 'sandbox roots could not be enumerated',
      hint: 'systemctl show ritsu.service failed; set RITSU_SKIP_SANDBOX_CHECK=1 for dev without systemd',
    });
    return false;
  }
  const inside = allowedRoots.some(r => {
    const root = stripTrailingSlashes(r);
    return target === root || target.startsWith(root + sep);
  });
  if (!inside) {
    res.status(400).json({
      error: 'path is outside the sandbox',
      hint: `must be under one of: ${allowedRoots.join(', ')} — add a new root with 'sudo ritsu path add'`,
    });
    return false;
  }
  return true;
}

/** Filter the request's permissions down to known values, defaulting to
 *  `['read']` when omitted. Returns null after responding 400 if the
 *  resulting set is empty. */
function parseWorkspacePerms(perms: ReadonlyArray<Permission> | undefined, res: Response): Permission[] | null {
  const cleanPerms = (perms ?? ['read']).filter(p => PERMISSION_VALUES.includes(p));
  if (cleanPerms.length === 0) {
    res.status(400).json({ error: `permissions must be a non-empty subset of ${PERMISSION_VALUES.join(', ')}` });
    return null;
  }
  return cleanPerms;
}

/** Best-effort mkdir -p of `target`. Returns true on success / already-exists,
 *  or false after responding 400 with the OS error — silently storing an
 *  unusable workspace row would be worse than failing loud. */
function ensureWorkspaceDirExists(target: string, res: Response): boolean {
  if (existsSync(target)) return true;
  try {
    mkdirSync(target, { recursive: true });
    return true;
  } catch (err) {
    res.status(400).json({ error: `cannot create ${target}`, detail: (err as Error).message });
    return false;
  }
}

/**
 * Standalone admin app. Bound to ADMIN_PORT (localhost-only by default).
 * No auth on the admin surface itself — operator-tier UI, not exposed.
 *
 * Surfaces:
 *   GET    /admin                        UI
 *   GET    /admin/api/info               version, auth mode, log level, counts
 *   GET    /admin/api/log-level          current level
 *   POST   /admin/api/log-level          { level }
 *   GET    /admin/api/events/recent      JSON snapshot of the in-memory ring
 *   GET    /admin/api/events/stream      SSE live tail of log events
 *
 *   GET    /admin/agents                 list agent definitions
 *   GET    /admin/agents/types           registered agent class keys
 *   GET    /admin/agents/:id             read one
 *   POST   /admin/agents                 create
 *   PATCH  /admin/agents/:id             update
 *   DELETE /admin/agents/:id             delete (DB row + live instance)
 *   POST   /admin/agents/:id/reload      explicit rebuild
 *
 *   GET    /admin/api/tokens             list tokens (no secrets)
 *   POST   /admin/api/tokens             mint (returns plaintext token ONCE)
 *   POST   /admin/api/tokens/:id/revoke  mark revoked
 *   DELETE /admin/api/tokens/:id         delete (only allowed after revoke)
 *   GET    /admin/api/tokens/:id/usage   recent audit rows for one token
 */
export function createAdminApp(deps: AdminDeps) {
  const { defStore, host, tokens, workspaces, pluginHost, memory, conversations, approvals, commsDenials, secrets, backup, projects, skills, prompts } = deps;

  /** Secrets are unwritable without a master key. Answering with the reason
   *  beats a 500 whose cause is only visible in the journal. */
  function keyMissing(res: Response): boolean {
    const st = masterKeyStatus();
    if (st.ok) return false;
    res.status(503).json({ error: st.detail ?? 'no master key — secrets cannot be stored' });
    return true;
  }
  const app = express();
  app.disable('x-powered-by');
  // Behind a loopback reverse proxy. Trust it so req.ip is the real client, not
  // 127.0.0.1 — otherwise the per-IP rate limiter collapses to one global bucket
  // and every audit row logs the proxy's address instead of the caller's.
  app.set('trust proxy', 'loopback');

  // ---- security headers --------------------------------------------------
  // Strict CSP for the admin UI: the page only loads same-origin scripts/
  // styles/images. No remote CDNs, no inline `eval`, no `data:` images
  // (admin UI uses inline data:image/svg+xml for glyphs — allow only that
  // narrow shape). Headers go on every response, including 404s.
  app.use((req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        // The admin UI's JS now lives in /admin/app.js (a same-origin static
        // asset) and every DOM handler routes through data-action delegation,
        // so no inline <script> blocks or onclick= attributes survive. That
        // lets us drop 'unsafe-inline' from script-src — the load-bearing
        // mitigation against script-injection XSS.
        //
        // style-src is also strict: the inline <style> block moved to
        // /admin/app.css and every style="…" attribute (static + JS-built
        // innerHTML) is gone in favor of utility/component classes. The
        // per-agent glyph hue uses data-hue-idx + 8 discrete CSS rules
        // instead of an inline color. JS-set element.style.foo writes
        // (visualViewport sync, transcript padding) aren't covered by
        // style-src, so they don't need 'unsafe-inline'.
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "font-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ].join('; '),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // HSTS only when the client reached us over TLS. If a reverse proxy
    // is terminating TLS, it sets X-Forwarded-Proto=https; if ritsu is
    // direct, req.secure reflects the listener. Sending HSTS on a plain-
    // http response would be ignored by browsers but might confuse curl
    // pipelines, so we gate it.
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  // NB: JSON body parsing is deliberately mounted LATER, after admin auth —
  // an unauthenticated request must not be able to make the large /ask parser
  // buffer its body. See the body-parser block below the auth middleware.

  // ---- per-IP rate limit on the admin API + agent-lifecycle routes ------
  // Tiny in-memory token-bucket. Defends against credential-stuffing on the
  // admin token, accidental hot loops from a buggy client, and trivial DoS.
  // Covers /admin/api AND /admin/agents (create/delete/ask, incl. the large
  // image-paste /ask body). Health endpoints (/healthz, /readyz, /version,
  // /metrics) are intentionally exempted so monitors can hammer them.
  const adminLimiter = new RateLimiter(60_000, 240);  // 4/sec average, room for UI bursts
  const rateLimiter = (req: Request, res: Response, next: () => void): void => {
    const retryAfter = adminLimiter.hit(req.ip ?? req.socket.remoteAddress ?? 'unknown');
    if (retryAfter === null) { next(); return; }
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'rate limit exceeded', retry_after_s: retryAfter });
  };
  app.use('/admin/api', rateLimiter);
  app.use('/admin/agents', rateLimiter);

  // ---- standard server endpoints (no auth) -------------------------------
  // These are the only endpoints on this app that DON'T require the admin
  // token — they're for monitoring (k8s probes, Prometheus, watchdogs)
  // and need to be hit without distributing a secret. They live here
  // rather than on the MCP port so the MCP port serves only the protocol
  // surface; see src/mcp-server.ts. MCP-level health is the protocol
  // `ping` JSON-RPC method (sent to /mcp), not an HTTP endpoint.

  const startedAt = Math.floor(Date.now() / 1000);

  app.get('/healthz', (_req, res) => {
    // Minimal liveness — "is the process listening and answering."
    // Returns 200 unconditionally; the existence of a response IS the signal.
    res.json({
      status: 'ok',
      name: 'ritsu',
      version: deps.version,
      uptime_s: Math.floor(process.uptime()),
    });
  });

  app.get('/readyz', (_req, res) => {
    // Deeper readiness — "is the server actually able to serve traffic."
    // Catches conditions where the process is up but the agent host or
    // DB isn't (rare with our synchronous-init shape, but documented).
    try {
      const agents = host.list();
      res.json({
        status: 'ready',
        name: 'ritsu',
        version: deps.version,
        uptime_s: Math.floor(process.uptime()),
        agents_loaded: agents.length,
      });
    } catch (err) {
      res.status(503).json({
        status: 'degraded',
        error: (err as Error).message,
        uptime_s: Math.floor(process.uptime()),
      });
    }
  });

  app.get('/version', (_req, res) => {
    res.json({
      name: 'ritsu',
      version: deps.version,
      node: process.version,
      started_at: startedAt,
      uptime_s: Math.floor(process.uptime()),
      mcp_tools: TOOL_NAMES,
      auth_mode: deps.authMode,
      auth_effective: deps.authMode === 'on' || (deps.authMode === 'auto' && tokens.hasAnyActive('mcp'))
        ? 'required'
        : 'open',
    });
  });

  // Prometheus-format metrics. Gauges that depend on store state are computed
  // per-scrape; counters live in the metrics registry. Stays open so a
  // scraper on localhost (node_exporter etc.) doesn't need an admin token.
  app.get('/metrics', metricsHandler(() => ({
    ritsu_agents_total: host.list().length,
    ritsu_active_tokens_total: tokens.list('mcp').filter(t => !t.revoked_at).length,
  })));

  // ---- ADMIN BEARER AUTH -------------------------------------------------
  // Everything under /admin (UI + every API endpoint) requires an
  // admin-scoped token. The token is bootstrapped at first boot and lives
  // at /etc/ritsu/admin-token on disk; the operator pastes it into the UI
  // (sessionStorage) or sends it as `Authorization: Bearer rt_...`.
  //
  // /healthz and /metrics above stay open so monitoring works without a
  // secret distributed to scrapers.

  app.use('/admin', (req: Request, res: Response, next) => {
    // Let the UI HTML and its sidecar JS load freely — they're static
    // chrome with no secrets, and the page itself prompts the operator
    // for a token on first API call. Standard SPA pattern. Every actual
    // data endpoint below is gated; without a valid token they return 401.
    //
    // (Express mounts paths relative to the mount point: GET /admin
    // arrives here as req.path '/'. With trailing slash → '/index.html'.)
    if (req.path === '/' || req.path === '/index.html' || req.path === '/app.js' || req.path === '/app.css'
      || req.path === '/workspace' || req.path === '/workspace.js' || req.path === '/workspace.css'
      || req.path === '/ops' || req.path === '/ops.js' || req.path === '/ops.css'
      || req.path.startsWith('/vendor/')
      || req.path.startsWith('/plugins/')) {
      next();
      return;
    }
    // Tolerate two equally-valid presentation styles:
    //   - Authorization: Bearer rt_...
    //   - X-Ritsu-Admin-Token: rt_...   (easier for browsers via header injection)
    const header = req.headers.authorization;
    const xToken = req.headers['x-ritsu-admin-token'];
    let token: string | undefined;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      token = header.slice('Bearer '.length).trim();
    } else if (typeof xToken === 'string') {
      token = xToken.trim();
    }
    if (!token) {
      res.status(401).json({ error: 'admin token required', hint: 'cat /opt/ritsu/data/.admin-token on the server' });
      return;
    }
    const row = tokens.verify(token, 'admin');
    if (!row) {
      res.status(401).json({ error: 'invalid or revoked admin token' });
      return;
    }
    // Stash the verified token id on the request so the audit middleware can
    // attribute mutating actions to who took them.
    (req as Request & { adminTokenId?: number }).adminTokenId = row.id;
    next();
  });

  // ---- JSON body parsing (AFTER auth) ------------------------------------
  // Mounted here, not earlier, so an UNAUTHENTICATED request is rejected by
  // the admin-auth middleware above BEFORE the parser buffers its body —
  // otherwise a single anonymous POST to /ask could make the 32MB parser
  // allocate 32MB of RAM per request (a trivial pre-auth DoS).
  //
  // 256kb is plenty for admin payloads (agent system prompts can be long but
  // not megabyte-long). The one exception is POST /ask, which can carry
  // operator-pasted images (base64); it gets a cap matching what AskBody
  // already enforces (≤4 images × ~6.8MB base64 ≈ 27MB) so the zod validator —
  // not the body parser — is the gate that rejects oversize attachments (with
  // a clean JSON error instead of a raw 413). Both caps stop a misbehaving
  // client from blowing up RAM.
  const jsonDefault = express.json({ limit: '256kb' });
  const jsonAsk = express.json({ limit: '32mb' });
  app.use((req, res, next) =>
    req.method === 'POST' && (req.path.endsWith('/ask') || req.path.endsWith('/files'))
      ? jsonAsk(req, res, next)
      : jsonDefault(req, res, next),
  );

  // ---- admin action audit ------------------------------------------------
  // Runs after the auth middleware (so we have the token id) and only for
  // mutating verbs. Mounted on BOTH /admin/api AND /admin/agents — the
  // agent-lifecycle routes (create/delete/update/reload/ask, workspace
  // create/delete) live under /admin/agents and are the highest-impact admin
  // actions, so they must be in the audit trail too. Writes on response finish.
  type DbHandle = { prepare(s: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } };
  const auditDb = (deps.host as unknown as { db: DbHandle }).db;
  const auditMiddleware = (req: Request, res: Response, next: () => void): void => {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') { next(); return; }
    const t0 = Date.now();
    const ip = req.ip ?? req.socket.remoteAddress ?? null;
    const tokenId = (req as Request & { adminTokenId?: number }).adminTokenId ?? null;
    // Hash the body NOT for confidentiality (it's not stored anyway) but for
    // tamper-evidence: an auditor can replay a known request and confirm the
    // hash matches the row.
    let bodySha256: string | null = null;
    try {
      const bodyText = req.body ? JSON.stringify(req.body) : '';
      if (bodyText) bodySha256 = createHash('sha256').update(bodyText).digest('hex');
    } catch { /* swallow — audit must never break the request */ }
    // originalUrl gives the full path; req.path is relative to the mount.
    const auditedPath = req.originalUrl.split('?')[0];
    res.on('finish', () => {
      try {
        auditDb.prepare(
          `INSERT INTO admin_audit (token_id, ip, method, path, status, body_sha256, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(tokenId, ip, method, auditedPath, res.statusCode, bodySha256, Date.now() - t0);
      } catch (err) {
        logger.warn('admin.audit.write-failed', { err: (err as Error).message });
      }
    });
    next();
  };
  app.use('/admin/api', auditMiddleware);
  app.use('/admin/agents', auditMiddleware);

  // List recent admin actions. Read-only.
  app.get('/admin/api/audit', (req: Request, res: Response) => {
    const limit = clampLimit(req.query.limit, 100, 500);
    const rows = auditDb.prepare(
      `SELECT a.id, a.ts, a.token_id, t.name AS token_name, a.ip, a.method, a.path,
              a.status, a.body_sha256, a.duration_ms
         FROM admin_audit a
         LEFT JOIN mcp_tokens t ON t.id = a.token_id
        ORDER BY a.id DESC
        LIMIT ?`,
    ).all(limit);
    res.json({ audit: rows });
  });

  app.get('/admin/api/info', (_req: Request, res: Response) => {
    res.json({
      // Drives the header warning: no key means every secret write fails.
      master_key_ok: masterKeyStatus().ok,
      name: 'ritsu',
      version: deps.version,
      auth_mode: deps.authMode,
      auth_effective: deps.authMode === 'on' || (deps.authMode === 'auto' && tokens.hasAnyActive('mcp'))
        ? 'required'
        : 'open',
      log_level: logger.getLevel(),
      agent_count: host.list().length,
      active_token_count: tokens.list('mcp').filter(t => !t.revoked_at).length,
    });
  });

  // ---- UI ----------------------------------------------------------------

  // Read the three static admin assets ONCE at boot and serve from memory
  // every request after. Two wins:
  //   1. No per-request filesystem access. CodeQL was flagging the
  //      readFileSync handlers as "FS access on a non-rate-limited
  //      route" — closing the FS gadget eliminates the finding entirely.
  //   2. ~80KB * N requests no longer hits disk. Negligible CPU on a
  //      laptop, but it's the obvious right shape for a static SPA.
  // The build step copies these files into dist/admin/ before the
  // service boots; missing-file means the build is broken, so we fail
  // loud at startup rather than 500ing every request.
  const uiHtml = (() => {
    const p = join(__dirname, 'ui.html');
    if (!existsSync(p)) throw new Error(`admin/ui.html missing at ${p} — run \`npm run build\``);
    return readFileSync(p, 'utf8');
  })();
  const uiJs = (() => {
    const p = join(__dirname, 'app.js');
    if (!existsSync(p)) throw new Error(`admin/app.js missing at ${p} — run \`npm run build\``);
    return readFileSync(p, 'utf8');
  })();
  const uiCss = (() => {
    const p = join(__dirname, 'app.css');
    if (!existsSync(p)) throw new Error(`admin/app.css missing at ${p} — run \`npm run build\``);
    return readFileSync(p, 'utf8');
  })();

  const wsHtml = (() => {
    const p = join(__dirname, 'workspace.html');
    if (!existsSync(p)) throw new Error(`admin/workspace.html missing at ${p} — run \`npm run build\``);
    return readFileSync(p, 'utf8');
  })();
  const wsJs = (() => {
    const p = join(__dirname, 'workspace.js');
    if (!existsSync(p)) throw new Error(`admin/workspace.js missing at ${p} — run \`npm run build\``);
    return readFileSync(p, 'utf8');
  })();
  const wsCss = (() => {
    const p = join(__dirname, 'workspace.css');
    if (!existsSync(p)) throw new Error(`admin/workspace.css missing at ${p} — run \`npm run build\``);
    return readFileSync(p, 'utf8');
  })();

  const opsHtml = (() => {
    const p = join(__dirname, 'ops.html');
    if (!existsSync(p)) throw new Error(`admin/ops.html missing at ${p} — run \`npm run build\``);
    return readFileSync(p, 'utf8');
  })();
  const opsJs = (() => {
    const p = join(__dirname, 'ops.js');
    if (!existsSync(p)) throw new Error(`admin/ops.js missing at ${p} — run \`npm run build\``);
    return readFileSync(p, 'utf8');
  })();
  const opsCss = (() => {
    const p = join(__dirname, 'ops.css');
    if (!existsSync(p)) throw new Error(`admin/ops.css missing at ${p} — run \`npm run build\``);
    return readFileSync(p, 'utf8');
  })();

  // Vendored render libraries (mermaid/KaTeX) — boot-scanned into memory like
  // the other UI assets; the filename map IS the allowlist, so no path from
  // the request ever touches the filesystem.
  const vendorFiles = (() => {
    const dir = join(__dirname, 'vendor');
    const out = new Map<string, { data: Buffer; type: string }>();
    if (!existsSync(dir)) return out;
    const typeOf = (n: string) =>
      n.endsWith('.js') ? 'application/javascript'
        : n.endsWith('.css') ? 'text/css'
          : n.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
    for (const name of readdirSync(dir)) {
      const fp = join(dir, name);
      if (statSync(fp).isFile() && /\.(js|css)$/.test(name)) {
        out.set(name, { data: readFileSync(fp), type: typeOf(name) });
      }
    }
    const fontsDir = join(dir, 'fonts');
    if (existsSync(fontsDir)) {
      for (const name of readdirSync(fontsDir)) {
        if (name.endsWith('.woff2')) {
          out.set(`fonts/${name}`, { data: readFileSync(join(fontsDir, name)), type: 'font/woff2' });
        }
      }
    }
    return out;
  })();

  app.get(['/admin/vendor/:file', '/admin/vendor/fonts/:file'], (req: Request, res: Response) => {
    const key = req.path.startsWith('/admin/vendor/fonts/')
      ? `fonts/${param(req.params.file)}`
      : param(req.params.file);
    const hit = vendorFiles.get(key);
    if (!hit) { res.status(404).end(); return; }
    // These change only on a deliberate version bump — let the browser keep
    // them for a day instead of re-pulling 4MB per visit.
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type(hit.type).send(hit.data);
  });

  function setNoCache(res: Response): void {
    // Mobile Safari is notoriously eager to serve stale assets across
    // ritsu releases; these headers force a fresh fetch on every visit.
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  app.get('/admin', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    setNoCache(res);
    res.send(uiHtml);
  });

  app.get('/admin/app.js', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    setNoCache(res);
    res.send(uiJs);
  });

  app.get('/admin/app.css', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    setNoCache(res);
    res.send(uiCss);
  });

  // The agent-workspace page — the chat-first main surface. The classic admin
  // panel stays at /admin; the root of the admin port lands here.
  app.get('/', (_req: Request, res: Response) => { res.redirect('/admin/workspace'); });
  app.get('/admin/workspace', (_req: Request, res: Response) => {
    setNoCache(res);
    res.type('html').send(wsHtml);
  });
  app.get('/admin/workspace.js', (_req: Request, res: Response) => {
    setNoCache(res);
    res.type('application/javascript').send(wsJs);
  });
  app.get('/admin/workspace.css', (_req: Request, res: Response) => {
    setNoCache(res);
    res.type('text/css').send(wsCss);
  });

  // The operations board — approvals, jobs, channels, health, live logs on
  // one "watch" surface. Same static-chrome model as the other two pages.
  app.get('/admin/ops', (_req: Request, res: Response) => {
    setNoCache(res);
    res.type('html').send(opsHtml);
  });
  app.get('/admin/ops.js', (_req: Request, res: Response) => {
    setNoCache(res);
    res.type('application/javascript').send(opsJs);
  });
  app.get('/admin/ops.css', (_req: Request, res: Response) => {
    setNoCache(res);
    res.type('text/css').send(opsCss);
  });

  // ---- log level ---------------------------------------------------------

  app.get('/admin/api/log-level', (_req: Request, res: Response) => {
    res.json({ level: logger.getLevel() });
  });

  app.post('/admin/api/log-level', (req: Request, res: Response) => {
    const body = parseBody(req, res, LogLevelBody);
    if (!body) return;
    logger.setLevel(body.level);
    res.json({ level: logger.getLevel() });
  });

  // ---- log events --------------------------------------------------------

  app.get('/admin/api/events/recent', (req: Request, res: Response) => {
    const limit = clampLimit(req.query.limit, 200, 1000);
    res.json({ events: eventBus.recent(limit) });
  });

  app.get('/admin/api/events/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const onEntry = (entry: unknown): void => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };
    eventBus.on('entry', onEntry);
    const ping = setInterval(() => res.write(': keepalive\n\n'), 20_000);

    req.on('close', () => {
      clearInterval(ping);
      eventBus.off('entry', onEntry);
    });
  });

  // Live conversation events — message appends + ask-start/ask-end typing
  // signals. The slide-in chat panel subscribes when open so messages sent
  // from another tab / phone / MCP caller / agent-to-agent flow appear
  // without a manual refresh, and the typing indicator follows whoever is
  // currently asking (even if that's another session).
  app.get('/admin/api/conversations/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const onEvent = (ev: ConversationEvent): void => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    conversationBus.on('event', onEvent);
    const ping = setInterval(() => res.write(': keepalive\n\n'), 20_000);

    req.on('close', () => {
      clearInterval(ping);
      conversationBus.off('event', onEvent);
    });
  });

  // ---- approvals (human-in-the-loop) -------------------------------------
  // A gated tool call blocks the agent's turn on a pending row here; the
  // operator approves/rejects from the Approvals tab or an inline card in
  // the chat panel. Both surfaces share these endpoints + the SSE feed.

  // ?state=pending (default) | decided | all. Pending is sorted oldest-first
  // (work queue); decided is newest-first (recent history).
  app.get('/admin/api/approvals', (req: Request, res: Response) => {
    const limit = clampLimit(req.query.limit, 200, 1000);
    const state = typeof req.query.state === 'string' ? req.query.state : 'pending';
    const convo = req.query.conversation_id !== undefined ? Number(req.query.conversation_id) : undefined;
    if (convo !== undefined) {
      if (!Number.isInteger(convo)) { res.status(400).json({ error: 'conversation_id must be integer' }); return; }
      res.json({ approvals: approvals.listPendingForConversation(convo) });
      return;
    }
    if (state === 'decided') { res.json({ approvals: approvals.listDecided(limit) }); return; }
    if (state === 'all') {
      res.json({ approvals: [...approvals.listPending(limit), ...approvals.listDecided(limit)] });
      return;
    }
    res.json({ approvals: approvals.listPending(limit) });
  });

  // Lightweight count for the nav badge. Cheap COUNT(*); polled as a fallback
  // when SSE isn't connected.
  app.get('/admin/api/approvals/count', (_req: Request, res: Response) => {
    res.json({ pending: approvals.pendingCount() });
  });

  // Blocked inter-agent calls (ask_agent refused by a guard). Recent-first.
  // Live updates ride the approvals SSE stream as {kind:'comms-denied'} events.
  app.get('/admin/api/comms-denials', (req: Request, res: Response) => {
    const limit = clampLimit(req.query.limit, 100, 500);
    res.json({ denials: commsDenials.listRecent(limit) });
  });

  app.get('/admin/api/approvals/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const onEvent = (ev: ApprovalEvent): void => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    approvalBus.on('event', onEvent);
    const ping = setInterval(() => res.write(': keepalive\n\n'), 20_000);

    req.on('close', () => {
      clearInterval(ping);
      approvalBus.off('event', onEvent);
    });
  });

  app.post('/admin/api/approvals/:id/decide', (req: Request, res: Response) => {
    const id = Number(param(req.params.id));
    if (!Number.isInteger(id)) { res.status(400).json({ error: 'id must be integer' }); return; }
    const body = parseBody(req, res, ApprovalDecideBody);
    if (!body) return;
    const decided = approvals.decide(id, body.decision, body.reason ?? null, 'admin-ui');
    if (!decided) {
      // Either unknown id or already decided (double-click / race). 409 so the
      // UI can refetch + show the now-final state rather than treat as success.
      res.status(409).json({ error: 'approval not found or already decided' });
      return;
    }
    res.json({ approval: decided });
  });

  // ---- secrets (extension credentials) -----------------------------------
  // Operator-only. Values are encrypted at rest and NEVER returned by the API
  // — list shows metadata + which fields are set, set/delete mutate. The
  // email extension reads these in-process; the model never sees them.

  app.get('/admin/api/secrets', (_req: Request, res: Response) => {
    // Group metadata by namespace + advertise the expected keys per known
    // connector so the UI can render a form that shows what's set vs missing.
    const all = secrets.list();
    const setKeys = new Set(all.map(s => `${s.namespace}:${s.name}`));
    res.json({
      secrets: all,
      connectors: [
        {
          namespace: EMAIL_NS,
          label: 'Email (IMAP + SMTP)',
          keys: EMAIL_SECRET_KEYS.map(k => ({ name: k, set: setKeys.has(`${EMAIL_NS}:${k}`) })),
        },
        {
          namespace: TWITTER_NS,
          label: 'X / Twitter (OAuth 1.0a)',
          keys: TWITTER_SECRET_KEYS.map(k => ({ name: k, set: setKeys.has(`${TWITTER_NS}:${k}`) })),
        },
        {
          namespace: LINKEDIN_NS,
          label: 'LinkedIn (OAuth 2.0, publish-only)',
          keys: LINKEDIN_SECRET_KEYS.map(k => ({ name: k, set: setKeys.has(`${LINKEDIN_NS}:${k}`) })),
        },
        {
          namespace: FLASHBACK_NS,
          label: 'Flashback (memory backend)',
          keys: FLASHBACK_SECRET_KEYS.map(k => ({ name: k, set: setKeys.has(`${FLASHBACK_NS}:${k}`) })),
        },
        {
          namespace: LITELLM_NS,
          label: 'LiteLLM proxy',
          keys: LITELLM_SECRET_KEYS.map(k => ({ name: k, set: setKeys.has(`${LITELLM_NS}:${k}`) })),
        },
        {
          namespace: INGEST_NS,
          label: 'Ingest / vision model',
          keys: INGEST_SECRET_KEYS.map(k => ({ name: k, set: setKeys.has(`${INGEST_NS}:${k}`) })),
        },
      ],
    });
  });

  app.post('/admin/api/secrets', (req: Request, res: Response) => {
    if (keyMissing(res)) return;
    const body = parseBody(req, res, SecretSetBody);
    if (!body) return;
    secrets.set(body.namespace, body.name, body.value);
    res.json({ ok: true, namespace: body.namespace, name: body.name });
  });

  app.delete('/admin/api/secrets/:namespace/:name', (req: Request, res: Response) => {
    const removed = secrets.delete(param(req.params.namespace), param(req.params.name));
    res.status(removed ? 204 : 404).end();
  });

  // ---- agents ------------------------------------------------------------

  app.get('/admin/agents/types', (_req: Request, res: Response) => {
    res.json({ types: Object.keys(AGENT_TYPES) });
  });

  app.get('/admin/agents', async (_req: Request, res: Response) => {
    const defs = await defStore.list();
    // Decorate each with last_used_at (max ts across mcp_token_usage + conversations).
    // Cheap enough for the admin agents list; if it grows we can add an index/cache.
    res.json({ agents: defs.map(d => ({ ...d, last_used_at: lastUsedFor(d.id) })) });
  });

  app.get('/admin/agents/:id', async (req: Request, res: Response) => {
    const def = await defStore.read(param(req.params.id));
    if (!def) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(def);
  });

  /** A save that silently drops a gate is the failure mode worth shouting
   *  about: the operator ticked a box and believes the tool is held. */
  function ungateableWarning(id: string): string | undefined {
    const tools = host.ungateableFor(id);
    if (!tools.length) return undefined;
    return `approval_tools names ${tools.join(', ')}, which the direct runtime cannot enforce — ` +
      'the vendor SDK runs its own built-ins without consulting the gate. ' +
      'Switch the agent to the api runtime, or remove those tools from its allowlist.';
  }

  app.post('/admin/agents', async (req: Request, res: Response) => {
    try {
      const def = AgentDefinitionSchema.parse(req.body);
      const existing = await defStore.read(def.id);
      if (existing) {
        res.status(409).json({ error: `agent ${def.id} already exists; use PATCH` });
        return;
      }
      const saved = await defStore.upsert(def);
      host.addOrReplace(saved);
      res.status(201).json({ ...saved, warning: ungateableWarning(saved.id) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.patch('/admin/agents/:id', async (req: Request, res: Response) => {
    try {
      const current = await defStore.read(param(req.params.id));
      if (!current) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const patch = AgentDefinitionPatchSchema.parse(req.body);
      const merged = AgentDefinitionSchema.parse({ ...current, ...patch, id: current.id });
      const saved = await defStore.upsert(merged);
      host.addOrReplace(saved);
      res.json({ ...saved, warning: ungateableWarning(saved.id) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/admin/agents/:id', async (req: Request, res: Response) => {
    const removed = await defStore.delete(param(req.params.id));
    host.remove(param(req.params.id));
    res.status(removed ? 204 : 404).end();
  });

  app.post('/admin/agents/:id/reload', async (req: Request, res: Response) => {
    const def = await defStore.read(param(req.params.id));
    if (!def) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    host.addOrReplace(def);
    res.json({ reloaded: def.id });
  });

  app.post('/admin/agents/:id/revert', async (req: Request, res: Response) => {
    try {
      const reverted = await defStore.revert(param(req.params.id));
      host.addOrReplace(reverted);
      res.json(reverted);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ---- tiles (dashboard) -------------------------------------------------
  // One blob-per-agent designed for the at-a-glance Tiles tab. Computed
  // per-request from existing tables — no schema change. Suitable for
  // polling at 10s intervals; if traffic ever justifies it, push to SSE.

  app.get('/admin/api/agents/tiles', async (_req: Request, res: Response) => {
    const defs = await defStore.list();
    const now = Math.floor(Date.now() / 1000);
    const tiles = defs.map(def => {
      const lastUsedAt = lastUsedFor(def.id);
      const summaries = conversations.listSummaries(def.id, 10);
      const recent24h = summaries.filter(s => s.started_at > now - 24 * 3600).length;
      // "active" = had a turn in the last 90 seconds. Tiny window because
      // every Claude SDK call takes seconds; longer windows would falsely
      // show an idle agent as "active".
      const active = lastUsedAt !== null && lastUsedAt > now - 90;
      const latest = summaries[0]
        ? { id: summaries[0].id, started_at: summaries[0].started_at, title: summaries[0].title, message_count: summaries[0].message_count }
        : null;
      return {
        id: def.id,
        name: def.name,
        model: def.model,
        runtime: def.runtime,
        provider: def.provider,
        enabled: !!def.enabled,
        active,
        last_activity_ts: lastUsedAt,
        recent_24h: recent24h,
        latest_conversation: latest,
      };
    });
    res.json({ tiles, server_now: now });
  });

  /**
   * One-shot ask. Same path MCP's ask_agent tool takes — same agent instance,
   * same conversation persistence. The Tiles panel calls this with an
   * optional conversation_id to thread; omit to start fresh.
   */
  /** Titles land only on untitled chats with exactly one exchange, and only
   *  when a task endpoint is configured (secrets ns 'ingest') — otherwise the
   *  derived first-60-chars title stands, as always. */
  async function autoTitle(cid: number, userMsg: string, reply: string): Promise<void> {
    const endpoint = secrets.get(INGEST_NS, 'endpoint')?.trim();
    if (!endpoint || !userMsg) return;
    const sm = conversations.listSummaries(undefined, 10_000, 'human').find(x => x.id === cid);
    if (!sm || sm.message_count > 2) return;
    const raw = (host as unknown as { db: { prepare(q: string): { get(...a: unknown[]): unknown } } }).db
      .prepare('SELECT title FROM conversations WHERE id = ?').get(cid) as { title: string | null } | undefined;
    if (raw?.title?.trim()) return;   // operator already named it
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    try {
      const res = await fetch(`${endpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: ctl.signal,
        headers: {
          'content-type': 'application/json',
          ...(secrets.get(INGEST_NS, 'api_key')?.trim()
            ? { authorization: `Bearer ${secrets.get(INGEST_NS, 'api_key')!.trim()}` } : {}),
        },
        body: JSON.stringify({
          model: secrets.get(INGEST_NS, 'model')?.trim() || 'qwen2.5-vl',
          temperature: 0,
          messages: [
            { role: 'system', content: 'Name this conversation in at most six words. Reply with ONLY the title — no quotes, no punctuation at the end.' },
            { role: 'user', content: `User: ${userMsg.slice(0, 2000)}\n\nAssistant: ${reply.slice(0, 2000)}` },
          ],
        }),
      });
      if (!res.ok) return;
      const json = await res.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const title = typeof json.choices?.[0]?.message?.content === 'string'
        ? json.choices[0].message.content.trim().replace(/^["']|["']$/g, '').slice(0, 80) : '';
      if (title) conversations.setTitle(cid, title);
    } finally {
      clearTimeout(timer);
    }
  }

  app.post('/admin/agents/:id/ask', async (req: Request, res: Response) => {
    const def = await defStore.read(param(req.params.id));
    if (!def) {
      res.status(404).json({ error: 'agent not found' });
      return;
    }
    if (!def.enabled) {
      res.status(409).json({ error: `agent ${def.id} is disabled` });
      return;
    }
    const ask = parseBody(req, res, AskBody);
    if (!ask) return;
    const { message, conversation_id, attachments, parent_message_id } = ask;
    // Resolve the conversation up-front so the typing-dot SSE events
    // carry the same id as the message events that follow. If the
    // caller didn't supply one, this is the canonical human thread the
    // agent will use anyway (see SqliteConversationStore.findOrStart…).
    const resolvedConvoId = conversation_id ?? conversations.findOrStartHumanThread(def.id);
    conversationBus.publish({
      kind: 'ask-start',
      conversation_id: resolvedConvoId,
      agent_id: def.id,
      ts: Math.floor(Date.now() / 1000),
    });
    try {
      const t0 = Date.now();
      // Admin calls always come from "the user" — there's one operator and no
      // need to differentiate which device/token. The UI hides the byline
      // entirely for this constant, since whoever's reading the transcript
      // IS the admin.
      const r = await host.get(def.id).onMessage({
        message, conversation_id: resolvedConvoId, caller_label: 'admin-ui', attachments,
        ...(parent_message_id !== undefined ? { parent_message_id } : {}),
      });
      // Auto-title: a cheap task model (the ingest endpoint, when configured)
      // names the chat after its first exchange — fire-and-forget, never
      // blocking the reply, never touching a manually-set title.
      autoTitle(resolvedConvoId, message, r.reply).catch(() => undefined);
      res.json({ ...r, duration_ms: Date.now() - t0 });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    } finally {
      conversationBus.publish({
        kind: 'ask-end',
        conversation_id: resolvedConvoId,
        agent_id: def.id,
        ts: Math.floor(Date.now() / 1000),
      });
    }
  });

  // ---- conversations + memories (read-only browse) -----------------------

  app.get('/admin/api/conversations', (req: Request, res: Response) => {
    const agentId = (req.query.agent_id as string | undefined) ?? undefined;
    const involves = (req.query.involves as string | undefined) ?? undefined;
    const limit = clampLimit(req.query.limit, 100, 500);
    const rawKind = typeof req.query.kind === 'string' ? req.query.kind : 'all';
    const kind = rawKind === 'human' || rawKind === 'agent' ? rawKind : 'all';
    res.json({ conversations: conversations.listSummaries(agentId, limit, kind, involves) });
  });

  // Canonical human ↔ agent thread for an agent. Returns the id of the single
  // long-running thread (creating it the first time). The slide-in chat panel
  // uses this so opening it never spawns a new conversation.
  app.get('/admin/api/agents/:id/canonical-thread', (req: Request, res: Response) => {
    const id = param(req.params.id);
    const cid = conversations.findOrStartHumanThread(id);
    res.json({ id: cid });
  });

  app.get('/admin/api/conversations/:id', (req: Request, res: Response) => {
    const id = Number(param(req.params.id));
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'id must be integer' });
      return;
    }
    const limit = clampLimit(req.query.limit, 500, 2000);
    res.json({ messages: conversations.recent(id, limit) });
  });

  app.get('/admin/api/memories', async (req: Request, res: Response) => {
    const agentId = req.query.agent_id as string | undefined;
    if (!agentId) {
      res.status(400).json({ error: 'agent_id required' });
      return;
    }
    const limit = clampLimit(req.query.limit, 100, 500);
    res.json({ memories: await memory.list(agentId, limit) });
  });

  /** Operator-side memory CRUD. Mirrors the per-agent mcp__memory__* tools
   *  but talks straight to the store with no agent in the loop, so the
   *  operator can seed initial knowledge, hand-edit, or hand-delete. */
  app.post('/admin/api/memories', async (req: Request, res: Response) => {
    const body = parseBody(req, res, MemoryCreateBody);
    if (!body) return;
    const id = await memory.write({ agent_id: body.agent_id, content: body.content });
    const saved = await memory.read(id);
    res.status(201).json(saved);
  });

  app.patch('/admin/api/memories/:id', async (req: Request, res: Response) => {
    const oldId = Number(param(req.params.id));
    if (!Number.isInteger(oldId)) { res.status(400).json({ error: 'id must be integer' }); return; }
    const old = await memory.read(oldId);
    if (!old) { res.status(404).json({ error: 'not found' }); return; }
    const body = parseBody(req, res, MemoryPatchBody);
    if (!body) return;
    const newId = await memory.write({ agent_id: old.agent_id, content: body.content, supersedes: oldId });
    const saved = await memory.read(newId);
    res.json(saved);
  });

  app.delete('/admin/api/memories/:id', async (req: Request, res: Response) => {
    const id = Number(param(req.params.id));
    if (!Number.isInteger(id)) { res.status(400).json({ error: 'id must be integer' }); return; }
    const ok = await memory.delete(id);
    res.status(ok ? 204 : 404).end();
  });

  app.get('/admin/api/memories/:id/lineage', async (req: Request, res: Response) => {
    const id = Number(param(req.params.id));
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'id must be integer' });
      return;
    }
    res.json({ lineage: await memory.lineage(id) });
  });

  // ---- workspaces --------------------------------------------------------

  app.get('/admin/api/tools/available', (_req: Request, res: Response) => {
    res.json({ tools: AVAILABLE_TOOLS });
  });

  /**
   * GET /admin/api/system/writable-roots — the set of absolute paths the
   * systemd sandbox allows ritsu to write to (base unit's ReadWritePaths
   * merged with every drop-in). The admin UI's workspace picker uses this
   * to constrain the root dropdown — operators can't add a workspace
   * outside the sandbox and then watch it silently fail at runtime.
   */
  app.get('/admin/api/system/writable-roots', (_req: Request, res: Response) => {
    const r = spawnSync('systemctl', ['show', 'ritsu.service', '-p', 'ReadWritePaths', '--value'], {
      encoding: 'utf8',
    });
    const roots = r.status === 0
      ? r.stdout.trim().split(/\s+/).filter(Boolean)
      : [];
    res.json({ roots });
  });

  app.get('/admin/agents/:id/workspaces', (req: Request, res: Response) => {
    res.json({ workspaces: workspaces.listFor(param(req.params.id)) });
  });

  app.post('/admin/agents/:id/workspaces', async (req: Request, res: Response) => {
    const agent = await defStore.read(param(req.params.id));
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return; }
    const wsBody = parseBody(req, res, WorkspaceCreateBody);
    if (!wsBody) return;

    const target = resolveWorkspaceTarget(wsBody, res);
    if (target === null) return;
    if (!checkWorkspaceUnderSandbox(target, res)) return;
    const cleanPerms = parseWorkspacePerms(wsBody.permissions, res);
    if (cleanPerms === null) return;
    if (!ensureWorkspaceDirExists(target, res)) return;

    try {
      const ws = workspaces.upsert({ agent_id: agent.id, path: target, permissions: cleanPerms });
      host.addOrReplace(agent); // rebuild dispatcher so cwd reflects the new workspace
      res.status(201).json(ws);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/admin/agents/:agent/workspaces/:id', async (req: Request, res: Response) => {
    const id = Number(param(req.params.id));
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'id must be integer' });
      return;
    }
    const ok = workspaces.delete(id);
    const agent = await defStore.read(param(req.params.agent));
    if (agent) host.addOrReplace(agent);
    res.status(ok ? 204 : 404).end();
  });

  // ---- workspace UI: projects, files, default chat -----------------------
  // The agent-workspace page (chat-first landing). Projects are organizational
  // only; files are the agent's real workspace directories, served through the
  // same containment guards the agent FS tools use.

  const ProjectNameBody = z.object({ name: z.string().trim().min(1).max(120) }).strict();
  const ConvProjectBody = z.object({ project_id: z.number().int().positive().nullable() }).strict();
  const FileUploadBody = z.object({
    path: z.string().min(1).max(1024),
    data: z.string().max(34_000_000),   // base64; decoded cap enforced below
    overwrite: z.boolean().optional(),
  }).strict();
  const FileTagBody = z.object({
    path: z.string().min(1).max(1024),
    project_id: z.number().int().positive().nullable(),
  }).strict();

  app.get('/admin/api/agents/:id/projects', async (req: Request, res: Response) => {
    const id = param(req.params.id);
    if (!(await defStore.read(id))) { res.status(404).json({ error: 'no such agent' }); return; }
    res.json({ projects: projects.listFor(id) });
  });

  app.post('/admin/api/agents/:id/projects', async (req: Request, res: Response) => {
    const body = parseBody(req, res, ProjectNameBody);
    if (!body) return;
    const id = param(req.params.id);
    if (!(await defStore.read(id))) { res.status(404).json({ error: 'no such agent' }); return; }
    res.status(201).json(projects.create(id, body.name));
  });

  app.patch('/admin/api/projects/:pid', (req: Request, res: Response) => {
    const body = parseBody(req, res, ProjectNameBody);
    if (!body) return;
    const pid = Number(param(req.params.pid));
    if (!Number.isInteger(pid)) { res.status(400).json({ error: 'pid must be integer' }); return; }
    res.status(projects.rename(pid, body.name) ? 200 : 404).json({ ok: true });
  });

  app.delete('/admin/api/projects/:pid', (req: Request, res: Response) => {
    const pid = Number(param(req.params.pid));
    if (!Number.isInteger(pid)) { res.status(400).json({ error: 'pid must be integer' }); return; }
    res.status(projects.delete(pid) ? 204 : 404).end();
  });

  // File a conversation under a project. Cross-agent filing is refused: the
  // project and the conversation must belong to the same agent, or a chat
  // would surface inside another agent's workspace.
  app.patch('/admin/api/conversations/:cid/project', (req: Request, res: Response) => {
    const body = parseBody(req, res, ConvProjectBody);
    if (!body) return;
    const cid = Number(param(req.params.cid));
    if (!Number.isInteger(cid)) { res.status(400).json({ error: 'cid must be integer' }); return; }
    const owner = conversations.agentIdOf(cid);
    if (!owner) { res.status(404).json({ error: 'no such conversation' }); return; }
    if (body.project_id != null) {
      const project = projects.read(body.project_id);
      if (!project) { res.status(404).json({ error: 'no such project' }); return; }
      if (project.agent_id !== owner) {
        res.status(400).json({ error: 'project belongs to a different agent' });
        return;
      }
    }
    conversations.setProject(cid, body.project_id);
    res.json({ ok: true });
  });

  // The default chat: the stable human thread telegram and bare asks already
  // share, plus which channel (if any) feeds it — so the UI can badge it.
  app.get('/admin/api/agents/:id/default-chat', async (req: Request, res: Response) => {
    const id = param(req.params.id);
    if (!(await defStore.read(id))) { res.status(404).json({ error: 'no such agent' }); return; }
    const bound = deps.channels.list().find(c => c.operator_agent_id === id && c.enabled);
    res.json({
      conversation_id: conversations.findOrStartHumanThread(id),
      channel: bound ? { id: bound.id, kind: bound.kind, name: bound.name } : null,
    });
  });

  app.get('/admin/api/agents/:id/files', (req: Request, res: Response) => {
    const id = param(req.params.id);
    const listing = listFiles(workspaces.listFor(id));
    const tags = projects.fileTagsFor(id);
    res.json({
      truncated: listing.truncated,
      files: listing.files.map(f => ({ ...f, project_id: tags.get(f.path) ?? null })),
    });
  });

  app.get('/admin/api/agents/:id/file', async (req: Request, res: Response) => {
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    const r = await readWorkspaceFile(path, workspaces.listFor(param(req.params.id)));
    if (!r.ok) { res.status(404).json({ error: r.reason }); return; }
    const base = r.value.canonical.split('/').pop() ?? 'file';
    const safeName = base.replace(/[^A-Za-z0-9._-]/g, '_') || 'file';
    // Always an opaque download: never let the browser interpret workspace
    // content (an uploaded .html would otherwise render under this origin).
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(r.value.data);
  });

  app.post('/admin/api/agents/:id/files', async (req: Request, res: Response) => {
    const body = parseBody(req, res, FileUploadBody);
    if (!body) return;
    const data = Buffer.from(body.data, 'base64');
    const r = await writeWorkspaceFile(
      body.path, data, workspaces.listFor(param(req.params.id)), body.overwrite === true,
    );
    if (!r.ok) { res.status(400).json({ error: r.reason }); return; }
    res.status(201).json({ path: r.value.canonical, bytes: data.length });
  });

  app.delete('/admin/api/agents/:id/file', async (req: Request, res: Response) => {
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    const r = await deleteWorkspaceFile(path, workspaces.listFor(param(req.params.id)));
    if (!r.ok) { res.status(404).json({ error: r.reason }); return; }
    projects.dropTag(r.value.canonical);   // a deleted file must not keep a tag
    res.status(204).end();
  });

  app.post('/admin/api/agents/:id/files/tag', async (req: Request, res: Response) => {
    const body = parseBody(req, res, FileTagBody);
    if (!body) return;
    const id = param(req.params.id);
    if (body.project_id != null) {
      const project = projects.read(body.project_id);
      if (!project) { res.status(404).json({ error: 'no such project' }); return; }
      if (project.agent_id !== id) {
        res.status(400).json({ error: 'project belongs to a different agent' });
        return;
      }
    }
    // Only a real, contained file can carry a tag — refuse paths outside the
    // roots and paths that do not exist, so tags cannot be minted speculatively.
    const canonical = await canonicalIfContained(body.path, workspaces.listFor(id));
    if (!canonical) { res.status(404).json({ error: 'no such workspace file' }); return; }
    projects.tagFile(id, canonical, body.project_id);
    res.json({ ok: true, path: canonical });
  });

  const TitleBody = z.object({ title: z.string().trim().max(120).nullable() }).strict();
  const FlagsBody = z.object({
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
  }).strict().refine(b => b.pinned !== undefined || b.archived !== undefined, { message: 'nothing to change' });
  const ForkBody = z.object({ up_to_message_id: z.number().int().positive().optional() }).strict();

  app.patch('/admin/api/conversations/:cid/flags', (req: Request, res: Response) => {
    const body = parseBody(req, res, FlagsBody);
    if (!body) return;
    const cid = Number(param(req.params.cid));
    if (!Number.isInteger(cid)) { res.status(400).json({ error: 'cid must be integer' }); return; }
    // Archiving the default chat would hide the thread its channel feeds.
    if (body.archived === true && conversations.isHumanAnchor(cid)) {
      res.status(400).json({ error: 'the default chat cannot be archived' });
      return;
    }
    res.status(conversations.setFlags(cid, body) ? 200 : 404).json({ ok: true });
  });

  app.post('/admin/api/conversations/:cid/fork', (req: Request, res: Response) => {
    const body = parseBody(req, res, ForkBody) ?? {};
    const cid = Number(param(req.params.cid));
    if (!Number.isInteger(cid)) { res.status(400).json({ error: 'cid must be integer' }); return; }
    const id = conversations.fork(cid, body.up_to_message_id);
    if (id === null) { res.status(404).json({ error: 'no such conversation' }); return; }
    res.status(201).json({ conversation_id: id });
  });

  // Server-side search over one agent's chats: titles AND message bodies,
  // multi-word ANDed across the chat. Archived chats are included — archive
  // means out of the list, not forgotten.
  app.get('/admin/api/search', (req: Request, res: Response) => {
    const agentId = typeof req.query.agent_id === 'string' ? req.query.agent_id : '';
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!agentId || !q) { res.json({ results: [] }); return; }
    const limit = clampLimit(req.query.limit, 30, 100);
    res.json({ results: conversations.searchSummaries(agentId, q, limit) });
  });


  // Rename a chat. Null (or empty after trim) reverts to the derived title.
  app.patch('/admin/api/conversations/:cid/title', (req: Request, res: Response) => {
    const body = parseBody(req, res, TitleBody);
    if (!body) return;
    const cid = Number(param(req.params.cid));
    if (!Number.isInteger(cid)) { res.status(400).json({ error: 'cid must be integer' }); return; }
    const title = body.title?.trim() ? body.title.trim() : null;
    res.status(conversations.setTitle(cid, title) ? 200 : 404).json({ ok: true });
  });

  // Delete a chat outright (messages + attachments). The default chat is
  // refused: it is the anchor telegram and bare asks share, and deleting it
  // would silently promote the next-oldest thread into being the default.
  app.delete('/admin/api/conversations/:cid', (req: Request, res: Response) => {
    const cid = Number(param(req.params.cid));
    if (!Number.isInteger(cid)) { res.status(400).json({ error: 'cid must be integer' }); return; }
    if (conversations.isHumanAnchor(cid)) {
      res.status(400).json({ error: 'the default chat cannot be deleted' });
      return;
    }
    res.status(conversations.deleteConversation(cid) ? 204 : 404).end();
  });

  // ---- skills, prompts, project prompt, tree ops, context plumbing -------

  const SkillBody = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(300).default(''),
    content: z.string().min(1).max(200_000),
  }).strict();
  const SkillPatch = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(300).optional(),
    content: z.string().min(1).max(200_000).optional(),
  }).strict();
  const SkillBind = z.object({ skill_id: z.number().int().positive() }).strict();
  const PromptBody = z.object({
    name: z.string().trim().min(1).max(120),
    content: z.string().min(1).max(50_000),
    agent_id: z.string().trim().min(1).max(120).nullable().default(null),
  }).strict();
  const ProjectPromptBody = z.object({ system_prompt: z.string().trim().max(20_000).nullable() }).strict();
  const RegenBody = z.object({ assistant_message_id: z.number().int().positive() }).strict();
  const FetchUrlBody = z.object({ url: z.string().trim().min(8).max(2048) }).strict();

  app.get('/admin/api/skills', (_req: Request, res: Response) => {
    res.json({ skills: skills.list() });
  });
  app.get('/admin/api/skills/:sid', (req: Request, res: Response) => {
    const sid = Number(param(req.params.sid));
    const row = Number.isInteger(sid) ? skills.read(sid) : null;
    if (!row) { res.status(404).json({ error: 'no such skill' }); return; }
    res.json(row);
  });
  app.post('/admin/api/skills', (req: Request, res: Response) => {
    const body = parseBody(req, res, SkillBody);
    if (!body) return;
    if (skills.readByName(body.name)) { res.status(409).json({ error: 'a skill with that name exists' }); return; }
    res.status(201).json(skills.create(body.name, body.description, body.content));
  });
  app.patch('/admin/api/skills/:sid', (req: Request, res: Response) => {
    const body = parseBody(req, res, SkillPatch);
    if (!body) return;
    const sid = Number(param(req.params.sid));
    if (!Number.isInteger(sid)) { res.status(400).json({ error: 'sid must be integer' }); return; }
    res.status(skills.update(sid, body) ? 200 : 404).json({ ok: true });
  });
  app.delete('/admin/api/skills/:sid', (req: Request, res: Response) => {
    const sid = Number(param(req.params.sid));
    if (!Number.isInteger(sid)) { res.status(400).json({ error: 'sid must be integer' }); return; }
    res.status(skills.delete(sid) ? 204 : 404).end();
  });
  app.post('/admin/api/agents/:id/skills', async (req: Request, res: Response) => {
    const body = parseBody(req, res, SkillBind);
    if (!body) return;
    const id = param(req.params.id);
    if (!(await defStore.read(id))) { res.status(404).json({ error: 'no such agent' }); return; }
    if (!skills.read(body.skill_id)) { res.status(404).json({ error: 'no such skill' }); return; }
    skills.bind(id, body.skill_id);
    res.json({ ok: true });
  });
  app.delete('/admin/api/agents/:id/skills/:sid', (req: Request, res: Response) => {
    const sid = Number(param(req.params.sid));
    if (!Number.isInteger(sid)) { res.status(400).json({ error: 'sid must be integer' }); return; }
    // Idempotent: an absent bind IS the requested state, not an error.
    skills.unbind(param(req.params.id), sid);
    res.json({ ok: true });
  });

  app.get('/admin/api/agents/:id/prompts', (req: Request, res: Response) => {
    res.json({ prompts: prompts.listFor(param(req.params.id)) });
  });
  app.post('/admin/api/prompts', (req: Request, res: Response) => {
    const body = parseBody(req, res, PromptBody);
    if (!body) return;
    res.status(201).json(prompts.create(body.agent_id, body.name, body.content));
  });
  const PromptPatch = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    content: z.string().min(1).max(50_000).optional(),
    agent_id: z.string().trim().min(1).max(120).nullable().optional(),
  }).strict();

  app.patch('/admin/api/prompts/:pid', (req: Request, res: Response) => {
    const body = parseBody(req, res, PromptPatch);
    if (!body) return;
    const pid = Number(param(req.params.pid));
    if (!Number.isInteger(pid)) { res.status(400).json({ error: 'pid must be integer' }); return; }
    res.status(prompts.update(pid, body) ? 200 : 404).json({ ok: true });
  });
  app.delete('/admin/api/prompts/:pid', (req: Request, res: Response) => {
    const pid = Number(param(req.params.pid));
    if (!Number.isInteger(pid)) { res.status(400).json({ error: 'pid must be integer' }); return; }
    res.status(prompts.delete(pid) ? 204 : 404).end();
  });

  // The sub-persona knob: a prompt every chat filed under the project inherits.
  app.patch('/admin/api/projects/:pid/prompt', (req: Request, res: Response) => {
    const body = parseBody(req, res, ProjectPromptBody);
    if (!body) return;
    const pid = Number(param(req.params.pid));
    if (!Number.isInteger(pid)) { res.status(400).json({ error: 'pid must be integer' }); return; }
    const prompt = body.system_prompt?.trim() ? body.system_prompt.trim() : null;
    res.status(projects.setSystemPrompt(pid, prompt) ? 200 : 404).json({ ok: true });
  });

  // A sibling answer to an existing assistant turn — the original stays.
  app.post('/admin/api/conversations/:cid/regenerate', async (req: Request, res: Response) => {
    const body = parseBody(req, res, RegenBody);
    if (!body) return;
    const cid = Number(param(req.params.cid));
    if (!Number.isInteger(cid)) { res.status(400).json({ error: 'cid must be integer' }); return; }
    const owner = conversations.agentIdOf(cid);
    if (!owner) { res.status(404).json({ error: 'no such conversation' }); return; }
    try {
      const r = await host.get(owner).regenerate(cid, body.assistant_message_id);
      res.json(r);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.patch('/admin/api/conversations/:cid/read', (req: Request, res: Response) => {
    const cid = Number(param(req.params.cid));
    if (!Number.isInteger(cid)) { res.status(400).json({ error: 'cid must be integer' }); return; }
    conversations.markRead(cid);
    res.json({ ok: true });
  });

  // Fetch a page as fenced context for the composer. Same SSRF guard the
  // agent's own WebFetch runs behind; the result is data, never instructions.
  app.post('/admin/api/agents/:id/fetch-url', async (req: Request, res: Response) => {
    const body = parseBody(req, res, FetchUrlBody);
    if (!body) return;
    const v = validateUrl(body.url);
    if (!v.ok) { res.status(400).json({ error: `url rejected: ${v.reason}` }); return; }
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20_000);
      const r = await safeFetch(body.url, { signal: ctl.signal }).finally(() => clearTimeout(timer));
      const raw = (await r.text()).slice(0, 2_000_000);
      const text = htmlToText(raw).slice(0, 60_000);
      const hostname = new URL(body.url).host;
      res.json({ host: hostname, text: fenceUntrusted(`web page ${hostname}`, text) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // A past conversation as fenced context ("reference chat") — injected whole,
  // no chunking; fenced because transcripts can carry channel-borne text.
  app.post('/admin/api/conversations/:cid/as-context', (req: Request, res: Response) => {
    const cid = Number(param(req.params.cid));
    if (!Number.isInteger(cid)) { res.status(400).json({ error: 'cid must be integer' }); return; }
    if (!conversations.agentIdOf(cid)) { res.status(404).json({ error: 'no such conversation' }); return; }
    const rows = conversations.recent(cid, 200);
    const text = rows
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => `${m.role}: ${m.content}`)
      .join('\n\n');
    res.json({ text: fenceUntrusted(`referenced conversation ${cid}`, text) });
  });

  // Explicit new chat. A bare ask (no conversation_id) deliberately lands in
  // the default thread, so starting a FRESH conversation needs its own verb.
  app.post('/admin/api/agents/:id/conversations', async (req: Request, res: Response) => {
    const id = param(req.params.id);
    if (!(await defStore.read(id))) { res.status(404).json({ error: 'no such agent' }); return; }
    res.status(201).json({ conversation_id: conversations.start(id) });
  });

  // ---- one-shot test pane (uses a draft prompt; never persisted) --------
  //
  // The agent edit form calls this to iterate on a system prompt without
  // saving the agent yet. We build an ephemeral dispatcher with the form's
  // current state, dispatch one turn, return the reply. No conversation
  // row, no memory write — pure "what would this prompt return."

  app.post('/admin/api/test', async (req: Request, res: Response) => {
    const body = parseBody(req, res, TestPaneBody);
    if (!body) return;
    const wsPaths = body.workspaces ?? [];
    // Sandbox-check every ephemeral workspace just like the persistent
    // workspace-create path does. Without this an admin token-holder
    // could mint a one-shot dispatcher pointing at any filesystem path
    // the service account can reach, with no audit row.
    for (const w of wsPaths) {
      if (!checkWorkspaceUnderSandbox(normalizePath(resolvePath(w.path)), res)) return;
    }
    try {
      const ephemeralWs = wsPaths.map((w, i) => ({
        id: i + 1,
        agent_id: '__test__',
        path: w.path,
        permissions: w.permissions,
        created_at: Math.floor(Date.now() / 1000),
      }));
      const { buildDispatcher } = await import('../model/factory.js');
      const dispatcher = buildDispatcher(body.runtime === 'api' ? 'ritsu-agent' : 'claude-direct', body.model, {
        cwd: ephemeralWs[0]?.path,
        tools: body.tools_allowlist ?? [],
        workspaces: ephemeralWs,
        secrets,
        // Draft api-runtime agents test against their real provider — no
        // built-in tools, no memory: pure "what would this prompt return."
        ...(body.runtime === 'api' ? {
          ritsuAgent: {
            provider: body.provider as import('../model/ritsu-agent/types.js').RaProvider,
            apiKeyRef: body.api_key_ref,
            apiKeys: deps.apiKeys,
            providerOptions: body.provider_options,
            toolDeps: null,
          },
        } : {}),
      });
      const t0 = Date.now();
      const resp = await dispatcher.chat({
        messages: [
          { role: 'system', content: body.system_prompt },
          { role: 'user', content: body.message },
        ],
      });
      res.json({
        reply: resp.content,
        model: resp.model,
        usage: resp.usage,
        duration_ms: Date.now() - t0,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ---- MCP info (static; no live RPC, no auth dance) ---------------------
  // Used by the Admin UI's MCP tab to render a read-only info page (URL,
  // tools, auth requirement). Previously this tab proxied a live tools/list
  // call into MCP, which broke when auth was required (the proxy ran
  // unauthed). Operators who want the live JSON Schema for a tool can hit
  // the MCP endpoint directly with their bearer.
  app.get('/admin/api/mcp-info', (_req: Request, res: Response) => {
    res.json({
      url: deps.mcpUrl + '/mcp',
      auth_required:
        deps.authMode === 'on' ||
        (deps.authMode === 'auto' && tokens.hasAnyActive('mcp')),
      tools: TOOL_INFO,
    });
  });

  // ---- tokens ------------------------------------------------------------

  app.get('/admin/api/plugins', (_req: Request, res: Response) => {
    res.json({ plugins: pluginHost.manifests() });
  });

  app.patch('/admin/api/plugins/:id', async (req: Request, res: Response) => {
    const body = parseBody(req, res, z.object({ enabled: z.boolean() }));
    if (!body) return;
    const id = param(req.params.id);
    const ok = pluginHost.setEnabled(id, body.enabled);
    // Re-wire live agents so a disable revokes the plugin's tools immediately,
    // not just at the agent's next reload.
    if (ok) await host.reloadForPlugin(id);
    res.status(ok ? 200 : 404).json({ ok });
  });

  app.delete('/admin/api/plugins/:id', async (req: Request, res: Response) => {
    const id = param(req.params.id);
    const ok = pluginHost.uninstall(id);
    if (ok) await host.reloadForPlugin(id);
    res.status(ok ? 204 : 404).end();
  });

  // Load a plugin's recommended agent preset into a real, editable agent.
  // Non-destructive: if the target agent already exists we leave it alone.
  app.post('/admin/api/plugins/:id/agent', async (req: Request, res: Response) => {
    const id = param(req.params.id);
    const seed = pluginHost.agentSeed(id);
    if (!seed) { res.status(404).json({ error: 'this plugin has no agent preset' }); return; }
    const agentId = seed.id ?? `${id}-assistant`;
    if (await defStore.read(agentId)) { res.json({ created: false, id: agentId }); return; }
    const def = AgentDefinitionSchema.parse({
      id: agentId,
      type: 'generic',
      name: seed.name,
      description: seed.description,
      system_prompt: seed.system_prompt,
      runtime: seed.runtime ?? 'direct',
      provider: seed.provider ?? 'claude',
      model: seed.model ?? 'claude-sonnet-4-6',
      tools_allowlist: seed.tools_allowlist ?? [],
      capabilities: seed.capabilities ?? [],
      plugins: [...new Set([id, ...(seed.plugins ?? [])])],
    });
    const saved = await defStore.upsert(def);
    host.addOrReplace(saved);
    res.status(201).json({ created: true, id: agentId });
  });

  // ---- memory backend config (System → Memory) ---------------------------
  app.get('/admin/api/memory', (_req: Request, res: Response) => {
    const next = loadMemoryConfig(secrets);
    res.json({
      boot: deps.memoryBoot ?? null,
      effective_next_boot: { mode: next.mode, remote: next.flashback?.endpoint ?? null },
      stored: {
        url: secrets.get(FLASHBACK_NS, 'url') ?? '',
        token_set: !!secrets.get(FLASHBACK_NS, 'token'),
        mode: secrets.get(FLASHBACK_NS, 'mode') ?? '',
        timeout_ms: secrets.get(FLASHBACK_NS, 'timeout_ms') ?? '',
        proposal_poll_ms: secrets.get(FLASHBACK_NS, 'proposal_poll_ms') ?? '',
      },
    });
  });

  // ---- health (live connectivity checks) ---------------------------------
  app.get('/admin/api/health', async (_req: Request, res: Response) => {
    res.json(await runHealthChecks({
      defStore, apiKeys: deps.apiKeys, secrets,
      ...(deps.settings ? { settings: deps.settings } : {}),
    }));
  });

  // ---- backups + export (data safety) ------------------------------------
  app.get('/admin/api/backups', (_req: Request, res: Response) => {
    res.json({ backups: backup.listBackups(), dir: backup.dir() });
  });

  app.post('/admin/api/backup', (_req: Request, res: Response) => {
    try { res.status(201).json(backup.createBackup()); }
    catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // Download a snapshot .db off the box.
  app.get('/admin/api/backups/:name', (req: Request, res: Response) => {
    const p = backup.pathFor(param(req.params.name));
    if (!p) { res.status(404).json({ error: 'not found' }); return; }
    res.download(p, param(req.params.name));
  });

  app.delete('/admin/api/backups/:name', (req: Request, res: Response) => {
    res.status(backup.deleteBackup(param(req.params.name)) ? 204 : 404).end();
  });

  // Portable JSON of your meaningful data (no secrets/tokens) — "never hostage".
  app.get('/admin/api/export', (_req: Request, res: Response) => {
    const data = backup.exportJson();
    res.setHeader('Content-Disposition', `attachment; filename="ritsu-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(data, null, 2));
  });

  pluginHost.mountApi(app);
  pluginHost.mountAssets(app);

  app.get('/admin/api/tokens', (req: Request, res: Response) => {
    const scope = req.query.scope as string | undefined;
    if (scope && scope !== 'mcp' && scope !== 'admin') {
      res.status(400).json({ error: "scope must be 'mcp' or 'admin'" });
      return;
    }
    res.json({ tokens: scope ? tokens.list(scope as 'mcp' | 'admin') : tokens.list() });
  });

  app.post('/admin/api/tokens', (req: Request, res: Response) => {
    const body = parseBody(req, res, TokenMintBody);
    if (!body) return;
    const name = body.name;
    const scope = body.scope ?? 'mcp';
    const ttlRaw = body.ttl_seconds;
    const ttlSeconds = ttlRaw === undefined || ttlRaw === null || ttlRaw === ''
      ? null
      : Math.floor(Number(ttlRaw));
    if (ttlSeconds !== null && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) {
      res.status(400).json({ error: 'ttl_seconds must be a positive integer' });
      return;
    }
    try {
      const minted = tokens.mint(name, scope, ttlSeconds);
      // Plaintext token is returned exactly once. The client should display
      // it to the operator with a copy-to-clipboard affordance and warn that
      // it will not be shown again.
      res.status(201).json(minted);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/admin/api/tokens/:id/revoke', (req: Request, res: Response) => {
    const id = Number(param(req.params.id));
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'id must be integer' });
      return;
    }
    const ok = tokens.revoke(id);
    res.status(ok ? 200 : 404).json({ ok });
  });

  app.delete('/admin/api/tokens/:id', (req: Request, res: Response) => {
    const id = Number(param(req.params.id));
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'id must be integer' });
      return;
    }
    const ok = tokens.delete(id);
    if (!ok) {
      res.status(409).json({ error: 'token must be revoked before delete' });
      return;
    }
    res.status(204).end();
  });

  app.get('/admin/api/tokens/:id/usage', (req: Request, res: Response) => {
    const id = Number(param(req.params.id));
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'id must be integer' });
      return;
    }
    const limit = clampLimit(req.query.limit, 100, 500);
    res.json({ usage: tokens.recentUsage(id, limit) });
  });

  // ---- api keys (third-party model provider credentials) -----------------
  // Referenced by an api-runtime agent's api_key_ref; the dispatcher decrypts
  // one at call time. Operator-only — an agent can never name a key itself.

  // ---- claude subscription session (claude-direct credential) ------------
  // Stored in the SecretStore like every other credential, so it is managed
  // here rather than in a root-owned env file. Saving rebuilds every agent, so
  // a rotated token takes effect without restarting the service.
  app.get('/admin/api/claude-token', (_req: Request, res: Response) => {
    const stored = secrets.get(CLAUDE_NS, 'oauth_token')?.trim();
    res.json({
      token_set: !!stored,
      // Never the value: only enough to tell one token from another.
      token_hint: stored ? `${stored.slice(0, 12)}…${stored.slice(-4)}` : null,
      env_fallback: !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
    });
  });

  app.post('/admin/api/claude-token', async (req: Request, res: Response) => {
    if (keyMissing(res)) return;
    const body = parseBody(req, res, ClaudeTokenBody);
    if (!body) return;
    secrets.set(CLAUDE_NS, 'oauth_token', body.token.trim());
    await host.loadAll();
    res.json({ ok: true, token_set: true });
  });

  app.delete('/admin/api/claude-token', async (_req: Request, res: Response) => {
    secrets.delete(CLAUDE_NS, 'oauth_token');
    await host.loadAll();
    res.status(204).end();
  });

  app.get('/admin/api/api-keys', (_req: Request, res: Response) => {
    res.json({ api_keys: deps.apiKeys.list() });
  });

  app.post('/admin/api/api-keys', (req: Request, res: Response) => {
    const body = parseBody(req, res, ApiKeyMintBody);
    if (!body) return;
    if (keyMissing(res)) return;
    const { name, provider, plaintext } = body;
    // A subscription token authenticates the direct runtime only; the metered
    // API rejects it. Caught here so the failure is a clear message now rather
    // than an auth error on the agent's first turn.
    if (plaintext.startsWith('sk-ant-oat')) {
      res.status(400).json({
        error: 'that is a subscription token, not an API key — save it under the subscription panel instead',
      });
      return;
    }
    try {
      // Plaintext returned exactly once in the response; the client should
      // display it to the operator with a copy-to-clipboard affordance.
      const minted = deps.apiKeys.mint(name, provider, plaintext);
      res.status(201).json(minted);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/admin/api/api-keys/:id/revoke', (req: Request, res: Response) => {
    const id = Number(param(req.params.id));
    if (!Number.isInteger(id)) { res.status(400).json({ error: 'id must be integer' }); return; }
    const ok = deps.apiKeys.revoke(id);
    res.json({ revoked: ok });
  });

  app.delete('/admin/api/api-keys/:id', (req: Request, res: Response) => {
    const id = Number(param(req.params.id));
    if (!Number.isInteger(id)) { res.status(400).json({ error: 'id must be integer' }); return; }
    const ok = deps.apiKeys.delete(id);
    if (!ok) {
      res.status(409).json({ error: 'must revoke before delete' });
      return;
    }
    res.json({ deleted: true });
  });

  // ---- OAuth clients ----------------------------------------------------
  // Operator surface for the OAuth 2.1 + DCR client registry. Read-only on
  // the create side (clients self-register via POST /oauth/register per
  // RFC 7591); the operator can inspect and revoke from here.

  app.get('/admin/api/oauth/clients', (_req: Request, res: Response) => {
    const clients = deps.oauth.listClients().map(c => ({
      ...c,
      token_counts: deps.oauth.countTokens(c.client_id),
    }));
    res.json({ clients });
  });

  app.get('/admin/api/oauth/clients/:client_id/tokens', (req: Request, res: Response) => {
    const client = deps.oauth.getClient(param(req.params.client_id));
    if (!client) { res.status(404).json({ error: 'client not found' }); return; }
    res.json({ tokens: deps.oauth.listTokensForClient(param(req.params.client_id)) });
  });

  app.post('/admin/api/oauth/clients/:client_id/revoke', (req: Request, res: Response) => {
    const ok = deps.oauth.revokeClient(param(req.params.client_id));
    if (!ok) { res.status(404).json({ error: 'client not found' }); return; }
    res.json({ revoked: true });
  });

  // ---- channels -----------------------------------------------------------
  // Each channel row = one bot/account bound to one operator agent. The
  // registry runs them; admin endpoints just CRUD the rows + tell the
  // registry to reload the affected one.

  const ChannelUpsertInputSchema = z.object({
    name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'name must be lowercase kebab-case'),
    kind: ChannelKindSchema,
    operator_agent_id: z.string().min(1),
    config: z.unknown(),
    enabled: z.boolean().optional(),
  });

  // ---- scheduled jobs -------------------------------------------------
  //
  // The scheduler had no write or read surface at all: nothing could create a
  // job, and an operator could not see why one stopped. Both are the same five
  // routes.

  const JobInputSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'lowercase kebab-case'),
    name: z.string().min(1).max(200),
    schedule: z.object({
      kind: z.enum(['at', 'every', 'cron']),
      spec: z.string().min(1).max(200),
      tz: z.string().max(64).nullable().optional(),
      stagger_ms: z.number().int().min(0).max(3_600_000).optional(),
    }),
    payload: z.unknown(),
    delivery: z.unknown().optional(),
    trigger: z.unknown().optional(),
    context_from: z.array(z.string()).optional(),
  });

  /** Definition plus the runtime state an operator actually needs to see. */
  function jobView(id: string): unknown {
    const job = deps.jobs.read(id);
    if (!job) return null;
    const state = deps.jobs.state(id);
    return {
      ...job,
      next_run_at: state?.next_run_at ?? null,
      last_run_at: state?.last_run_at ?? null,
      last_status: state?.last_status ?? null,
      consecutive_failures: state?.consecutive_failures ?? 0,
      // The single most useful field: a null next run means five different
      // things, and this is the one that says which.
      disabled_reason: state?.disabled_reason ?? null,
    };
  }

  /**
   * A scheduled agent turn and the channel's inbound replies must land in the
   * same conversation, which only happens when they share an agent. Getting it
   * wrong produces a check-in whose answers silently go to a thread that never
   * saw the question — worth warning about, not worth refusing, since a job
   * need not involve a channel at all.
   */
  function agentMismatchWarning(payload: unknown): string | null {
    const p = payload as { kind?: string; agent_id?: string } | null;
    if (!p || p.kind !== 'agent_turn' || !p.agent_id) return null;
    const operators = new Set(deps.channels.listEnabled().map(c => c.operator_agent_id));
    if (operators.size === 0 || operators.has(p.agent_id)) return null;
    return `agent "${p.agent_id}" does not operate any enabled channel; replies to this job will not reach it`;
  }

  app.get('/admin/api/jobs', (_req: Request, res: Response) => {
    // `unreadable` rides along with the listing rather than sitting behind its
    // own route: a row that will not parse is absent from `jobs`, so anyone
    // reading only that array concludes the job does not exist.
    res.json({
      jobs: deps.jobs.list(true).map(j => jobView(j.id)),
      unreadable: deps.jobs.unreadable(),
    });
  });

  app.get('/admin/api/jobs/:id/runs', (req: Request, res: Response) => {
    const id = param(req.params.id);
    if (!deps.jobs.read(id)) { res.status(404).json({ error: 'job not found' }); return; }
    res.json({ runs: deps.jobs.runs(id, 50) });
  });

  const JobPatchSchema = z.object({
    enabled: z.boolean().optional(),
    run_now: z.literal(true).optional(),
  }).strict();

  app.post('/admin/api/jobs', (req: Request, res: Response) => {
    try {
      const input = JobInputSchema.parse(req.body);
      const job = deps.jobs.upsert({ ...input, owner: 'operator' } as JobUpsert);
      // upsert deliberately does not arm a job — only the caller knows the
      // clock to compute from, and an unarmed job is invisible to the runner.
      // A throw here (malformed cron) has to take the row with it, or the
      // 400 leaves an unarmed orphan behind.
      let first: number | null;
      try { first = nextRun(job.schedule, Date.now(), null); }
      catch (err) { deps.jobs.delete(job.id); throw err; }
      if (first === null) {
        deps.jobs.delete(job.id);
        res.status(400).json({ error: 'that schedule will never fire' });
        return;
      }
      deps.jobs.setNextRun(job.id, first);
      res.json({ job: jobView(job.id), warning: agentMismatchWarning(job.payload) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.patch('/admin/api/jobs/:id', (req: Request, res: Response) => {
    const id = param(req.params.id);
    const existing = deps.jobs.read(id);
    if (!existing) { res.status(404).json({ error: 'job not found' }); return; }
    const body = parseBody(req, res, JobPatchSchema);
    if (!body) return;
    try {
      if (body.run_now === true) {
        deps.jobs.setNextRun(id, Date.now() - 1);
      }
      if (typeof body.enabled === 'boolean') {
        deps.jobs.setEnabled(id, body.enabled);
        // Re-enabling has to re-arm: setEnabled clears the stop reason and the
        // failure streak but cannot know what clock to schedule against, so a
        // job enabled without this is silently inert.
        if (body.enabled) {
          const next = nextRun(existing.schedule, Date.now(), deps.jobs.state(id)?.last_run_at ?? null);
          deps.jobs.setNextRun(id, next);
        } else {
          deps.jobs.setNextRun(id, null);
        }
      }
      res.json({ job: jobView(id) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/admin/api/jobs/:id', (req: Request, res: Response) => {
    const id = param(req.params.id);
    res.json({ deleted: deps.jobs.delete(id) });
  });

  app.get('/admin/api/channels', (_req: Request, res: Response) => {
    res.json({ channels: deps.channels.list().map(redactChannel) });
  });

  app.post('/admin/api/channels', async (req: Request, res: Response) => {
    try {
      const input = ChannelUpsertInputSchema.parse(req.body);
      const validatedConfig = validateChannelConfig(input.kind, input.config);
      if (deps.channels.readByName(input.name)) {
        res.status(409).json({ error: `channel "${input.name}" already exists` });
        return;
      }
      const row = deps.channels.create({
        name: input.name,
        kind: input.kind,
        operator_agent_id: input.operator_agent_id,
        config: validatedConfig,
        enabled: input.enabled,
      });
      await deps.channelRegistry.addOrReplace(row);
      res.json(redactChannel(row));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.patch('/admin/api/channels/:id', async (req: Request, res: Response) => {
    const id = Number(param(req.params.id));
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'id must be integer' });
      return;
    }
    try {
      const existing = deps.channels.read(id);
      if (!existing) {
        res.status(404).json({ error: 'channel not found' });
        return;
      }
      const patchBody = parseBody(req, res, ChannelPatchBody);
      if (!patchBody) return;
      const patch: Record<string, unknown> = {};
      if (patchBody.name !== undefined)              patch.name = patchBody.name;
      if (patchBody.operator_agent_id !== undefined) patch.operator_agent_id = patchBody.operator_agent_id;
      if (patchBody.enabled !== undefined)           patch.enabled = patchBody.enabled;
      if (patchBody.config !== undefined) {
        patch.config = validateChannelConfig(existing.kind, patchBody.config);
      }
      const row = deps.channels.update(id, patch);
      await deps.channelRegistry.addOrReplace(row);
      res.json(redactChannel(row));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/admin/api/channels/:id', async (req: Request, res: Response) => {
    const id = Number(param(req.params.id));
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'id must be integer' });
      return;
    }
    await deps.channelRegistry.remove(id);
    const removed = deps.channels.delete(id);
    res.json({ deleted: removed });
  });

  /** Recent chats this channel has heard from since the registry started it.
   *  Powers the admin UI's "click to allow" helper so you don't have to chase
   *  numeric chat_ids via third-party bots. */
  app.get('/admin/api/channels/:id/recent-chats', (req: Request, res: Response) => {
    const id = Number(param(req.params.id));
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'id must be integer' });
      return;
    }
    res.json({ chats: deps.channelRegistry.getRecentChats(id) });
  });

  /** Bind a channel to a single chat_id (replaces any prior binding). One
   *  bot ↔ one chat, period. Lighter than PATCH /admin/api/channels/:id
   *  with a full config rewrite (which would require the bot_token plaintext). */
  app.post('/admin/api/channels/:id/bind-chat', async (req: Request, res: Response) => {
    const id = Number(param(req.params.id));
    if (!Number.isInteger(id)) { res.status(400).json({ error: 'id must be integer' }); return; }
    const bindBody = parseBody(req, res, BindChatBody);
    if (!bindBody) return;
    const chatId = bindBody.chat_id;
    const existing = deps.channels.read(id);
    if (!existing) { res.status(404).json({ error: 'channel not found' }); return; }
    try {
      const cfg = TelegramConfigSchema.parse(existing.config);
      const row = deps.channels.update(id, { config: { ...cfg, chat_id: chatId } });
      await deps.channelRegistry.addOrReplace(row);
      res.json(redactChannel(row));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /**
   * Last-used timestamp for an agent: the max of (token usage where
   * agent_id matches) and (conversation start). Returns null if neither.
   * Used by the Agents tab "last used" column.
   */
  function lastUsedFor(agentId: string): number | null {
    const row = deps.host['db']
      .prepare(
        `SELECT MAX(ts) AS ts FROM (
           SELECT ts FROM mcp_token_usage WHERE agent_id = ?
           UNION ALL
           SELECT started_at AS ts FROM conversations WHERE agent_id = ?
         )`,
      )
      .get(agentId, agentId) as { ts: number | null } | undefined;
    return row?.ts ?? null;
  }

  logger.info('admin.app-built', { version: deps.version, auth_mode: deps.authMode });
  return app;
}
