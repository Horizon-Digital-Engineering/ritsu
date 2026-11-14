const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date; the operator's day, not UTC's. */
export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromIso(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** "November 13, 2026" */
export function longDate(iso: string): string {
  return fromIso(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** "Friday, November 13, 2026" */
export function longDateWithDay(iso: string): string {
  return fromIso(iso).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

export function daysUntil(iso: string, from = localDate()): number {
  return Math.round((fromIso(iso).getTime() - fromIso(from).getTime()) / 86_400_000);
}

export function dueLabel(iso: string, from = localDate()): string {
  const n = daysUntil(iso, from);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n < 0 ? `${-n} days overdue` : `in ${n} days`;
}

export function sessionTitle(date: string, topic: string): string {
  const suffix = topic ? ` · ${topic}` : '';
  return `Tasks — ${longDate(date)}${suffix}`;
}
