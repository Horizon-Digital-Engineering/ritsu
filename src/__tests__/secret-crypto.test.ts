import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes, createCipheriv } from 'node:crypto';
import {
  encryptSecret, decryptSecret, isEncrypted,
  encryptWithKey, decryptWithKey,
  generateMasterKey, readActiveMasterKey, masterKeyWritePath,
  _resetKeyCacheForTests,
} from '../util/secret-crypto.js';

const AAD = 'test:id=1:field';

describe('secret-crypto', () => {
  beforeEach(() => {
    process.env.RITSU_MASTER_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
  });

  it('round-trip: decrypt(encrypt(x, aad), aad) === x', () => {
    const plain = 'rt_abc.123_super_secret_value';
    assert.equal(decryptSecret(encryptSecret(plain, AAD), AAD), plain);
  });

  it('encrypt produces a different ciphertext each call (random IV)', () => {
    const plain = 'same plaintext';
    const a = encryptSecret(plain, AAD);
    const b = encryptSecret(plain, AAD);
    assert.notEqual(a, b);
    assert.equal(decryptSecret(a, AAD), plain);
    assert.equal(decryptSecret(b, AAD), plain);
  });

  it('output is enc:v2: now that AAD is mandatory', () => {
    const enc = encryptSecret('x', AAD);
    assert.equal(enc.startsWith('enc:v2:'), true);
    assert.equal(isEncrypted(enc), true);
    assert.equal(isEncrypted('rt_plain_old_token'), false);
  });

  it('decrypt returns legacy plaintext unchanged (no prefix)', () => {
    assert.equal(decryptSecret('rt_plain_old_token', AAD), 'rt_plain_old_token');
  });

  it('tampered ciphertext fails auth (GCM tag check)', () => {
    const enc = encryptSecret('important', AAD);
    // Corrupt one byte in the base64 payload after the prefix.
    const tampered = 'enc:v2:' + enc.slice('enc:v2:'.length, -2) + 'AA';
    assert.throws(() => decryptSecret(tampered, AAD));
  });

  it('AAD MISMATCH on v2 decrypt fails (row-swap defense)', () => {
    // This is the core property: a ciphertext encrypted with context
    // "api_key:id=1:..." must NOT decrypt under context "api_key:id=2:..."
    // — otherwise an attacker who swaps key_enc between rows wins.
    const enc = encryptSecret('shadow', 'api_key:id=1:key_enc');
    assert.throws(() => decryptSecret(enc, 'api_key:id=2:key_enc'));
  });

  it('truncated payload is rejected before reaching openssl', () => {
    assert.throws(() => decryptSecret('enc:v2:c2hvcnQ=', AAD), /truncated/);
  });

  it('multibyte UTF-8 round-trips', () => {
    const plain = 'こんにちは — 🤖 — bytes for days';
    assert.equal(decryptSecret(encryptSecret(plain, AAD), AAD), plain);
  });
});

describe('legacy enc:v1: backward-compat decrypt', () => {
  it('v1 ciphertext decrypts under decryptSecret with ANY aad (aad ignored)', () => {
    // Synthesize a v1 payload (no AAD on encrypt). We use encryptWithKey
    // to build it explicitly through the underlying primitive… but v2 is
    // what encryptWithKey emits now. Instead, construct a v1 payload by
    // hand from the GCM primitives to prove the read path still accepts it.
    process.env.RITSU_MASTER_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
    const key = Buffer.from(process.env.RITSU_MASTER_KEY ?? '', 'base64');
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update('legacy-secret', 'utf8'), c.final()]);
    const tag = c.getAuthTag();
    const v1 = 'enc:v1:' + Buffer.concat([iv, ct, tag]).toString('base64');
    // v1 decrypt: AAD argument is ignored.
    assert.equal(decryptSecret(v1, 'whatever-aad-here'), 'legacy-secret');
  });
});

describe('encryptWithKey / decryptWithKey (rotation helpers)', () => {
  it('round-trips under an explicit key + aad', () => {
    const key = generateMasterKey();
    const plain = 'rotated-secret';
    assert.equal(decryptWithKey(encryptWithKey(plain, key, AAD), key, AAD), plain);
  });

  it('different IVs across encryptions of the same plaintext', () => {
    const key = generateMasterKey();
    const a = encryptWithKey('x', key, AAD);
    const b = encryptWithKey('x', key, AAD);
    assert.notEqual(a, b);
  });

  it('decrypt with the wrong key fails (GCM tag check)', () => {
    const k1 = generateMasterKey();
    const k2 = generateMasterKey();
    const enc = encryptWithKey('payload', k1, AAD);
    assert.throws(() => decryptWithKey(enc, k2, AAD));
  });

  it('rejects a key with the wrong byte length', () => {
    const shortKey = randomBytes(16);
    assert.throws(() => encryptWithKey('x', shortKey, AAD), /32 bytes/);
    assert.throws(() => decryptWithKey('enc:v2:AAAA', shortKey, AAD), /32 bytes/);
  });

  it('rejects payloads without the enc: prefix', () => {
    const key = generateMasterKey();
    assert.throws(() => decryptWithKey('rt_plain_token', key, AAD), /not an encrypted payload/);
  });

  it('rejects truncated payloads before reaching openssl', () => {
    const key = generateMasterKey();
    assert.throws(() => decryptWithKey('enc:v2:c2hvcnQ=', key, AAD), /truncated/);
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
