import type { Db } from '../db.js';
import { ChannelKindSchema, type ChannelKind, type ChannelRow } from './types.js';
import { encryptSecret, decryptSecret } from '../util/secret-crypto.js';
import { logger } from '../util/log.js';

export interface ChannelUpsert {
  name: string;
  kind: ChannelKind;
  operator_agent_id: string;
  /** JSON-serializable payload — shape per kind (see TelegramConfigSchema, etc.) */
  config: unknown;
  enabled?: boolean;
}

export interface ChannelStore {
  list(): ChannelRow[];
  listEnabled(): ChannelRow[];
  read(id: number): ChannelRow | null;
  readByName(name: string): ChannelRow | null;
  create(input: ChannelUpsert): ChannelRow;
  update(id: number, patch: Partial<ChannelUpsert>): ChannelRow;
  delete(id: number): boolean;
  setEnabled(id: number, enabled: boolean): ChannelRow;
}

interface DbRow {
  id: number;
  name: string;
  kind: string;
  operator_agent_id: string;
  config: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

/** Encrypted-at-rest fields per channel kind. Anything in this list is
 *  pulled through {decrypt,encrypt}Secret on the way in/out of the DB so
 *  the rest of the app sees plaintext but disk never does. */
const SECRET_FIELDS: Record<string, readonly string[]> = {
  telegram: ['bot_token'],
};

function decryptConfig(kind: string, raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const fields = SECRET_FIELDS[kind];
  if (!fields) return raw;
  const out = { ...(raw as Record<string, unknown>) };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === 'string' && v.length > 0) out[f] = decryptSecret(v);
  }
  return out;
}

function encryptConfig(kind: string, plain: unknown): unknown {
  if (!plain || typeof plain !== 'object') return plain;
  const fields = SECRET_FIELDS[kind];
  if (!fields) return plain;
  const out = { ...(plain as Record<string, unknown>) };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === 'string' && v.length > 0) out[f] = encryptSecret(v);
  }
  return out;
}

function rowToChannel(r: DbRow): ChannelRow {
  const parsed: Record<string, unknown> = r.config ? JSON.parse(r.config) as Record<string, unknown> : {};
  return {
    id: r.id,
    name: r.name,
    kind: ChannelKindSchema.parse(r.kind),
    operator_agent_id: r.operator_agent_id,
    config: decryptConfig(r.kind, parsed),
    enabled: r.enabled === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export class SqliteChannelStore implements ChannelStore {
  constructor(private readonly db: Db) {}

  list(): ChannelRow[] {
    const rows = this.db.prepare('SELECT * FROM channels ORDER BY id ASC').all() as DbRow[];
    return rows.map(rowToChannel);
  }

  listEnabled(): ChannelRow[] {
    const rows = this.db.prepare('SELECT * FROM channels WHERE enabled = 1 ORDER BY id ASC').all() as DbRow[];
    return rows.map(rowToChannel);
  }

  read(id: number): ChannelRow | null {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as DbRow | undefined;
    return row ? rowToChannel(row) : null;
  }

  readByName(name: string): ChannelRow | null {
    const row = this.db.prepare('SELECT * FROM channels WHERE name = ?').get(name) as DbRow | undefined;
    return row ? rowToChannel(row) : null;
  }

  create(input: ChannelUpsert): ChannelRow {
    const encConfig = encryptConfig(input.kind, input.config);
    const r = this.db
      .prepare(
        `INSERT INTO channels (name, kind, operator_agent_id, config, enabled)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.kind,
        input.operator_agent_id,
        JSON.stringify(encConfig),
        input.enabled === false ? 0 : 1,
      );
    const id = Number(r.lastInsertRowid);
    logger.info('channel.create', { id, name: input.name, kind: input.kind, operator: input.operator_agent_id });
    const saved = this.read(id);
    if (!saved) throw new Error(`create vanished for ${input.name}`);
    return saved;
  }

  update(id: number, patch: Partial<ChannelUpsert>): ChannelRow {
    const existing = this.read(id);
    if (!existing) throw new Error(`channel ${id} not found`);
    const next: ChannelUpsert = {
      name: patch.name ?? existing.name,
      kind: patch.kind ?? existing.kind,
      operator_agent_id: patch.operator_agent_id ?? existing.operator_agent_id,
      config: patch.config ?? existing.config,
      enabled: patch.enabled ?? existing.enabled,
    };
    const encConfig = encryptConfig(next.kind, next.config);
    this.db
      .prepare(
        `UPDATE channels
            SET name = ?, kind = ?, operator_agent_id = ?, config = ?, enabled = ?,
                updated_at = strftime('%s','now')
          WHERE id = ?`,
      )
      .run(
        next.name,
        next.kind,
        next.operator_agent_id,
        JSON.stringify(encConfig),
        next.enabled ? 1 : 0,
        id,
      );
    logger.info('channel.update', { id, name: next.name });
    return this.read(id) as ChannelRow;
  }

  delete(id: number): boolean {
    const r = this.db.prepare('DELETE FROM channels WHERE id = ?').run(id);
    const removed = r.changes > 0;
    if (removed) logger.info('channel.delete', { id });
    return removed;
  }

  setEnabled(id: number, enabled: boolean): ChannelRow {
    this.db
      .prepare(`UPDATE channels SET enabled = ?, updated_at = strftime('%s','now') WHERE id = ?`)
      .run(enabled ? 1 : 0, id);
    const updated = this.read(id);
    if (!updated) throw new Error(`channel ${id} not found`);
    logger.info('channel.set-enabled', { id, enabled });
    return updated;
  }
}
