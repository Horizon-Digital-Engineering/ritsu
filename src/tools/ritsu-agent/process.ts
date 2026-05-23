/**
 * Native process tools for the ritsu-agent runtime: Bash, Glob, Grep.
 * Tool names match the Claude SDK's so the per-agent tools_allowlist
 * selector works identically across both runtimes.
 *
 * Sandboxing posture:
 *
 *   - Default (RITSU_BASH_SANDBOX unset):
 *       Bash runs as the host service user, with `cwd` set to the
 *       agent's first workspace and an env allowlist (see C1). The
 *       systemd unit's ProtectHome/ProtectSystem/ReadWritePaths is the
 *       outer boundary; without it (e.g. `npm run dev`) the workspace
 *       cwd is advisory only.
 *
 *   - RITSU_BASH_SANDBOX=1:
 *       Wrap every Bash invocation in bwrap (bubblewrap):
 *         * ro-bind / mount of the host root — binaries + libs still work
 *         * rw-bind only of the configured workspace
 *         * private /tmp (tmpfs) so /tmp/foo doesn't leak between agents
 *         * --die-with-parent so the shell can't outlive the host
 *         * --unshare-pid/uts/ipc + --cap-drop ALL for namespace/cap
 *           isolation
 *         * network NOT unshared — agents still need to curl APIs. The
 *           SSRF guard on WebFetch is the deliberate trade-off; raw curl
 *           still reaches anything routable. Operators who want network
 *           isolation should configure firewall rules on the ritsu user.
 *       Fails loud (returns 'error: ...') if RITSU_BASH_SANDBOX=1 is set
 *       but `bwrap` isn't on PATH — refuse-on-misconfig matches the
 *       SSRF + admin-token bootstrap posture.
 */
import { spawn } from 'node:child_process';
import { readdir, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';
import { RE2 } from 're2-wasm';
import type { Workspace } from '../../workspace-store.js';
import type { RaTool } from '../../model/ritsu-agent/types.js';
import { checkToolUse, canonicalizeUnderWorkspace } from '../permissions.js';
import { logger } from '../../util/log.js';
import { asString } from '../../util/cast.js';

const BASH_TIMEOUT_MS = 30_000;
const BASH_TIMEOUT_CEIL_MS = 60_000; // hard upper bound on per-call override
const BASH_OUTPUT_CAP = 30 * 1024; // 30KB combined stdout+stderr
/** Per-workspace ceiling on concurrent Bash invocations. The workspace
 *  path is the identity (an agent has one cwd-workspace, so this caps
 *  per-agent fan-out). Two concurrent shells covers legit parallel use
 *  ("run lint + run tests simultaneously") without letting a prompt-
 *  injected agent spin up 100 parallel sleep loops. */
const BASH_MAX_INFLIGHT_PER_CWD = 2;
const bashInflight = new Map<string, number>();
const GLOB_FILE_CAP = 500;          // tools/walks bail after this many matches
const GREP_RESULT_CAP = 200;        // grep returns at most this many lines
const WALK_FILE_CAP = 50_000;       // safety: never walk past this many entries

/**
 * Env vars forwarded into the Bash sandbox. We DELIBERATELY do NOT pass
 * `{ ...process.env }` because the ritsu service process holds secrets
 * the agent must never see — `RITSU_ADMIN_TOKEN`, `ANTHROPIC_API_KEY`,
 * operator-loaded provider keys, etc. A prompt-injected agent with
 * Bash would otherwise run `env` and exfiltrate all of them in one shot.
 *
 * The allowlist below is what a generic shell command needs to look up
 * binaries and produce locale-correct output; nothing more. Cwd-specific
 * vars (`PWD`, `OLDPWD`) are set explicitly in `runBash`.
 *
 * If you add a new entry, ask: "does this make the env useful, or is it
 * carrying a credential?" — only the former belongs.
 */
const BASH_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM'] as const;

function buildBashEnv(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PWD: cwd };
  for (const key of BASH_ENV_ALLOWLIST) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  // Anchor PATH to a sane default if the service somehow lost it — a
  // bare-PATH bash can't even run `ls`.
  if (!env.PATH) env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  return env;
}

/** Where to find bwrap. Common paths; cached at module load. */
const BWRAP_PATHS = ['/usr/bin/bwrap', '/usr/local/bin/bwrap'] as const;
const BWRAP_BIN = BWRAP_PATHS.find(p => existsSync(p)) ?? null;

/**
 * Build the bwrap arg list for one Bash invocation. The result still
 * ends in `/bin/bash -lc <command>` — bwrap is a wrapper, not a
 * replacement.
 */
function buildBwrapArgs(cwd: string, command: string): string[] {
  return [
    // Host root as read-only base so common binaries + libs are reachable.
    '--ro-bind', '/', '/',
    // Workspace as the ONLY writable path. Even if the agent's prompt
    // injects `rm -rf /`, only this directory tree can be touched.
    '--bind', cwd, cwd,
    // /tmp is per-call ephemeral; no leakage between agents or runs.
    '--tmpfs', '/tmp',
    // procfs + minimal devs so common tooling works (`ls /proc`, `cat
    // /dev/null`, etc).
    '--proc', '/proc',
    '--dev', '/dev',
    // Run as session leader so SIGTERM/SIGKILL kills the whole shell
    // tree, not just bwrap itself.
    '--die-with-parent',
    '--new-session',
    // Drop ALL Linux capabilities so the shell can't gain elevated
    // syscall surface (e.g. CAP_NET_RAW, CAP_DAC_OVERRIDE).
    '--cap-drop', 'ALL',
    // Isolate PID, UTS, IPC namespaces. Network is intentionally NOT
    // unshared — agents do legit curl, and the SSRF guard on WebFetch
    // is the deliberate trade-off for raw network access here.
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-ipc',
    '/bin/bash', '-lc', command,
  ];
}

/** Bash command runner. Spawns /bin/bash -c <cmd> with cwd set to the
 *  agent's first workspace. Output is captured + capped. Times out at
 *  BASH_TIMEOUT_MS. Caller can override timeout per-call.
 *
 *  When RITSU_BASH_SANDBOX=1, wraps the invocation in bwrap (see
 *  buildBwrapArgs); fails loud if bwrap isn't installed. */
async function runBash(command: string, cwd: string, timeoutMs: number): Promise<string> {
  const wantSandbox = process.env.RITSU_BASH_SANDBOX === '1';
  if (wantSandbox && !BWRAP_BIN) {
    return `error: RITSU_BASH_SANDBOX=1 but bwrap isn't installed (checked ${BWRAP_PATHS.join(', ')}). ` +
      `apt install bubblewrap (or your distro's equivalent), or unset RITSU_BASH_SANDBOX.`;
  }
  const [bin, argv] = wantSandbox && BWRAP_BIN
    ? [BWRAP_BIN, buildBwrapArgs(cwd, command)]
    : ['/bin/bash', ['-lc', command]];

  return new Promise(resolveOuter => {
    const child = spawn(bin, argv, {
      cwd,
      env: buildBashEnv(cwd),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let truncated = false;
    const append = (chunk: Buffer, into: 'out' | 'err'): void => {
      const remaining = BASH_OUTPUT_CAP - (out.length + err.length);
      if (remaining <= 0) { truncated = true; return; }
      const text = chunk.toString('utf8');
      const slice = text.length > remaining ? text.slice(0, remaining) : text;
      if (text.length > remaining) truncated = true;
      if (into === 'out') out += slice; else err += slice;
    };
    child.stdout.on('data', d => append(d as Buffer, 'out'));
    child.stderr.on('data', d => append(d as Buffer, 'err'));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const parts: string[] = [];
      if (out) parts.push(out);
      if (err) parts.push(`--- stderr ---\n${err}`);
      if (signal === 'SIGKILL') parts.push(`--- timed out after ${timeoutMs}ms ---`);
      else if (code !== 0) parts.push(`--- exit code ${code} ---`);
      if (truncated) parts.push(`--- output truncated at ${BASH_OUTPUT_CAP} bytes ---`);
      resolveOuter(parts.join('\n') || '(no output)');
    });
    child.on('error', e => {
      clearTimeout(timer);
      resolveOuter(`error spawning bash: ${e.message}`);
    });
  });
}

/** Glob a simple pattern under a workspace root. Supports:
 *   - `*`   any chars except `/`
 *   - `**`  any chars including `/`
 *   - `?`   one char except `/`
 *  No braces, no negation, no character classes — keep the parser tiny.
 *  Returns paths relative to the workspace root. */
function globMatch(pattern: string, path: string): boolean {
  // Convert the simple glob into a regex.
  // `**/` matches zero-or-more leading path segments (so `**/*.ts` matches
  // both `a.ts` and `src/c.ts`). Bare `**` matches anything. Single `*`
  // matches any chars except slash. `?` matches exactly one non-slash char.
  let src = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      // `**/` → zero-or-more path segments (incl. empty)
      if (pattern[i + 2] === '/') {
        src += '(?:.*/)?';
        i += 2;       // consume the second * and the /
      } else {
        src += '.*';
        i++;          // consume the second *
      }
    } else if (ch === '*') {
      src += '[^/]*';
    } else if (ch === '?') {
      src += '[^/]';
    } else if (/[.+^$()|[\]\\]/.test(ch)) {
      src += '\\' + ch;
    } else {
      src += ch;
    }
  }
  // Compile via re2 (linear-time, no backtracking) rather than the native
  // RegExp engine: even though `src` is built from a whitelisted glob
  // alphabet, a pathological agent-supplied pattern with many `**`/`*`
  // segments could in theory generate a regex that backtracks on the
  // native engine. re2 eliminates that class of risk entirely.
  return new RE2(src + '$', 'u').test(path);
}

async function walkFiles(root: string, base: string, out: string[]): Promise<void> {
  if (out.length >= WALK_FILE_CAP) return;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;  // common bulk skips
    // Symlinks are skipped outright. Descending a symlink dir could
    // exit the workspace (e.g. `proc -> /proc`), and surfacing symlink
    // files would let Grep return content from outside the workspace
    // through readFile-follows-symlink. Lstat-tier check (no I/O).
    if (e.isSymbolicLink()) continue;
    const full = join(root, e.name);
    const rel = relative(base, full);
    if (e.isDirectory()) {
      await walkFiles(full, base, out);
      if (out.length >= WALK_FILE_CAP) return;
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
}

/** Compile the agent-supplied pattern with re2-wasm (linear-time, no
 *  backtracking) so a maliciously-crafted pattern can't trigger catastrophic
 *  backtracking against this server's event loop. The 'u' flag is required
 *  by the re2-wasm binding. Returns the compiled matcher or a string error
 *  message that the caller passes back to the agent. */
function compileGrepPattern(patternStr: string, ignoreCase: boolean): { test(s: string): boolean } | string {
  try {
    return new RE2(patternStr, ignoreCase ? 'iu' : 'u');
  } catch (e) {
    return `error: invalid regex: ${(e as Error).message}`;
  }
}

/** Walk targetFiles, scan each line with `pattern`, collect at most
 *  GREP_RESULT_CAP `path:line:text` hits. Unreadable files are skipped
 *  silently — broken symlinks, perms mismatches, binary files that throw
 *  on UTF-8 decode all fall in this bucket and aren't worth surfacing. */
async function runGrep(opts: {
  cwd: string;
  rootPath: string;
  include: string;
  pattern: { test(s: string): boolean };
}): Promise<string[]> {
  const files: string[] = [];
  await walkFiles(opts.rootPath, opts.cwd, files);
  const targetFiles = opts.include ? files.filter(f => globMatch(opts.include, f)) : files;
  const hits: string[] = [];
  for (const rel of targetFiles) {
    if (hits.length >= GREP_RESULT_CAP) break;
    let content: string;
    try { content = await readFile(resolve(opts.cwd, rel), 'utf8'); }
    catch { continue; }
    scanLinesIntoHits(content, rel, opts.pattern, hits);
  }
  return hits;
}

/** Match every line in `content` against `pattern`, append `path:line:text`
 *  to `hits` for each match. Stops as soon as `hits` hits GREP_RESULT_CAP. */
function scanLinesIntoHits(content: string, rel: string, pattern: { test(s: string): boolean }, hits: string[]): void {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (hits.length >= GREP_RESULT_CAP) return;
    if (pattern.test(lines[i])) hits.push(`${rel}:${i + 1}:${lines[i]}`);
  }
}

export function buildProcessTools(workspaces: Workspace[]): RaTool[] {
  const cwd = workspaces[0]?.path;
  return [
    {
      name: 'Bash',
      description:
        'Run a shell command via /bin/bash -lc inside the agent\'s workspace cwd. ' +
        'Combined stdout+stderr returned (capped). Times out after 30s by default. ' +
        'The workspace must grant `exec` permission.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['command'],
        properties: {
          command: { type: 'string', description: 'Shell command to run.' },
          timeout_ms: { type: 'integer', minimum: 100, maximum: 60_000, description: 'Override timeout (max 60 seconds).' },
        },
      },
      handler: async (args) => {
        if (!cwd) return 'error: no workspace';
        const auth = checkToolUse('Bash', {}, workspaces);
        if (!auth.ok) return `denied: ${auth.reason}`;
        const command = asString(args.command);
        if (!command) return 'error: command required';
        const requestedTimeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : BASH_TIMEOUT_MS;
        const timeoutMs = Math.min(requestedTimeout, BASH_TIMEOUT_CEIL_MS);
        // Per-workspace concurrency cap. Refuse rather than queue — an
        // LLM that sees "too many" can react instead of stalling on a
        // wait that has no observability for it.
        const inflight = bashInflight.get(cwd) ?? 0;
        if (inflight >= BASH_MAX_INFLIGHT_PER_CWD) {
          return `error: too many concurrent Bash calls in flight (${inflight}/${BASH_MAX_INFLIGHT_PER_CWD}). ` +
            `Wait for one to complete before issuing another.`;
        }
        bashInflight.set(cwd, inflight + 1);
        try {
          logger.info('ra.process.bash', { cwd, cmd_preview: command.slice(0, 120) });
          return await runBash(command, cwd, timeoutMs);
        } finally {
          const n = (bashInflight.get(cwd) ?? 1) - 1;
          if (n <= 0) bashInflight.delete(cwd);
          else bashInflight.set(cwd, n);
        }
      },
    },
    {
      name: 'Glob',
      description:
        'Find files matching a simple glob pattern under the workspace. ' +
        'Supports `*` (any chars no slash), `**` (any chars incl. slash), `?` (one char no slash). ' +
        'Returns paths relative to the workspace root, capped at 500.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['pattern'],
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, e.g. `src/**/*.ts`.' },
          path: { type: 'string', description: 'Optional subdir to anchor the walk (relative to workspace).' },
        },
      },
      handler: async (args) => {
        if (!cwd) return 'error: no workspace';
        const auth = checkToolUse('Glob', { file_path: cwd }, workspaces);
        if (!auth.ok) return `denied: ${auth.reason}`;
        const pattern = asString(args.pattern);
        if (!pattern) return 'error: pattern required';
        const subdir = asString(args.path);
        const lexical = subdir ? resolve(cwd, subdir) : cwd;
        // Lexical guard first (cheap, catches `..` and absolute paths
        // pointing out of the workspace).
        if (!lexical.startsWith(cwd + sep) && lexical !== cwd) {
          return `error: path '${subdir}' resolves outside workspace`;
        }
        // realpath-tier check too: a symlink at `cwd/proj -> /etc` would
        // pass the lexical check but the walker would then list /etc.
        const canon = await canonicalizeUnderWorkspace(lexical, workspaces, 'read');
        if (!canon.ok) return `error: ${canon.reason}`;
        const rootPath = canon.canonical;
        let st;
        try { st = await stat(rootPath); } catch { return `error: path not found: ${subdir}`; }
        if (!st.isDirectory()) return `error: path is not a directory: ${subdir}`;
        const files: string[] = [];
        await walkFiles(rootPath, cwd, files);
        const matched = files.filter(f => globMatch(pattern, f)).slice(0, GLOB_FILE_CAP);
        logger.debug('ra.process.glob', { pattern, matched: matched.length });
        return matched.length === 0 ? '(no matches)' : matched.join('\n');
      },
    },
    {
      name: 'Grep',
      description:
        'Search file contents for a regex pattern under the workspace. ' +
        'Returns `path:line:text` lines, capped at 200. Honors an optional include glob ' +
        '(e.g. `*.ts`). Skips .git and node_modules by default.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['pattern'],
        properties: {
          pattern: { type: 'string', description: 'JS-flavored regex to match against each line.' },
          path: { type: 'string', description: 'Optional subdir to search (relative to workspace).' },
          include: { type: 'string', description: 'Optional file-glob filter, e.g. `*.ts` or `**/*.md`.' },
          ignore_case: { type: 'boolean' },
        },
      },
      handler: async (args) => {
        if (!cwd) return 'error: no workspace';
        const auth = checkToolUse('Grep', { file_path: cwd }, workspaces);
        if (!auth.ok) return `denied: ${auth.reason}`;
        const patternStr = asString(args.pattern);
        if (!patternStr) return 'error: pattern required';
        const pattern = compileGrepPattern(patternStr, args.ignore_case === true);
        if (typeof pattern === 'string') return pattern;
        const subdir = asString(args.path);
        const lexical = subdir ? resolve(cwd, subdir) : cwd;
        if (!lexical.startsWith(cwd + sep) && lexical !== cwd) {
          return `error: path '${subdir}' resolves outside workspace`;
        }
        const canon = await canonicalizeUnderWorkspace(lexical, workspaces, 'read');
        if (!canon.ok) return `error: ${canon.reason}`;
        const include = asString(args.include);
        const hits = await runGrep({ cwd, rootPath: canon.canonical, include, pattern });
        logger.debug('ra.process.grep', { pattern: patternStr, matched: hits.length });
        return hits.length === 0 ? '(no matches)' : hits.join('\n');
      },
    },
  ];
}
