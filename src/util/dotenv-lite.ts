// Tiny .env loader — replacement for the dotenv dependency.
//
// What dotenv buys us: read KEY=VALUE lines from `.env`, populate
// process.env without overwriting existing entries. That's it. The
// rest of dotenv (multi-line strings, $VAR expansion, .env.local
// precedence chains) isn't anything we use. This file is everything.
//
// Format supported:
//   - Lines of the form  KEY=value
//   - Leading/trailing whitespace on key + value is trimmed.
//   - Single- or double-quoted values: `KEY="foo bar"` / `KEY='foo'`.
//     Quotes are stripped; no escape-sequence processing.
//   - Comments start with `#` (whole line) or appear after the value on
//     an unquoted line preceded by whitespace: `KEY=val  # note`.
//   - Blank lines and `export KEY=...` prefixes are tolerated.
//   - Existing process.env entries are NOT overwritten (same as dotenv's
//     default), so shell-set values win over the file.

import { readFileSync } from 'node:fs';

export function loadDotenv(path = '.env'): { loaded: number; path: string } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // File missing is the expected case in prod (env comes from systemd /
    // the host). Not an error.
    return { loaded: 0, path };
  }
  let count = 0;
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const { key, value } = parsed;
    if (key in process.env) continue;   // shell-set wins
    process.env[key] = value;
    count++;
  }
  return { loaded: count, path };
}

function parseLine(line: string): { key: string; value: string } | null {
  let s = line.trim();
  if (!s || s.startsWith('#')) return null;
  if (s.startsWith('export ')) s = s.slice('export '.length).trimStart();
  const eq = s.indexOf('=');
  if (eq <= 0) return null;
  const key = s.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let value = s.slice(eq + 1).trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
  } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    value = value.slice(1, -1);
  } else {
    // Strip trailing inline comments on unquoted values: `FOO=bar  # note`.
    const hash = value.indexOf(' #');
    if (hash >= 0) value = value.slice(0, hash).trimEnd();
  }
  return { key, value };
}
