/**
 * PATH-safe wrapper around `node:child_process` spawnSync.
 *
 * Problem: calling `spawnSync('systemctl', ...)` resolves the binary against
 * the inherited `PATH`. If anything in PATH is operator-writable (e.g. a
 * stray `/tmp/bin` someone added to their shell rc, a misconfigured
 * sudoers `secure_path`, a compromised package install location), an
 * attacker who can write a shell script named `systemctl` to that
 * directory can substitute their binary for the real one. SonarQube
 * S4036 flags every PATH-resolved spawn for exactly this reason.
 *
 * Solution: this module exposes a `spawnSync` that resolves bare command
 * names against a hardcoded, audit-reviewable list of trusted system
 * directories (`TRUSTED_BIN_DIRS`). Anything outside that list is
 * refused — the helper throws, the caller fails loud. Already-absolute
 * paths pass through unchanged.
 *
 * One central security boundary. Every callsite imports `spawnSync` from
 * here instead of from `node:child_process`. Resolution is cached so the
 * filesystem checks happen once per (process, binary).
 *
 * Trade-offs we accept:
 *   - On a host with binaries outside the trusted dirs (e.g. a tailscale
 *     installed via `curl | sh` into /opt), callers will throw. Operators
 *     fix that by symlinking the binary into a trusted dir or by
 *     extending TRUSTED_BIN_DIRS here (with a code review).
 *   - We don't enforce ownership/mode of the binary itself. The
 *     directories in TRUSTED_BIN_DIRS are expected to be root-owned;
 *     verifying that on every call would add cost without changing the
 *     trust story (if root is compromised, the bins are already gone).
 */
import {
  spawnSync as nativeSpawnSync,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from 'node:child_process';
import { statSync } from 'node:fs';

/**
 * Directories we'll resolve a bare command name against, in PATH order.
 * Every dir in this list must be a fixed, root-owned location. Adding
 * a dir is a security decision — review carefully.
 */
const TRUSTED_BIN_DIRS = [
  '/usr/local/sbin',
  '/usr/local/bin',
  '/usr/sbin',
  '/usr/bin',
  '/sbin',
  '/bin',
] as const;

/** Cache of resolved binary paths so resolveBin runs statSync once per name. */
const resolved = new Map<string, string>();

/**
 * Resolve a binary name to an absolute path under TRUSTED_BIN_DIRS, or
 * accept an already-absolute path as-is. Throws on miss so the caller
 * fails fast and visibly — better than silently falling back to PATH.
 */
function resolveBin(name: string): string {
  if (name.startsWith('/')) return name;
  const cached = resolved.get(name);
  if (cached !== undefined) return cached;
  for (const dir of TRUSTED_BIN_DIRS) {
    const candidate = `${dir}/${name}`;
    try {
      const st = statSync(candidate);
      // Executable file: regular file with at least one execute bit set.
      // We don't check owner/mode beyond that — TRUSTED_BIN_DIRS membership
      // is the trust boundary, not file metadata.
      if (st.isFile() && (st.mode & 0o111) !== 0) {
        resolved.set(name, candidate);
        return candidate;
      }
    } catch {
      // ENOENT (or any stat failure) → try the next dir. Errors that
      // aren't "not found" still imply we should move on; if every dir
      // fails we throw below.
    }
  }
  throw new Error(
    `safe-spawn: binary '${name}' not found in any trusted bin dir (${TRUSTED_BIN_DIRS.join(', ')}). ` +
    `Install the package providing '${name}' to a standard system location, or extend TRUSTED_BIN_DIRS after review.`,
  );
}

/**
 * Drop-in replacement for child_process.spawnSync. Same signature; the
 * only behaviour change is that `cmd` is resolved against TRUSTED_BIN_DIRS
 * instead of $PATH (or used as-is if it's already absolute).
 *
 * The generic mirrors node's typing — `string` (default) for text mode,
 * `Buffer` when called with `encoding: 'buffer'` or no encoding.
 */
export function spawnSync<T extends Buffer | string = string>(
  cmd: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<T> {
  return nativeSpawnSync(resolveBin(cmd), args, options) as SpawnSyncReturns<T>;
}

/** Exposed for tests so they can clear the resolution cache between runs. */
export function _resetResolveCacheForTests(): void {
  resolved.clear();
}
