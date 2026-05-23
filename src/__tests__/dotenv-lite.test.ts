import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDotenv } from '../util/dotenv-lite.js';

/**
 * The replacement for `dotenv/config`. We're not feature-equivalent — just
 * "good enough for what ritsu actually used dotenv for." These tests pin
 * the behaviour so a future hand-tune doesn't accidentally regress it.
 */
describe('dotenv-lite', () => {
  let dir: string;
  let envPath: string;
  /** Keys our tests set + clean up. process.env leaks across tests otherwise. */
  const keys = new Set<string>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ritsu-dotenv-'));
    envPath = join(dir, '.env');
  });
  afterEach(() => {
    for (const k of keys) delete process.env[k];
    keys.clear();
    try { unlinkSync(envPath); } catch { /* file may not exist */ }
  });

  function set(content: string): void {
    writeFileSync(envPath, content);
  }
  function track(...names: string[]): void {
    for (const n of names) keys.add(n);
  }

  it('returns {loaded:0} when the file is missing — not an error', () => {
    const result = loadDotenv(join(dir, 'nope.env'));
    assert.equal(result.loaded, 0);
  });

  it('loads plain KEY=value lines', () => {
    track('A', 'B');
    set('A=1\nB=hello world\n');
    const r = loadDotenv(envPath);
    assert.equal(r.loaded, 2);
    assert.equal(process.env.A, '1');
    assert.equal(process.env.B, 'hello world');
  });

  it('strips double + single quotes, preserves inner whitespace', () => {
    track('Q1', 'Q2');
    set(`Q1="  spaced  "\nQ2='also spaced'\n`);
    loadDotenv(envPath);
    assert.equal(process.env.Q1, '  spaced  ');
    assert.equal(process.env.Q2, 'also spaced');
  });

  it('treats # at line start as a comment + ignores blank lines', () => {
    track('X');
    set('# a comment\n\nX=ok\n');
    loadDotenv(envPath);
    assert.equal(process.env.X, 'ok');
  });

  it('strips inline " #" comments from unquoted values only', () => {
    track('U', 'Q');
    set('U=val  # note\nQ="kept # here"\n');
    loadDotenv(envPath);
    assert.equal(process.env.U, 'val');
    assert.equal(process.env.Q, 'kept # here');
  });

  it('accepts the `export KEY=...` shell-compat prefix', () => {
    track('E');
    set('export E=yes\n');
    loadDotenv(envPath);
    assert.equal(process.env.E, 'yes');
  });

  it('does NOT overwrite a key already set in process.env', () => {
    track('PRE');
    process.env.PRE = 'shell';
    set('PRE=file\n');
    loadDotenv(envPath);
    assert.equal(process.env.PRE, 'shell');
  });

  it('rejects invalid key shapes (must match /^[A-Za-z_][A-Za-z0-9_]*$/)', () => {
    track('OK');
    set('1bad=x\n=missing\nOK=fine\n');
    const r = loadDotenv(envPath);
    assert.equal(r.loaded, 1);
    assert.equal(process.env.OK, 'fine');
  });
});
