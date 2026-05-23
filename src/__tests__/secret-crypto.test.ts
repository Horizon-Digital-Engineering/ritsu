import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import {
  encryptSecret, decryptSecret, isEncrypted,
  encryptWithKey, decryptWithKey,
  generateMasterKey, readActiveMasterKey, masterKeyWritePath,
  _resetKeyCacheForTests,
} from '../util/secret-crypto.js';

describe('secret-crypto', () => {
  beforeEach(() => {
    process.env.RITSU_MASTER_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
  });

  it('round-trip: decrypt(encrypt(x)) === x', () => {
    const plain = 'rt_abc.123_super_secret_value';
    assert.equal(decryptSecret(encryptSecret(plain)), plain);
  });

  it('encrypt produces a different ciphertext each call (random IV)', () => {
    const plain = 'same plaintext';
    const a = encryptSecret(plain);
    const b = encryptSecret(plain);
    assert.notEqual(a, b);
    assert.equal(decryptSecret(a), plain);
    assert.equal(decryptSecret(b), plain);
  });

  it('output carries the versioned prefix', () => {
    const enc = encryptSecret('x');
    assert.equal(enc.startsWith('enc:v1:'), true);
    assert.equal(isEncrypted(enc), true);
    assert.equal(isEncrypted('rt_plain_old_token'), false);
  });

  it('decrypt returns legacy plaintext unchanged (no prefix)', () => {
    assert.equal(decryptSecret('rt_plain_old_token'), 'rt_plain_old_token');
  });

  it('tampered ciphertext fails auth (GCM tag check)', () => {
    const enc = encryptSecret('important');
    // Corrupt one byte in the base64 payload after the prefix.
    const tampered = 'enc:v1:' + enc.slice('enc:v1:'.length, -2) + 'AA';
    assert.throws(() => decryptSecret(tampered));
  });

  it('truncated payload is rejected before reaching openssl', () => {
    assert.throws(() => decryptSecret('enc:v1:c2hvcnQ='), /truncated/);
  });

  it('multibyte UTF-8 round-trips', () => {
    const plain = 'こんにちは — 🤖 — bytes for days';
    assert.equal(decryptSecret(encryptSecret(plain)), plain);
  });
});

describe('encryptWithKey / decryptWithKey (rotation helpers)', () => {
  it('round-trips under an explicit key', () => {
    const key = generateMasterKey();
    const plain = 'rotated-secret';
    assert.equal(decryptWithKey(encryptWithKey(plain, key), key), plain);
  });

  it('different IVs across encryptions of the same plaintext', () => {
    const key = generateMasterKey();
    const a = encryptWithKey('x', key);
    const b = encryptWithKey('x', key);
    assert.notEqual(a, b);
  });

  it('decrypt with the wrong key fails (GCM tag check)', () => {
    const k1 = generateMasterKey();
    const k2 = generateMasterKey();
    const enc = encryptWithKey('payload', k1);
    assert.throws(() => decryptWithKey(enc, k2));
  });

  it('rejects a key with the wrong byte length', () => {
    const shortKey = randomBytes(16);
    assert.throws(() => encryptWithKey('x', shortKey), /32 bytes/);
    assert.throws(() => decryptWithKey('enc:v1:AAAA', shortKey), /32 bytes/);
  });

  it('rejects payloads without the enc: prefix', () => {
    const key = generateMasterKey();
    assert.throws(() => decryptWithKey('rt_plain_token', key), /not an encrypted payload/);
  });

  it('rejects truncated payloads before reaching openssl', () => {
    const key = generateMasterKey();
    assert.throws(() => decryptWithKey('enc:v1:c2hvcnQ=', key), /truncated/);
  });
});

describe('readActiveMasterKey', () => {
  it('reads from RITSU_MASTER_KEY env var when set', () => {
    process.env.RITSU_MASTER_KEY = generateMasterKey().toString('base64');
    _resetKeyCacheForTests();
    const { source } = readActiveMasterKey();
    assert.equal(source, 'env');
  });

  it('rejects an env-var key with the wrong length', () => {
    process.env.RITSU_MASTER_KEY = Buffer.from('too-short').toString('base64');
    _resetKeyCacheForTests();
    assert.throws(() => readActiveMasterKey(), /32 bytes/);
  });
});

describe('masterKeyWritePath', () => {
  it('refuses to write when the active source is the env var', () => {
    assert.throws(() => masterKeyWritePath('env'), /env var/);
  });

  it('returns the source path verbatim for file-sourced keys', () => {
    assert.equal(masterKeyWritePath('/etc/ritsu/master-key'), '/etc/ritsu/master-key');
    assert.equal(masterKeyWritePath('/opt/ritsu/data/.master-key'), '/opt/ritsu/data/.master-key');
  });
});

describe('generateMasterKey', () => {
  it('returns 32 distinct bytes each call', () => {
    const a = generateMasterKey();
    const b = generateMasterKey();
    assert.equal(a.length, 32);
    assert.equal(b.length, 32);
    assert.notDeepEqual(a, b);
  });
});
