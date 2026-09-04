/**
 * Symmetric encryption for sensitive config-at-rest (bot tokens, API keys,
 * future secrets). AES-256-GCM with a 12-byte random IV per encryption and
 * the built-in 16-byte auth tag. Two on-disk formats:
 *
 *     enc:v1:<base64(iv || ct || tag)>           — legacy, no AAD
 *     enc:v2:<base64(iv || ct || tag)>           — AAD binds ciphertext to row
 *
 * Why v2: GCM gives integrity of WHAT was encrypted, not WHERE it lives.
 * Without AAD, an attacker with DB-write (replica tamper, backup swap,
 * future-SQLi) could swap `key_enc` between rows — `reveal(id=anthropic)`
 * would silently return the OpenAI key. v2 binds each ciphertext to its
 * row context via additional authenticated data, so a swap fails the tag
 * check on decrypt.
 *
 * Caller contract:
 *   - new writes: use encryptSecret(plain, aad) — always v2.
 *   - reads: use decryptSecret(stored, aad). v2 verifies the AAD; v1 is
 *     accepted with no AAD check (backward-compat for legacy rows);
 *     anything not starting with `enc:` is treated as legacy plaintext.
 *   - rotation (master-key.ts): decryptWithKey/encryptWithKey accept the
 *     same AAD shape and always emit v2 — rotation is the v1→v2 upgrade
 *     opportunity.
 *
 * AAD format is convention rather than enforced: callers build strings
 * like `api_key:id=42:key_enc` or `channel:id=7:bot_token`. Whatever
 * string you encrypted with, you must pass identically on decrypt.
 *
 * Master key priority (first hit wins):
 *   1. RITSU_MASTER_KEY env var (base64-encoded 32 bytes)
 *   2. /etc/ritsu/master-key  (operator-managed, ideally root-owned mode 0600)
 *   3. /opt/ritsu/data/.master-key  (auto-bootstrapped on first run; logs
 *      a warning because the key lives next to the DB it protects)
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, statSync, chmodSync,
  accessSync, openSync, closeSync, constants as fsConstants,
} from 'node:fs';
import { dirname } from 'node:path';
import { logger } from './log.js';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Versioned prefixes. v1 = no AAD (legacy reads only). v2 = AAD-bound (writes). */
const ENC_PREFIX_V1 = 'enc:v1:';
const ENC_PREFIX_V2 = 'enc:v2:';
/** Whether a master key is available WITHOUT creating one. Lets the health
 *  check and the admin API report the real reason instead of surfacing a
 *  bootstrap failure as a 500 at save time. */
export function masterKeyStatus(): { ok: boolean; source: string | null; detail?: string } {
  if (process.env[ENV_KEY_VAR]?.trim()) return { ok: true, source: 'env' };
  if (existsSync(SYSTEM_KEY_PATH)) return { ok: true, source: SYSTEM_KEY_PATH };
  if (existsSync(FALLBACK_KEY_PATH)) {
    return process.env.RITSU_ALLOW_COLOCATED_KEY === '1'
      ? { ok: true, source: FALLBACK_KEY_PATH }
      : { ok: false, source: null, detail: `key at ${FALLBACK_KEY_PATH} sits beside the database and is refused; move it to ${SYSTEM_KEY_PATH}` };
  }
  return {
    ok: false,
    source: null,
    detail: `no master key — secrets cannot be stored. Create one: sudo sh -c 'umask 077; openssl rand -base64 32 > ${SYSTEM_KEY_PATH}' && sudo chown ritsu:ritsu ${SYSTEM_KEY_PATH}`,
  };
}

/** Back-compat re-export for callers that previously checked the format. */
const ENC_PREFIX = ENC_PREFIX_V2;

const ENV_KEY_VAR = 'RITSU_MASTER_KEY';
const SYSTEM_KEY_PATH = '/etc/ritsu/master-key';

/** True when a key file can be created in `dir`. Checked rather than assumed:
 *  the service runs unprivileged, so /etc/ritsu is writable only when the
 *  installer made it so. */
function canWriteDir(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}
const FALLBACK_KEY_PATH = '/opt/ritsu/data/.master-key';

let cachedKey: Buffer | null = null;

/**
 * Create a new key file and write to it, or fail. Never `writeFileSync` on a
 * path we only checked with `existsSync` earlier: that call follows symlinks,
 * and its `mode` is ignored when the file already exists. Between the check
 * and the write, anything able to write the directory could drop a symlink
 * (the key lands wherever it points) or a pre-made 0644 file (the key lands
 * world-readable, because the mode is only applied on create). The data-dir
 * fallback path makes that reachable by the service user itself.
 *
 * O_EXCL closes both: it fails if the path exists at all, symlink included,
 * so the race becomes a clean error instead of a leaked key.
 */
export function writeNewKeyFile(path: string, key: Buffer): void {
  const fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, key.toString('base64') + '\n');
  } finally {
    closeSync(fd);
  }
}

function loadOrBootstrapMasterKey(): Buffer {
  const envVal = process.env[ENV_KEY_VAR];
  if (envVal?.trim()) {
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
    if (process.env.RITSU_ALLOW_COLOCATED_KEY !== '1') {
      throw new Error(
        `Master key found at ${FALLBACK_KEY_PATH} but it sits next to the SQLite DB it protects.\n` +
        `A single backup or filesystem snapshot exfiltrates both ciphertext + key.\n` +
        `Either:\n` +
        `  1. Move the key:  sudo mv ${FALLBACK_KEY_PATH} ${SYSTEM_KEY_PATH} && sudo chmod 0600 ${SYSTEM_KEY_PATH}\n` +
        `  2. OR set RITSU_MASTER_KEY=<base64> in the env (best for prod)\n` +
        `  3. OR set RITSU_ALLOW_COLOCATED_KEY=1 to acknowledge the trade-off`,
      );
    }
    const raw = readKeyFile(FALLBACK_KEY_PATH);
    logger.warn('crypto.master-key.colocated', {
      path: FALLBACK_KEY_PATH,
      hint: 'Master key shares a directory with the SQLite DB it protects. RITSU_ALLOW_COLOCATED_KEY=1 acknowledges the risk.',
    });
    return raw;
  }
  // First boot — bootstrap into the proper location when we can. Writing to
  // /etc/ritsu keeps the key off the volume the database lives on, which is
  // the whole reason the colocated path is refused below.
  const systemDir = dirname(SYSTEM_KEY_PATH);
  if (canWriteDir(systemDir)) {
    const key = randomBytes(KEY_BYTES);
    writeNewKeyFile(SYSTEM_KEY_PATH, key);
    logger.warn('crypto.master-key.bootstrapped', {
      path: SYSTEM_KEY_PATH,
      hint: 'Generated a master key. BACK IT UP — it is deliberately excluded from database backups, and losing it makes every stored secret unrecoverable.',
    });
    return key;
  }
  // Refuses to drop the key into the colocated fallback path unless the
  // operator has opted in.
  if (process.env.RITSU_ALLOW_COLOCATED_KEY !== '1') {
    throw new Error(
      `No master key found, and ${dirname(SYSTEM_KEY_PATH)} is not writable to create one.\n` +
      `Bootstrap refuses to write to the fallback path (${FALLBACK_KEY_PATH}) because it sits\n` +
      `next to the DB. Pick one:\n` +
      `  1. echo "RITSU_MASTER_KEY=$(openssl rand -base64 32)" >> /etc/ritsu/env  (recommended)\n` +
      `  2. sudo install -o ritsu -g ritsu -m 0600 -D <(openssl rand -base64 32) ${SYSTEM_KEY_PATH}\n` +
      `  3. set RITSU_ALLOW_COLOCATED_KEY=1 to accept the colocated fallback`,
    );
  }
  const key = randomBytes(KEY_BYTES);
  const dir = dirname(FALLBACK_KEY_PATH);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync respects existing dir perms; explicitly chmod so an
  // already-present 0755 dir gets tightened.
  try { chmodSync(dir, 0o700); } catch { /* not the owner — operator must fix */ }
  writeNewKeyFile(FALLBACK_KEY_PATH, key);
  logger.warn('crypto.master-key.bootstrapped', {
    path: FALLBACK_KEY_PATH,
    hint: 'Auto-generated master key. Back it up — losing it makes every encrypted secret unrecoverable.',
  });
  return key;
}

/**
 * Read the master key from disk + assert on-disk hygiene. Refuses to
 * load if:
 *   - the file mode isn't 0600 (any group/world bit set leaks the secret)
 *   - the parent directory is world-writable (file perms are meaningless
 *     when an attacker can rename the parent or drop a replacement)
 */
function readKeyFile(path: string): Buffer {
  let st;
  try { st = statSync(path); }
  catch (err) { throw new Error(`cannot stat master key at ${path}: ${(err as Error).message}`); }
  const mode = st.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(
      `master key at ${path} has mode ${mode.toString(8)} (expected 600).\n` +
      `Tighten with: sudo chmod 0600 ${path}`,
    );
  }
  // Must be owned by us (or root). A 0600 file owned by a DIFFERENT non-root
  // uid — left by a bad install or a shared account — is not ours to trust.
  const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (myUid !== null && st.uid !== myUid && st.uid !== 0) {
    throw new Error(`master key at ${path} is owned by uid ${st.uid}, not this process (${myUid}) or root. chown it to the ritsu service user.`);
  }
  // Parent must not be world-writable. A 0755 dir is fine (others can't
  // modify it), 0777 / 0775 / o+w / g+w are not.
  let parentSt;
  try { parentSt = statSync(dirname(path)); }
  catch { parentSt = null; }
  if (parentSt && (parentSt.mode & 0o022) !== 0) {
    throw new Error(
      `parent dir of master key (${dirname(path)}) is group- or world-writable ` +
      `(mode ${(parentSt.mode & 0o777).toString(8)}). ` +
      `Tighten with: sudo chmod go-w ${dirname(path)}`,
    );
  }
  const raw = readFileSync(path, 'utf8').trim();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`master key at ${path} must decode to ${KEY_BYTES} bytes (got ${key.length})`);
  }
  return key;
}

/** Lazy init — first call materializes the key; subsequent calls reuse it. */
function getKey(): Buffer {
  cachedKey ??= loadOrBootstrapMasterKey();
  return cachedKey;
}

/** For tests: reset the cached key so a different env can be tried. */
export function _resetKeyCacheForTests(): void {
  cachedKey = null;
}

/**
 * Derive a domain-separated 32-byte subkey from the master key for a
 * non-encryption purpose — e.g. an HMAC pepper for hashing bearer tokens.
 *
 * Returns null when no master key is configured, so a caller that must keep
 * working without one (token auth predates the master key) can fall back to
 * an unkeyed hash rather than fail closed. Goes through the same lazy getKey(),
 * so it only bootstraps a key under the same opt-in rules encryptSecret uses.
 * The `info` label is mixed in so distinct uses get distinct subkeys.
 */
export function tryDeriveSubkey(info: string): Buffer | null {
  let key: Buffer;
  try { key = getKey(); }
  catch { return null; }
  return createHmac('sha256', key).update(`ritsu/subkey/v1/${info}`).digest();
}

/**
 * Encrypt under an explicit key (NOT the cached master key). Always emits
 * v2 — rotation is when legacy v1 rows transparently upgrade. The `aad`
 * is bound into the GCM tag; the same value must be passed at decrypt
 * time.
 */
export function encryptWithKey(plain: string, key: Buffer, aad: string): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`encryptWithKey: key must be ${KEY_BYTES} bytes (got ${key.length})`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX_V2 + Buffer.concat([iv, ct, tag]).toString('base64');
}

/**
 * Decrypt under an explicit key. Accepts both v1 (no AAD) and v2 (AAD-
 * verified). The `aad` parameter is ignored for v1; for v2 it MUST match
 * the value used at encrypt time or the GCM tag check fails.
 *
 * Will not silently fall through to legacy plaintext — rotation only
 * touches actually-encrypted rows. Throws on anything not prefixed.
 */
export function decryptWithKey(stored: string, key: Buffer, aad: string): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`decryptWithKey: key must be ${KEY_BYTES} bytes (got ${key.length})`);
  }
  if (stored.startsWith(ENC_PREFIX_V2)) {
    return decryptPayload(stored.slice(ENC_PREFIX_V2.length), key, aad);
  }
  if (stored.startsWith(ENC_PREFIX_V1)) {
    return decryptPayload(stored.slice(ENC_PREFIX_V1.length), key, null);
  }
  throw new Error('decryptWithKey: not an encrypted payload');
}

/** Shared decrypt-from-base64 + (optional) AAD verify. Caller has already
 *  identified the format version + stripped the prefix. */
function decryptPayload(base64: string, key: Buffer, aad: string | null): string {
  const payload = Buffer.from(base64, 'base64');
  if (payload.length < IV_BYTES + TAG_BYTES) {
    throw new Error('encrypted payload truncated');
  }
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const ct = payload.subarray(IV_BYTES, payload.length - TAG_BYTES);
  // authTagLength pinned so node refuses a shorter, potentially attacker-
  // forged tag (GCM tag-truncation hardening).
  const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  if (aad !== null) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Read the currently-active master key without going through the lazy
 * getKey() cache — the rotation CLI needs the on-disk value, not whatever
 * the long-running process happened to load at boot.
 */
export function readActiveMasterKey(): { key: Buffer; source: 'env' | typeof SYSTEM_KEY_PATH | typeof FALLBACK_KEY_PATH } {
  const envVal = process.env[ENV_KEY_VAR];
  if (envVal?.trim()) {
    const raw = Buffer.from(envVal.trim(), 'base64');
    if (raw.length !== KEY_BYTES) {
      throw new Error(`${ENV_KEY_VAR} must be ${KEY_BYTES} bytes base64-encoded`);
    }
    return { key: raw, source: 'env' };
  }
  if (existsSync(SYSTEM_KEY_PATH)) {
    return { key: readKeyFile(SYSTEM_KEY_PATH), source: SYSTEM_KEY_PATH };
  }
  if (existsSync(FALLBACK_KEY_PATH)) {
    return { key: readKeyFile(FALLBACK_KEY_PATH), source: FALLBACK_KEY_PATH };
  }
  throw new Error('no master key configured (env var unset, no key file on disk)');
}

/** Generate a fresh master key. 32 random bytes. */
export function generateMasterKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Where on disk the rotation CLI should write the new key. Mirrors the
 *  load priority: prefers SYSTEM_KEY_PATH if it's the active source,
 *  otherwise FALLBACK_KEY_PATH. Refuses to write when the env var is the
 *  active source (rotation in that mode means swapping the env var, which
 *  the operator does manually). */
/** Where a first key should be created. Not the colocated fallback: beside the
 *  database, one snapshot carries both the ciphertext and the key for it. */
export function masterKeyCreatePath(): string {
  return SYSTEM_KEY_PATH;
}

export function masterKeyWritePath(source: string): string {
  if (source === 'env') {
    throw new Error('master key is sourced from RITSU_MASTER_KEY env var; rotate by setting a new value and restarting');
  }
  return source;
}

export { ENC_PREFIX, ENC_PREFIX_V1, ENC_PREFIX_V2 };

/**
 * Encrypt a UTF-8 string with AAD binding. Always emits v2. Re-encrypting
 * the same plaintext produces a different ciphertext (random IV).
 *
 * `aad` is the context that binds this ciphertext to its row. Build it
 * from the row identity and field name (e.g. `api_key:id=42:key_enc`).
 * The same value MUST be passed on decrypt or the GCM tag check fails.
 */
export function encryptSecret(plain: string, aad: string): string {
  return encryptWithKey(plain, getKey(), aad);
}

/**
 * Decrypt a stored value:
 *   - `enc:v2:` → AAD-verified decrypt; `aad` MUST match what encrypted.
 *   - `enc:v1:` → AAD-less decrypt; `aad` ignored (legacy compat).
 *   - anything else → returned as-is (legacy plaintext compat).
 *
 * Caller upgrades v1 → v2 on the next write by passing `aad` to
 * encryptSecret.
 */
export function decryptSecret(stored: string, aad: string): string {
  if (!stored.startsWith(ENC_PREFIX_V1) && !stored.startsWith(ENC_PREFIX_V2)) {
    return stored;
  }
  return decryptWithKey(stored, getKey(), aad);
}

/** True if a string is in either encrypted format (v1 or v2). */
export function isEncrypted(s: string): boolean {
  return typeof s === 'string' && (s.startsWith(ENC_PREFIX_V1) || s.startsWith(ENC_PREFIX_V2));
}
