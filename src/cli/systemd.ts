/**
 * systemd / journalctl helpers for the CLI. Shell out to /usr/bin/systemctl
 * because there's no usable Node binding; behaviour matches what an operator
 * would type at the shell. All callers assume root (the CLI re-execs under
 * sudo when needed).
 */
import { spawnSync } from '../util/safe-spawn.js';

export const SERVICE_NAME = process.env.RITSU_SERVICE ?? 'ritsu.service';

export function daemonReload(): void {
  const r = spawnSync('systemctl', ['daemon-reload'], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('systemctl daemon-reload failed');
}

export function restartService(): void {
  const r = spawnSync('systemctl', ['restart', SERVICE_NAME], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`systemctl restart ${SERVICE_NAME} failed`);
}

export function statusService(): number {
  const r = spawnSync('systemctl', ['--no-pager', 'status', SERVICE_NAME], { stdio: 'inherit' });
  return r.status ?? 0;
}

export function logsService(follow: boolean, lines: number): number {
  const args = ['-u', SERVICE_NAME, '--no-pager'];
  if (follow) args.push('-f');
  else args.push('-n', String(lines));
  const r = spawnSync('journalctl', args, { stdio: 'inherit' });
  return r.status ?? 0;
}

/**
 * Maps an absolute mountpoint to its systemd .mount unit name, or null.
 *
 * The unit name is the path with /-separators rewritten as -, hyphens
 * themselves \x2d-escaped (see systemd.unit(5)). We use `systemd-escape -p`
 * to get the canonical form, then verify the unit is actually active.
 *
 * Doesn't parse `systemctl list-units` output — that's brittle because the
 * Description column can contain spaces (so awk-style last-field extraction
 * was returning a description word, not the mountpoint, when descriptions
 * were multi-word).
 */
export function mountUnitFor(path: string): string | null {
  if (!path.startsWith('/')) return null;
  const escaped = spawnSync('systemd-escape', ['-p', path], { encoding: 'utf8' });
  if (escaped.status !== 0) return null;
  const unit = `${escaped.stdout.trim()}.mount`;
  if (!unit) return null;
  const active = spawnSync('systemctl', ['is-active', unit], { encoding: 'utf8' });
  // is-active returns 'active', 'inactive', 'failed', etc.; only 'active'
  // means this unit name maps to a currently-mounted share.
  if (active.stdout.trim() !== 'active') return null;
  return unit;
}
