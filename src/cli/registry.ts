import { pathCommand } from './commands/path.js';
import { serviceCommand } from './commands/service.js';
import { tokenCommand } from './commands/token.js';
import { adminTokenCommand } from './commands/admin-token.js';
import { masterKeyCommand } from './commands/master-key.js';
import { envCommand } from './commands/env.js';
import { urlCommand } from './commands/url.js';
import { doctorCommand } from './commands/doctor.js';

export interface CommandContext {
  subcommand: string | null;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export interface Command {
  name: string;
  summary: string;
  /** True if any subcommand of this group needs root. */
  needsRoot: boolean;
  help: () => string;
  run: (ctx: CommandContext) => Promise<number>;
}

export const ALL_COMMANDS: Command[] = [
  pathCommand,
  serviceCommand,
  tokenCommand,
  adminTokenCommand,
  masterKeyCommand,
  envCommand,
  urlCommand,
  doctorCommand,
];
