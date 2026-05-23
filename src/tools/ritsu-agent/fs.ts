/**
 * Native filesystem tools for the ritsu-agent runtime. Same wire-format
 * names as the Claude SDK built-ins (Read, Write, Edit) so the per-agent
 * `tools_allowlist` selector works identically for both runtimes — the
 * string "Read" enables read-the-file behavior whether the agent is
 * claude-sdk (Anthropic's implementation) or ritsu-agent (this one).
 *
 * Every call routes through two checks:
 *
 *   1. `checkToolUse` — lexical workspace containment + permission. Cheap;
 *      rejects obvious `../../etc/passwd` traversal up-front.
 *   2. `canonicalizeUnderWorkspace` — re-resolves via `fs.realpath` so
 *      symlink-based escapes (`workspace/secret -> /etc/shadow`) can't
 *      slip past the lexical check. Returns a canonical path; we operate
 *      on THAT, not on the original input.
 *
 * Write/Edit additionally `lstat` the target to refuse writing THROUGH
 * a symlink at the final segment — even if the symlink's target is
 * inside the workspace, allowing it to be the named entry would let an
 * agent shadow legitimate files with redirected ones.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

import type { Workspace } from '../../workspace-store.js';
import type { RaTool } from '../../model/ritsu-agent/types.js';
import {
  checkToolUse,
  canonicalizeUnderWorkspace,
  assertNotSymlink,
} from '../permissions.js';
import { logger } from '../../util/log.js';
import { asString } from '../../util/cast.js';

const DEFAULT_READ_LIMIT = 2000;       // lines, matches the Claude SDK Read default
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB read cap

function cwdOf(workspaces: Workspace[]): string | undefined {
  return workspaces[0]?.path;
}

function resolvePath(rawPath: string, workspaces: Workspace[]): string | null {
  if (rawPath.startsWith('/')) return rawPath;
  const cwd = cwdOf(workspaces);
  return cwd ? resolve(cwd, rawPath) : null;
}

export function buildFsTools(workspaces: Workspace[]): RaTool[] {
  return [
    {
      name: 'Read',
      description:
        'Read a file from the filesystem. Returns the file content with line numbers (1-indexed). ' +
        'Use offset/limit for large files (default reads first 2000 lines).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['file_path'],
        properties: {
          file_path: { type: 'string', description: 'Absolute or relative-to-workspace path of the file to read.' },
          offset: { type: 'integer', minimum: 0, description: '0-indexed line number to start reading from.' },
          limit: { type: 'integer', minimum: 1, maximum: 10000, description: 'Max lines to read (default 2000).' },
        },
      },
      handler: async (args) => {
        const rawPath = asString(args.file_path);
        if (!rawPath) return 'error: file_path required';
        const abs = resolvePath(rawPath, workspaces);
        if (!abs) return 'error: relative path with no workspace cwd';
        const auth = checkToolUse('Read', { file_path: abs }, workspaces);
        if (!auth.ok) return `denied: ${auth.reason}`;
        const canon = await canonicalizeUnderWorkspace(abs, workspaces, 'read');
        if (!canon.ok) return `denied: ${canon.reason}`;
        try {
          const buf = await readFile(canon.canonical);
          if (buf.byteLength > MAX_FILE_BYTES) {
            return `error: file too large (${buf.byteLength} bytes > ${MAX_FILE_BYTES} cap)`;
          }
          const lines = buf.toString('utf8').split('\n');
          const offset = typeof args.offset === 'number' ? args.offset : 0;
          const limit = typeof args.limit === 'number' ? args.limit : DEFAULT_READ_LIMIT;
          const slice = lines.slice(offset, offset + limit);
          const out = slice.map((line, i) => `${String(offset + i + 1).padStart(6, ' ')}\t${line}`).join('\n');
          logger.debug('ra.fs.read', { abs: canon.canonical, lines: slice.length });
          return out;
        } catch (err) {
          return `error: ${(err as Error).message}`;
        }
      },
    },
    {
      name: 'Write',
      description:
        'Write or overwrite a file. Creates parent directories if needed. Returns confirmation with bytes written.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['file_path', 'content'],
        properties: {
          file_path: { type: 'string', description: 'Absolute or relative-to-workspace path.' },
          content: { type: 'string', description: 'Full file content (replaces existing).' },
        },
      },
      handler: async (args) => {
        const rawPath = asString(args.file_path);
        if (!rawPath) return 'error: file_path required';
        const content = asString(args.content);
        const abs = resolvePath(rawPath, workspaces);
        if (!abs) return 'error: relative path with no workspace cwd';
        const auth = checkToolUse('Write', { file_path: abs }, workspaces);
        if (!auth.ok) return `denied: ${auth.reason}`;
        const canon = await canonicalizeUnderWorkspace(abs, workspaces, 'write');
        if (!canon.ok) return `denied: ${canon.reason}`;
        const noSym = await assertNotSymlink(canon.canonical);
        if (!noSym.ok) return `denied: ${noSym.reason}`;
        try {
          await mkdir(dirname(canon.canonical), { recursive: true });
          await writeFile(canon.canonical, content, 'utf8');
          logger.info('ra.fs.write', { abs: canon.canonical, bytes: Buffer.byteLength(content, 'utf8') });
          return `wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${canon.canonical}`;
        } catch (err) {
          return `error: ${(err as Error).message}`;
        }
      },
    },
    {
      name: 'Edit',
      description:
        'Edit a file by replacing exactly one occurrence of `old_string` with `new_string`. ' +
        'old_string must match exactly (including whitespace) and appear EXACTLY ONCE in the file ' +
        '— if it appears multiple times, the edit fails to avoid ambiguity. Use Write for whole-file replace.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['file_path', 'old_string', 'new_string'],
        properties: {
          file_path: { type: 'string' },
          old_string: { type: 'string', description: 'Text to replace. Must match exactly + appear once.' },
          new_string: { type: 'string', description: 'Replacement text.' },
        },
      },
      handler: async (args) => {
        const rawPath = asString(args.file_path);
        if (!rawPath) return 'error: file_path required';
        const oldStr = asString(args.old_string);
        const newStr = asString(args.new_string);
        if (!oldStr) return 'error: old_string required (and must be non-empty)';
        const abs = resolvePath(rawPath, workspaces);
        if (!abs) return 'error: relative path with no workspace cwd';
        const auth = checkToolUse('Edit', { file_path: abs }, workspaces);
        if (!auth.ok) return `denied: ${auth.reason}`;
        const canon = await canonicalizeUnderWorkspace(abs, workspaces, 'write');
        if (!canon.ok) return `denied: ${canon.reason}`;
        const noSym = await assertNotSymlink(canon.canonical);
        if (!noSym.ok) return `denied: ${noSym.reason}`;
        try {
          const original = await readFile(canon.canonical, 'utf8');
          const count = countOccurrences(original, oldStr);
          if (count === 0) return `error: old_string not found in ${canon.canonical}`;
          if (count > 1) return `error: old_string appears ${count} times — pass more surrounding context so it's unique`;
          const updated = original.replace(oldStr, newStr);
          await writeFile(canon.canonical, updated, 'utf8');
          logger.info('ra.fs.edit', { abs: canon.canonical });
          return `edited ${canon.canonical}`;
        } catch (err) {
          return `error: ${(err as Error).message}`;
        }
      },
    },
  ];
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let i = 0; let n = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}
