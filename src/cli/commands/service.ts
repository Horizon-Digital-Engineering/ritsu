/**
 * `ritsu service` — status / restart / logs. Thin wrapper around systemctl
 * + journalctl so the operator doesn't have to remember the service name.
 */
import type { Command, CommandContext } from '../registry.js';
import { restartService, statusService, logsService } from '../systemd.js';

export const serviceCommand: Command = {
  name: 'service',
  summary: 'control the ritsu systemd service (status, restart, logs)',
  needsRoot: true,
  help: () => [
    'ritsu service — control the systemd service',
    '',
    '  ritsu service status              show running state',
    '  ritsu service restart             restart ritsu.service',
    '  ritsu service logs [--follow]     last 100 log lines (or follow)',
    '                     [--lines N]    lines for non-follow mode (default 100)',
  ].join('\n'),
  run: async (ctx: CommandContext) => {
    switch (ctx.subcommand) {
      case 'status': case null:
        return statusService();
      case 'restart':
        restartService();
        return 0;
      case 'logs': {
        const follow = ctx.flags.follow === true || ctx.flags.f === true;
        const lines = Number(ctx.flags.lines ?? 100);
        return logsService(follow, Number.isFinite(lines) ? lines : 100);
      }
      default:
        console.error(`unknown subcommand: ${ctx.subcommand}`);
        return 2;
    }
  },
};
