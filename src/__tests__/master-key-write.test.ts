/**
 * How the master key gets onto disk.
 *
 * The bootstrap path decides `existsSync(keyPath)` is false and then writes.
 * `writeFileSync` is the wrong tool for that gap: it follows symlinks, and its
 * `mode` is ignored when the file already exists. Anything able to write the
 * directory in between could redirect the key or land it world-readable — and
 * the data-dir fallback is a directory the service user owns, so a compromised
 * agent is inside that set, not just root.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeNewKeyFile } from '../util/secret-crypto.js';

describe('writeNewKeyFile', () => {
  let dir: string;
  const key = randomBytes(32);

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ritsu-key-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates the key file 0600 and readable back', () => {
    const p = join(dir, 'master-key');
    writeNewKeyFile(p, key);
    assert.equal(statSync(p).mode & 0o777, 0o600);
    assert.equal(readFileSync(p, 'utf8').trim(), key.toString('base64'));
  });

  it('REFUSES a path that already exists, rather than truncating it', () => {
    // writeFileSync would have overwritten this AND left it 0644, because the
    // mode argument only applies when the file is created.
    const p = join(dir, 'master-key');
    writeFileSync(p, 'pre-existing', { mode: 0o644 });
    assert.throws(() => writeNewKeyFile(p, key), /EEXIST/);
    assert.equal(readFileSync(p, 'utf8'), 'pre-existing', 'the existing file is untouched');
    assert.equal(statSync(p).mode & 0o777, 0o644, 'and its permissions were never widened by us');
  });

  it('REFUSES a symlink, so the key cannot be redirected', () => {
    const target = join(dir, 'attacker-owned');
    const p = join(dir, 'master-key');
    symlinkSync(target, p);
    assert.throws(() => writeNewKeyFile(p, key), /EEXIST/);
    assert.equal(existsSync(target), false, 'nothing was written through the link');
  });

  it('surfaces an unwritable directory as an error, not a silent skip', () => {
    assert.throws(() => writeNewKeyFile(join(dir, 'nope', 'master-key'), key), /ENOENT/);
  });
});
