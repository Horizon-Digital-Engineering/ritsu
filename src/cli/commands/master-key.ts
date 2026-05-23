/**
 * `ritsu master-key rotate` — rotate the AES-256-GCM master key that
 * encrypts every secret at rest (channel bot tokens, API keys).
 *
 * Flow:
 *   1. Load the active key (env / /etc/ritsu/master-key / data/.master-key).
 *   2. Generate a new random 32-byte key.
 *   3. In one SQLite transaction, decrypt every `enc:v1:*` payload with
 *      the old key and re-encrypt under the new key. Commits or rolls
 *      back atomically — a mid-rotation crash leaves rows readable
 *      under the OLD key.
 *   4. Only after the DB transaction commits do we overwrite the on-disk
 *      key file. If THAT write fails, the next process boot will load the
 *      old key and find ciphertexts it can't decrypt — so we keep a
 *      `.master-key.prev` backup that the operator can swap in manually
 *      until they re-rotate.
 *
 * Failure modes:
 *   - Env-sourced key: refused. Rotation in env mode means setting a new
 *     RITSU_MASTER_KEY and restarting; this command can't ssh to your
 *     systemd unit.
 *   - Any row fails to decrypt under the claimed-old key: abort BEFORE
 *     writing anything. Either the key file is stale or a row was
 *     written under a different key (operator must investigate).
 *   - DB write fails mid-transaction: SQLite rolls back; on-disk key is
 *     unchanged. Safe to retry.
 *   - Disk write of new key fails AFTER DB commit: this is the worst
 *     case. The DB now has ciphertexts under a new key but the disk
 *     still has the old key. The CLI prints the new key (base64) so the
 *     operator can stash it manually and write it to the correct path.
 */
import { writeFileSync, renameSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { openDatabase, type Db } from '../../db.js';
import {
  readActiveMasterKey,
  generateMasterKey,
  encryptWithKey,
  decryptWithKey,
  masterKeyWritePath,
  _resetKeyCacheForTests,
  isEncrypted,
} from '../../util/secret-crypto.js';
import type { Command, CommandContext } from '../registry.js';

interface RotationStats { apiKeys: number; channels: number }

/**
 * Re-encrypt every `enc:v1:*` payload in the DB. Runs inside a single
 * transaction; throws (and rolls back) on any decrypt or write failure.
 */
function reencryptAll(db: Db, oldKey: Buffer, newKey: Buffer): RotationStats {
  const stats: RotationStats = { apiKeys: 0, channels: 0 };
  const tx = db.transaction(() => {
    stats.apiKeys = reencryptApiKeys(db, oldKey, newKey);
    stats.channels = reencryptChannels(db, oldKey, newKey);
  });
  tx();
  return stats;
}

/** api_keys.key_enc holds `<prefix>|enc:v1:...`. Decrypt the suffix under
 *  the old key, re-encrypt under the new, preserve the prefix wrapper that
 *  lets list() show a visual hint. Legacy rows (no `|` separator) get the
 *  same treatment minus the wrapper. */
function reencryptApiKeys(db: Db, oldKey: Buffer, newKey: Buffer): number {
  const rows = db.prepare(
    `SELECT id, key_enc FROM api_keys WHERE revoked_at IS NULL`,
  ).all() as Array<{ id: number; key_enc: string }>;
  const upd = db.prepare(`UPDATE api_keys SET key_enc = ? WHERE id = ?`);
  let count = 0;
  for (const row of rows) {
    const next = rotateApiKeyValue(row.key_enc, oldKey, newKey, row.id);
    if (next === null) continue;
    upd.run(next, row.id);
    count++;
  }
  return count;
}

/** Return the rotated value for one api_keys.key_enc row, or null if the
 *  row holds legacy plaintext that doesn't need rotating. Rotation is
 *  also the v1→v2 upgrade — new ciphertext is always v2 with id-bound AAD.
 *  Legacy v1 rows decrypt without AAD (decryptWithKey detects via prefix),
 *  then encrypt with the row's AAD under the new key. */
function rotateApiKeyValue(stored: string, oldKey: Buffer, newKey: Buffer, id: number): string | null {
  const aad = `api_key:id=${id}:key_enc`;
  const sep = stored.indexOf('|');
  if (sep === -1) {
    if (!stored.startsWith('enc:')) return null; // legacy plaintext, leave alone
    const plain = decryptWithKey(stored, oldKey, aad);
    return encryptWithKey(plain, newKey, aad);
  }
  const prefix = stored.slice(0, sep);
  const enc = stored.slice(sep + 1);
  if (!isEncrypted(enc)) return null;
  const plain = decryptWithKey(enc, oldKey, aad);
  return prefix + '|' + encryptWithKey(plain, newKey, aad);
}

/** channels.config is a JSON blob with encrypted fields (today: bot_token
 *  on telegram). Decrypt + re-encrypt only the SECRET_FIELDS values; rows
 *  whose secrets are still plaintext (legacy) are left as-is. */
function reencryptChannels(db: Db, oldKey: Buffer, newKey: Buffer): number {
  const rows = db.prepare(`SELECT id, kind, config FROM channels`).all() as Array<{
    id: number;
    kind: string;
    config: string;
  }>;
  const upd = db.prepare(`UPDATE channels SET config = ? WHERE id = ?`);
  let count = 0;
  for (const row of rows) {
    const next = rotateChannelConfig(row.kind, row.id, row.config, oldKey, newKey);
    if (next === null) continue;
    upd.run(next, row.id);
    count++;
  }
  return count;
}

/** Return the rotated `channels.config` JSON for one row, or null if no
 *  encrypted secret-field values were found to rotate. Re-encrypts each
 *  secret field with AAD = `channel:id=<id>:<field>` — same shape the
 *  store uses at write time. */
function rotateChannelConfig(kind: string, id: number, configJson: string, oldKey: Buffer, newKey: Buffer): string | null {
  const parsed = JSON.parse(configJson) as Record<string, unknown>;
  const secretFields = kind === 'telegram' ? ['bot_token'] : [];
  let touched = false;
  for (const f of secretFields) {
    const v = parsed[f];
    if (typeof v === 'string' && isEncrypted(v)) {
      const aad = `channel:id=${id}:${f}`;
      parsed[f] = encryptWithKey(decryptWithKey(v, oldKey, aad), newKey, aad);
      touched = true;
    }
  }
  return touched ? JSON.stringify(parsed) : null;
}

/** Atomic-ish write of the new key file: write to .new, rename old to
 *  .prev, rename .new to canonical name. Mode 0600. Same dir as the
 *  active key file. */
function writeNewKeyFile(targetPath: string, newKey: Buffer): { backup: string | null } {
  // dirname kept implicit — writeFileSync resolves the relative path
  // against process cwd; targetPath is already absolute by construction.
  const tmpPath = targetPath + '.new';
  const backupPath = targetPath + '.prev';
  writeFileSync(tmpPath, newKey.toString('base64') + '\n', { mode: 0o600 });
  let backup: string | null = null;
  if (existsSync(targetPath)) {
    copyFileSync(targetPath, backupPath);
    chmodSync(backupPath, 0o600);
    backup = backupPath;
  }
  renameSync(tmpPath, targetPath);
  return { backup };
}

async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const ans = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

async function cmdRotate(ctx: CommandContext): Promise<number> {
  const dbPath = resolvePath(process.env.DB_PATH ?? '/opt/ritsu/data/ritsu.db');
  const { key: oldKey, source } = readActiveMasterKey();

  if (source === 'env') {
    console.error('master key is sourced from RITSU_MASTER_KEY env var.');
    console.error('To rotate: generate a new key, set RITSU_MASTER_KEY=<new>, run');
    console.error('  ritsu master-key rotate (under the new env), then restart the service.');
    return 2;
  }
  const targetPath = masterKeyWritePath(source);

  if (ctx.flags.yes !== true) {
    const ok = await confirm(
      'Rotate the master key? Every encrypted-at-rest row will be re-encrypted\n' +
      `  under a new key. The old key is preserved at ${targetPath}.prev in case\n` +
      '  you need to roll back. The ritsu service should be STOPPED before rotating\n' +
      '  (in-flight writes during rotation could land under the old key after the new\n' +
      '  one is in place).',
    );
    if (!ok) { console.error('aborted'); return 1; }
  }

  const newKey = generateMasterKey();
  const db = openDatabase(dbPath);
  let stats: RotationStats;
  try {
    stats = reencryptAll(db, oldKey, newKey);
  } catch (err) {
    console.error(`rotation failed during re-encrypt: ${(err as Error).message}`);
    console.error('DB transaction rolled back; on-disk key unchanged. Safe to retry.');
    db.close();
    return 1;
  }
  db.close();

  // DB commit succeeded. Now swap the on-disk key. If THIS fails the DB
  // already holds ciphertexts under the new key — we print the new key as
  // a recovery breadcrumb.
  let backupPath: string | null;
  try {
    ({ backup: backupPath } = writeNewKeyFile(targetPath, newKey));
  } catch (err) {
    console.error('');
    console.error('!!! ROTATION HALF-DONE !!!');
    console.error(`DB re-encrypted under new key but key-file write FAILED: ${(err as Error).message}`);
    console.error('To recover, write the following base64 to ' + targetPath + ' (mode 0600) by hand:');
    console.error('');
    console.error('  ' + newKey.toString('base64'));
    console.error('');
    return 1;
  }

  // Process-local cache reset is mostly cosmetic — the CLI is short-lived.
  // Done for parity with the test helper so the same call works at runtime.
  _resetKeyCacheForTests();

  if (ctx.flags.json) {
    console.log(JSON.stringify({
      rotated: true,
      api_keys: stats.apiKeys,
      channels: stats.channels,
      key_path: targetPath,
      backup_path: backupPath,
    }, null, 2));
    return 0;
  }
  console.log('');
  console.log('  master key rotated.');
  console.log(`    api_keys re-encrypted:  ${stats.apiKeys}`);
  console.log(`    channels re-encrypted:  ${stats.channels}`);
  console.log(`    new key at:             ${targetPath}`);
  if (backupPath) console.log(`    old key backed up to:   ${backupPath}`);
  console.log('');
  console.log('  Restart the ritsu service so the new key is in process memory:');
  console.log('    sudo systemctl restart ritsu');
  console.log('');
  console.log('  Once you have confirmed everything works, you can delete the backup:');
  console.log(`    sudo shred -u ${backupPath ?? '<backup-path>'}`);
  console.log('');
  return 0;
}

export const masterKeyCommand: Command = {
  name: 'master-key',
  summary: 're-encrypt at-rest secrets under a fresh master key (and back up the old one)',
  needsRoot: true,
  help: () => [
    'ritsu master-key — manage the AES-256-GCM master key',
    '',
    '  ritsu master-key rotate [--yes]   re-encrypt every secret-at-rest row under',
    '                                    a fresh key and atomically swap the on-disk',
    '                                    key file. Backs up the old key to <path>.prev.',
    '',
    'Refuses to rotate when the active key comes from RITSU_MASTER_KEY — env-mode',
    'rotation means setting a new env var and restarting the service.',
    '',
    'STOP the ritsu service before rotating to avoid a race where a write lands',
    'under the old key after the new one is already in place:',
    '  sudo systemctl stop ritsu',
    '  sudo ritsu master-key rotate',
    '  sudo systemctl start ritsu',
  ].join('\n'),
  run: async (ctx: CommandContext) => {
    if (ctx.subcommand === 'rotate') return cmdRotate(ctx);
    console.error(`unknown subcommand: ${ctx.subcommand ?? '(none)'}`);
    console.error(`run 'ritsu master-key --help' for usage`);
    return 2;
  },
};
