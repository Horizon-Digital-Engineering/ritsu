/**
 * Symmetric encryption for sensitive config-at-rest (bot tokens, future API
 * keys, etc.). AES-256-GCM with a 12-byte random IV per encryption and the
 * built-in 16-byte auth tag. The encoded format is:
 *
 *     enc:v1:<base64(iv || ciphertext || tag)>
 *
 * Plaintext input that ISN'T prefixed `enc:` is treated as legacy plaintext
 * on read so a migration isn't required — new writes always encrypt, old
 * rows transparently upgrade on the next save.
 *
 * Master key priority (first hit wins):
 *   1. RITSU_MASTER_KEY env var (base64-encoded 32 bytes)
 *   2. /etc/ritsu/master-key  (operator-managed, ideally root-owned mode 0600)
 *   3. /opt/ritsu/data/.master-key  (auto-bootstrapped on first run; logs
 *      a warning because the key lives next to the DB it protects)
 *
 * To rotate: change the master key (env or file), then run a re-encrypt
 * script (TODO; not in v0 because we don't have ciphertexts in production yet).
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from './log.js';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Versioned prefix so we can change the cipher later without ambiguity. */
const ENC_PREFIX = 'enc:v1:';

const ENV_KEY_VAR = 'RITSU_MASTER_KEY';
const SYSTEM_KEY_PATH = '/etc/ritsu/master-key';
const FALLBACK_KEY_PATH = '/opt/ritsu/data/.master-key';

let cachedKey: Buffer | null = null;

function loadOrBootstrapMasterKey(): Buffer {
  const envVal = process.env[ENV_KEY_VAR];
  if (envVal && envVal.trim()) {
    const raw = Buffer.from(envVal.trim(), 'base64');
    if (raw.length !== KEY_BYTES) {
      throw new Error(`${ENV_KEY_VAR} must be ${KEY_BYTES} bytes base64-encoded`);
    }
    logger.info('crypto.master-key.source', { source: 'env' });
    return raw;
  }
  if (existsSync(SYSTEM_KEY_PATH)) {
    const raw = readKeyFile(SYSTEM_KEY_PATH);
    logger.info('crypto.master-key.source', { source: 'file', path: SYSTEM_KEY_PATH });
    return raw;
  }
  if (existsSync(FALLBACK_KEY_PATH)) {
    const raw = readKeyFile(FALLBACK_KEY_PATH);
    logger.warn('crypto.master-key.colocated', {
      path: FALLBACK_KEY_PATH,
      hint: 'Master key shares a directory with the SQLite DB it protects. Move to /etc/ritsu/master-key or set RITSU_MASTER_KEY for stronger separation.',
    });
    return raw;
  }
  // First boot — bootstrap into the fallback location.
  const key = randomBytes(KEY_BYTES);
  mkdirSync(dirname(FALLBACK_KEY_PATH), { recursive: true });
  writeFileSync(FALLBACK_KEY_PATH, key.toString('base64') + '\n', { mode: 0o600 });
  logger.warn('crypto.master-key.bootstrapped', {
    path: FALLBACK_KEY_PATH,
    hint: 'Auto-generated master key. Back it up — losing it makes every encrypted secret unrecoverable.',
  });
  return key;
}

function readKeyFile(path: string): Buffer {
  const raw = readFileSync(path, 'utf8').trim();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`master key at ${path} must decode to ${KEY_BYTES} bytes (got ${key.length})`);
  }
  return key;
}

/** Lazy init — first call materializes the key; subsequent calls reuse it. */
function getKey(): Buffer {
  if (!cachedKey) cachedKey = loadOrBootstrapMasterKey();
  return cachedKey;
}

/** For tests: reset the cached key so a different env can be tried. */
export function _resetKeyCacheForTests(): void {
  cachedKey = null;
}

/**
 * Encrypt a UTF-8 string. Output is the versioned format described above.
 * Re-encrypting the same plaintext produces a different ciphertext each time
 * (random IV), which is what you want for confidentiality.
 */
export function encryptSecret(plain: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, ct, tag]).toString('base64');
}

/**
 * Decrypt a previously-encrypted value, OR transparently return legacy
 * plaintext (anything not starting with the `enc:` prefix). This lets us
 * roll out encryption without a hard migration — old rows decrypt as
 * themselves and get re-encrypted on the next write.
 */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) {
    // Legacy plaintext — return as-is. Caller is responsible for re-saving
    // to upgrade the row.
    return stored;
  }
  const key = getKey();
  const payload = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
  if (payload.length < IV_BYTES + TAG_BYTES) {
    throw new Error('encrypted payload truncated');
  }
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const ct = payload.subarray(IV_BYTES, payload.length - TAG_BYTES);
  // authTagLength pinned to TAG_BYTES so node refuses to verify a shorter,
  // potentially attacker-forged tag (GCM tag-truncation hardening).
  const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** True if a string is in our versioned encrypted format. */
export function isEncrypted(s: string): boolean {
  return typeof s === 'string' && s.startsWith(ENC_PREFIX);
}
