import { resolve, dirname, basename, sep } from 'node:path';
import { realpath, lstat } from 'node:fs/promises';

import type { Workspace, Permission } from '../workspace-store.js';

/**
 * Maps a Claude SDK tool name → the workspace permission it needs.
 * - Read / Glob / Grep operate on files: need 'read'
 * - Write / Edit modify files:           need 'write'
 * - Bash runs arbitrary commands:        need 'exec'
 * - WebFetch / WebSearch hit the network: no workspace permission needed
 *
 * Tools not in the map are denied by default (fail-closed). Add new entries
 * here as the SDK exposes more built-in tools.
 */
export const TOOL_PERMISSION: Record<string, Permission | 'network'> = {
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  Write: 'write',
  Edit: 'write',
  Bash: 'exec',
  WebFetch: 'network',
  WebSearch: 'network',
};

/**
 * Pseudo-filesystem trees that no workspace should ever cover. `/proc` and
 * `/sys` expose other processes' env + kernel state; `/dev` includes special
 * files (`/dev/random` can wedge an agent turn, `/dev/zero` floods reads).
 * Anything under these is rejected regardless of the workspace allowlist.
 */
const PSEUDO_FS_ROOTS = ['/proc', '/sys', '/dev'] as const;

/** Result of a per-tool authorization check. */
export type AuthCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Check whether a tool invocation is allowed under the agent's workspaces.
 *
 * Path resolution: any tool input field named `file_path` or `path` is
 * resolved to an absolute path and checked against each workspace root with
 * the required permission. Bash uses the agent's cwd (workspaces[0]) for
 * the exec check rather than parsing the command — that's a V0.5+ concern.
 *
 * NOTE: this function is synchronous and does a LEXICAL containment check
 * only. For file-touching tools (Read/Write/Edit/Glob/Grep), callers MUST
 * also call `canonicalizeUnderWorkspace` to resolve symlinks and re-check
 * containment, because lexical resolve can't see through a symlink-based
 * escape. See ssrf-guard.ts for the same defense-in-depth pattern on the
 * network side.
 */
export function checkToolUse(
  toolName: string,
  input: Record<string, unknown>,
  workspaces: Workspace[],
): AuthCheck {
  const needed = TOOL_PERMISSION[toolName];
  if (needed === undefined) {
    return { ok: false, reason: `tool '${toolName}' is not in the permission map` };
  }
  if (needed === 'network') {
    return { ok: true };  // no filesystem implication
  }

  const resolved = resolveTarget(toolName, input, workspaces);
  if (resolved.deny) return resolved.deny;
  const target = resolved.target;

  if (!target) {
    return { ok: false, reason: `${toolName}: no workspace and no target path` };
  }

  // Pseudo-FS deny-list runs before the workspace check so even a
  // misconfigured workspace that happens to overlap with `/proc/...`
  // can't grant read on those trees.
  const deniedRoot = pseudoFsDeniedRoot(target);
  if (deniedRoot) {
    return { ok: false, reason: `${toolName}: ${deniedRoot} tree is denied (pseudo-filesystem)` };
  }

  if (anyWorkspaceGrants(target, workspaces, needed)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `${toolName}: no workspace grants '${needed}' on '${target}'`,
  };
}

/** For commands, target = cwd (the agent's working dir). For file tools,
 *  target = the file_path/path arg, resolved absolute against cwd. */
function resolveTarget(
  toolName: string,
  input: Record<string, unknown>,
  workspaces: Workspace[],
): { target?: string; deny?: AuthCheck } {
  const cwd = workspaces[0]?.path;
  const rawPath = (input.file_path ?? input.path) as string | undefined;
  if (toolName === 'Bash') {
    return { target: cwd };
  }
  if (rawPath) {
    if (!cwd && !rawPath.startsWith('/')) {
      return { deny: { ok: false, reason: `${toolName}: relative path with no workspace cwd` } };
    }
    return { target: cwd ? resolve(cwd, rawPath) : rawPath };
  }
  return { target: cwd };
}

/** The pseudo-FS root `path` falls under, or null when it's clear of them all. */
function pseudoFsDeniedRoot(path: string): string | null {
  for (const root of PSEUDO_FS_ROOTS) {
    if (path === root || path.startsWith(root + sep)) return root;
  }
  return null;
}

/** True when any workspace covers `target` with the needed permission. */
function anyWorkspaceGrants(target: string, workspaces: Workspace[], needed: Permission): boolean {
  for (const ws of workspaces) {
    if (isUnder(target, ws.path) && ws.permissions.includes(needed)) return true;
  }
  return false;
}

/** True iff `target` is the workspace path or a descendant of it. Uses
 *  `path.sep` plus normalized resolution so trailing-slash sloppiness and
 *  prefix-confusion (`/srv/foo` matching `/srv/foobar`) can't sneak past. */
function isUnder(target: string, workspace: string): boolean {
  const t = resolve(target);
  const w = resolve(workspace);
  return t === w || t.startsWith(w + sep);
}

export interface CanonicalOk { ok: true; canonical: string }
export interface CanonicalErr { ok: false; reason: string }
export type CanonicalResult = CanonicalOk | CanonicalErr;

/**
 * Resolve `abs` through any symlinks and verify the canonical path still
 * sits inside one of the agent's workspaces. This is the layer that closes
 * the symlink-escape gap: `checkToolUse` does a lexical check (sufficient
 * to reject obvious traversal like `../../etc/passwd`), but an attacker who
 * can write into the workspace can plant `secret -> /etc/shadow` and
 * subsequent lexical checks pass. `realpath` here re-resolves on every
 * call, so the symlink is followed and the canonical path is checked.
 *
 * For paths that don't yet exist (Write to a new file), realpath the
 * parent directory and rebuild `<parent_canonical>/<basename>`. This
 * preserves the containment check while still allowing creation.
 *
 * Also re-applies the pseudo-FS deny-list against the canonical path —
 * a symlink `proc -> /proc` is the obvious escape vector that lexical
 * check + realpath together close.
 *
 * Caller still needs to OPEN the returned `canonical` path (not the
 * original) so the resolved symlink can't be re-aimed between this check
 * and the open. Operations within a single agent's tool calls are
 * sequential, so the cross-call TOCTOU is the realistic concern, not the
 * sub-call one.
 */
export async function canonicalizeUnderWorkspace(
  abs: string,
  workspaces: Workspace[],
  needed: Permission,
): Promise<CanonicalResult> {
  const res = await canonicalizeAllowMissing(abs);
  if (!res.ok) return res;
  const canonical = res.canonical;

  for (const root of PSEUDO_FS_ROOTS) {
    if (canonical === root || canonical.startsWith(root + sep)) {
      return { ok: false, reason: `${root} tree is denied (pseudo-filesystem)` };
    }
  }

  for (const ws of workspaces) {
    let wsCanonical: string;
    try { wsCanonical = await realpath(ws.path); } catch { wsCanonical = resolve(ws.path); }
    if (isUnder(canonical, wsCanonical) && ws.permissions.includes(needed)) {
      return { ok: true, canonical };
    }
  }
  return { ok: false, reason: `no workspace grants '${needed}' on canonical path '${canonical}'` };
}

/**
 * Canonicalize `abs` even when intermediate path segments don't exist
 * yet (Write to a new file 3 levels deep into a yet-to-be-created
 * subdirectory tree). Walk upward from `abs` until we find an existing
 * ancestor, realpath that, then append the missing trailing segments.
 *
 * If the file ITSELF exists, this is equivalent to `realpath(abs)`. If
 * NONE of `abs`'s ancestors exist (e.g. typo'd root), returns the
 * realpath of `/` (or the root the path is anchored to) plus the
 * untouched suffix — which then fails the workspace containment check,
 * which is the correct outcome.
 */
async function canonicalizeAllowMissing(abs: string): Promise<CanonicalResult> {
  let candidate = abs;
  const trailing: string[] = [];
  // Walk up until realpath succeeds or we hit the root.
  while (true) {
    try {
      const real = await realpath(candidate);
      // Reassemble: <existing-canonical>/<missing-suffix>
      const suffix = trailing.toReversed().join(sep);
      return { ok: true, canonical: suffix ? resolve(real, suffix) : real };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') {
        return { ok: false, reason: `realpath failed: ${e.message}` };
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        // Reached filesystem root and still couldn't realpath — pathological,
        // refuse rather than guess.
        return { ok: false, reason: `cannot canonicalize ${abs}: no ancestor exists` };
      }
      trailing.push(basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * Refuse to open a symlink at the final segment, even if `canonical`
 * containment passed. Used by Write/Edit to avoid writing THROUGH a
 * symlink that points elsewhere — `canonicalizeUnderWorkspace` validates
 * where the symlink TARGETS, but writing TO the symlink-named entry then
 * follows it. lstat is the cheap check.
 */
export async function assertNotSymlink(p: string): Promise<CanonicalResult> {
  try {
    const st = await lstat(p);
    if (st.isSymbolicLink()) {
      return { ok: false, reason: `refusing to operate on symlink: ${p}` };
    }
    return { ok: true, canonical: p };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { ok: true, canonical: p };  // doesn't exist → fine
    return { ok: false, reason: `lstat failed: ${e.message}` };
  }
}
