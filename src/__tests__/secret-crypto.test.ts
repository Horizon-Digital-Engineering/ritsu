import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret, isEncrypted, _resetKeyCacheForTests } from '../util/secret-crypto.js';

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
