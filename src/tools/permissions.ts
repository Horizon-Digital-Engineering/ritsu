import { resolve } from 'node:path';
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
 * Returns { ok: true } if allowed; { ok: false, reason } otherwise.
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

  // For commands, target = cwd (the agent's working dir). For file tools,
  // target = the file_path/path arg, resolved absolute.
  const cwd = workspaces[0]?.path;
  const rawPath = (input.file_path ?? input.path) as string | undefined;
  // Bash always operates from cwd; file tools resolve their path argument
  // against cwd if relative. Falls back to cwd alone when no path arg given.
  let target: string | undefined;
  if (toolName === 'Bash') target = cwd;
  else if (rawPath)         target = resolve(cwd ?? process.cwd(), rawPath);
  else                       target = cwd;

  if (!target) {
    return { ok: false, reason: `${toolName}: no workspace and no target path` };
  }

  // Allow if any workspace covers target with the needed permission.
  for (const ws of workspaces) {
    if (isUnder(target, ws.path) && ws.permissions.includes(needed)) {
      return { ok: true };
    }
  }
  return {
    ok: false,
    reason: `${toolName}: no workspace grants '${needed}' on '${target}'`,
  };
}

/** True iff `target` is the workspace path or a descendant of it. */
function isUnder(target: string, workspace: string): boolean {
  const t = resolve(target);
  const w = resolve(workspace);
  return t === w || t.startsWith(w + '/');
}
