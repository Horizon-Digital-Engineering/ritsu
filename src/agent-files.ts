/**
 * Operator file access to an agent's workspace roots — the storage layer
 * behind the workspace UI's file browser (list / download / upload / delete).
 *
 * Containment reuses the SAME hardened guards the agent FS tools run behind
 * (realpath canonicalization, pseudo-filesystem deny-list, refuse-symlinks),
 * so a crafted path or planted link can't reach outside a workspace root.
 * The agent's per-root read/write PERMISSION flags are deliberately NOT
 * enforced here: those govern what the AGENT may do. The operator provisioning
 * reference files into a root the agent can only read is the normal case, not
 * a violation — so the guard runs against permission-widened copies of the
 * roots, keeping containment while ignoring the agent-facing flags.
 */
import { readdirSync, lstatSync } from 'node:fs';
import { open, mkdir, unlink, lstat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import type { Workspace } from './workspace-store.js';
import { canonicalizeUnderWorkspace, assertNotSymlink } from './tools/permissions.js';
import { logger } from './util/log.js';

/** Hard caps: a workspace can be a whole repo; the browser is for the files an
 *  operator manages, not an index of node_modules. */
const MAX_ENTRIES = 5000;
const MAX_DEPTH = 8;
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', '__pycache__', '.venv']);
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export interface WorkspaceFile {
  /** Canonical absolute path — the identity file tags are stored under. */
  path: string;
  /** Path relative to its workspace root, for display. */
  rel: string;
  /** The workspace root this file lives under. */
  root: string;
  size: number;
  mtime: number;
}

export interface FileListing {
  files: WorkspaceFile[];
  /** True when MAX_ENTRIES stopped the walk early — the listing is a window,
   *  not the whole truth, and the UI must say so. */
  truncated: boolean;
}

/** The guard checks agent permissions; the operator is not the agent. Widen a
 *  COPY of the roots so containment still binds but the flags don't. */
function operatorView(workspaces: Workspace[]): Workspace[] {
  return workspaces.map(w => ({ ...w, permissions: ['read', 'write'] }));
}

/**
 * Walk every workspace root, depth- and count-capped. Symlinks are listed as
 * neither files nor directories — they're skipped entirely, matching the
 * write path's refusal to operate through them.
 */
export function listFiles(workspaces: Workspace[]): FileListing {
  const files: WorkspaceFile[] = [];
  let truncated = false;

  const walk = (root: string, dir: string, depth: number): void => {
    if (truncated || depth > MAX_DEPTH) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }  // unreadable dir: skip, don't fail the whole listing
    for (const e of entries) {
      if (files.length >= MAX_ENTRIES) { truncated = true; return; }
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(root, p, depth + 1);
        continue;
      }
      if (!e.isFile() || e.name.startsWith('.')) continue;
      let st;
      try { st = lstatSync(p); } catch { continue; }
      files.push({
        path: p,
        rel: relative(root, p),
        root,
        size: st.size,
        mtime: Math.floor(st.mtimeMs / 1000),
      });
    }
  };

  for (const ws of workspaces) {
    const root = resolve(ws.path);
    walk(root, root, 0);
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return { files, truncated };
}

export interface FileResult<T> { ok: true; value: T }
export interface FileError { ok: false; reason: string }

/** Canonicalize + contain a path against the roots. Every operation below
 *  funnels through this — there is no second path-handling code path. */
async function contain(
  rawPath: string,
  workspaces: Workspace[],
): Promise<{ ok: true; canonical: string } | FileError> {
  if (workspaces.length === 0) return { ok: false, reason: 'agent has no workspaces' };
  const abs = rawPath.startsWith('/') ? rawPath : resolve(workspaces[0].path, rawPath);
  const res = await canonicalizeUnderWorkspace(abs, operatorView(workspaces), 'read');
  if (!res.ok) return { ok: false, reason: res.reason };
  const link = await assertNotSymlink(res.canonical);
  if (!link.ok) return { ok: false, reason: link.reason };
  return { ok: true, canonical: res.canonical };
}

export async function readWorkspaceFile(
  rawPath: string,
  workspaces: Workspace[],
): Promise<FileResult<{ canonical: string; data: Buffer }> | FileError> {
  const c = await contain(rawPath, workspaces);
  if (!c.ok) return c;
  // Everything below happens through ONE descriptor. contain() proved the
  // path safe, but an agent writing inside the root could swap file→symlink
  // between that check and the read; O_NOFOLLOW makes the open itself fail
  // on a symlink, so there is no window to race.
  let fh;
  try { fh = await open(c.canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch { return { ok: false, reason: 'no such file' }; }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { ok: false, reason: 'not a regular file' };
    if (st.size > MAX_DOWNLOAD_BYTES) {
      return { ok: false, reason: `file is ${st.size} bytes; the download cap is ${MAX_DOWNLOAD_BYTES}` };
    }
    const data = await fh.readFile();
    return { ok: true, value: { canonical: c.canonical, data } };
  } finally {
    await fh.close();
  }
}

export async function writeWorkspaceFile(
  rawPath: string,
  data: Buffer,
  workspaces: Workspace[],
  overwrite: boolean,
): Promise<FileResult<{ canonical: string }> | FileError> {
  if (data.length > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: `upload is ${data.length} bytes; the cap is ${MAX_UPLOAD_BYTES}` };
  }
  const c = await contain(rawPath, workspaces);
  if (!c.ok) return c;
  // Parent dirs may be new (uploading into a fresh subfolder) — but the
  // parent must still canonicalize inside a root, which contain() proved
  // for the leaf, and mkdir cannot escape what resolve already pinned.
  await mkdir(dirname(c.canonical), { recursive: true });
  // One open enforces everything atomically: O_EXCL is the no-overwrite
  // answer (no exists-then-write race), and O_NOFOLLOW on the overwrite
  // path refuses a symlink swapped in after contain() checked — otherwise
  // the write would land wherever the link points.
  const flags = overwrite
    ? fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW
    : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
  let fh;
  try { fh = await open(c.canonical, flags, 0o644); }
  catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EEXIST') return { ok: false, reason: 'file exists; pass overwrite to replace it' };
    if (e.code === 'ELOOP') return { ok: false, reason: 'refusing to write through a symlink' };
    return { ok: false, reason: `open failed: ${e.message}` };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { ok: false, reason: 'not a regular file' };
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
  logger.info('workspace-file.written', { path: c.canonical, bytes: data.length });
  return { ok: true, value: { canonical: c.canonical } };
}

export async function deleteWorkspaceFile(
  rawPath: string,
  workspaces: Workspace[],
): Promise<FileResult<{ canonical: string }> | FileError> {
  const c = await contain(rawPath, workspaces);
  if (!c.ok) return c;
  let st;
  try { st = await lstat(c.canonical); }
  catch { return { ok: false, reason: 'no such file' }; }
  if (!st.isFile()) return { ok: false, reason: 'not a regular file' };
  await unlink(c.canonical);
  logger.info('workspace-file.deleted', { path: c.canonical });
  return { ok: true, value: { canonical: c.canonical } };
}

/** Used by the tag route: a tag must reference a real, contained file. */
export async function canonicalIfContained(
  rawPath: string,
  workspaces: Workspace[],
): Promise<string | null> {
  const c = await contain(rawPath, workspaces);
  if (!c.ok) return null;
  try {
    const st = await lstat(c.canonical);
    return st.isFile() ? c.canonical : null;
  } catch { return null; }
}

