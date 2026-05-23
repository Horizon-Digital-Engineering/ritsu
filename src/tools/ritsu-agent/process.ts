/**
 * Native process tools for the ritsu-agent runtime: Bash, Glob, Grep.
 * Tool names match the Claude SDK's so the per-agent tools_allowlist
 * selector works identically across both runtimes.
 *
 * Sandboxing: none yet. Bash runs as the host user (the `ritsu` service
 * account under systemd), `cwd` is set to the first workspace. The trust
 * boundary IS the workspace + the systemd unit's ProtectHome /
 * ProtectSystem / ReadWritePaths sandbox. A model with Bash + a writable
 * workspace can do anything that user could in that directory.
 * Stronger isolation (firejail / bwrap / per-call mount namespaces) is
 * a follow-up; documented in docs/threat-model.md A6.
 */
import { spawn } from 'node:child_process';
import { readdir, stat, readFile } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { RE2 } from 're2-wasm';
import type { Workspace } from '../../workspace-store.js';
import type { RaTool } from '../../model/ritsu-agent/types.js';
import { checkToolUse } from '../permissions.js';
import { logger } from '../../util/log.js';
import { asString } from '../../util/cast.js';

const BASH_TIMEOUT_MS = 30_000;
const BASH_OUTPUT_CAP = 30 * 1024; // 30KB combined stdout+stderr
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

/** Bash command runner. Spawns /bin/bash -c <cmd> with cwd set to the
 *  agent's first workspace. Output is captured + capped. Times out at
 *  BASH_TIMEOUT_MS. Caller can override timeout per-call. */
async function runBash(command: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise(resolveOuter => {
    const child = spawn('/bin/bash', ['-lc', command], {
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
          timeout_ms: { type: 'integer', minimum: 100, maximum: 300_000, description: 'Override timeout (max 5 minutes).' },
        },
      },
      handler: async (args) => {
        if (!cwd) return 'error: no workspace';
        const auth = checkToolUse('Bash', {}, workspaces);
        if (!auth.ok) return `denied: ${auth.reason}`;
        const command = asString(args.command);
        if (!command) return 'error: command required';
        const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : BASH_TIMEOUT_MS;
        logger.info('ra.process.bash', { cwd, cmd_preview: command.slice(0, 120) });
        return await runBash(command, cwd, timeoutMs);
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
        const rootPath = subdir ? resolve(cwd, subdir) : cwd;
        // Guard: subdir must still be inside the workspace.
        if (!rootPath.startsWith(cwd + sep) && rootPath !== cwd) {
          return `error: path '${subdir}' resolves outside workspace`;
        }
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
        const rootPath = subdir ? resolve(cwd, subdir) : cwd;
        if (!rootPath.startsWith(cwd + sep) && rootPath !== cwd) {
          return `error: path '${subdir}' resolves outside workspace`;
        }
        const include = asString(args.include);
        const hits = await runGrep({ cwd, rootPath, include, pattern });
        logger.debug('ra.process.grep', { pattern: patternStr, matched: hits.length });
        return hits.length === 0 ? '(no matches)' : hits.join('\n');
      },
    },
  ];
}
