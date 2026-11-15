/** Off means not set up or not needed: it never makes the summary worse. */
export type PartStatus = 'ok' | 'warn' | 'fail' | 'off';

export type PartId =
  | 'database' | 'secrets' | 'subscription' | 'agents' | 'mcp'
  | 'voice' | 'backups' | 'scheduler' | 'plugins' | 'channels';

/** The note is read without logging in, so it never carries names, paths, URLs or error text. */
export interface Part {
  id: PartId;
  label: string;
  status: PartStatus;
  note: string;
}

export interface HealthSummary {
  name: 'ritsu';
  status: 'ok' | 'warn' | 'fail';
  version: string;
  uptime_s: number;
  parts: Part[];
}
