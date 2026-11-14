import type { PluginDb } from '../types.js';

/**
 * Sessions over one backlog. A session is a chat: a dated window the operator
 * fills by naming what they want to work on. Items live once, in the backlog,
 * and a session only links to them, so nothing is ever copied forward and no
 * session shows anything the operator did not put there.
 */
export type ItemStatus = 'open' | 'done' | 'dropped';
export type EventKind = 'added' | 'pulled' | 'done' | 'reopened' | 'dropped' | 'edited';

export interface Session {
  id: number;
  conversation_id: number;
  date: string;
  topic: string;
  created_at: number;
}

export interface SessionSummary extends Session {
  open: number;
  done: number;
  dropped: number;
}

export interface Item {
  id: number;
  title: string;
  notes: string;
  status: ItemStatus;
  priority: number;
  due: string | null;
  parent_id: number | null;
  blocker: string;
  drop_reason: string;
  tags: string[];
  created_session: number | null;
  closed_session: number | null;
  created_at: number;
  updated_at: number;
  done_at: number | null;
}

export interface ItemCreate {
  title: string;
  notes?: string;
  tags?: string[];
  due?: string | null;
  priority?: number;
  parent_id?: number | null;
}

export interface ItemPatch {
  title?: string;
  notes?: string;
  tags?: string[];
  due?: string | null;
  priority?: number;
  blocker?: string;
  parent_id?: number | null;
}

export interface ItemEvent {
  id: number;
  item_id: number;
  session_id: number | null;
  kind: EventKind;
  detail: string;
  at: number;
}

export interface TagCount { tag: string; count: number }

interface ItemRow {
  id: number; title: string; notes: string; status: ItemStatus; priority: number; due: string | null;
  parent_id: number | null; blocker: string; drop_reason: string; created_session: number | null;
  closed_session: number | null; created_at: number; updated_at: number; done_at: number | null;
}

const TAG_LIMIT = 8;

/** Tags are a shared vocabulary, so they are folded to one spelling. */
export function normalizeTag(raw: string): string {
  // The first replace collapses runs, so at most one dash can sit at either end.
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
}

export function normalizeTags(raw: string[] | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const r of raw) {
    const t = normalizeTag(String(r));
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= TAG_LIMIT) break;
  }
  return out;
}

/** Title matching for de-duplication ignores case, punctuation and spacing. */
export function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export class TaskStore {
  private readonly t: (name: string) => string;

  constructor(private readonly db: PluginDb) {
    this.t = (n) => db.table(n);
  }

  // ---- sessions -----------------------------------------------------------

  startSession(conversation_id: number, date: string, topic = ''): Session {
    const existing = this.sessionByConversation(conversation_id);
    if (existing) return existing;
    const r = this.db.prepare(
      `INSERT INTO ${this.t('sessions')} (conversation_id, date, topic, created_at) VALUES (?, ?, ?, ?)`,
    ).run(conversation_id, date, topic.trim(), nowSec());
    return this.getSession(Number(r.lastInsertRowid))!;
  }

  sessionByConversation(conversation_id: number): Session | null {
    return (this.db.prepare(`SELECT * FROM ${this.t('sessions')} WHERE conversation_id = ?`).get(conversation_id) as Session | undefined) ?? null;
  }

  getSession(id: number): Session | null {
    return (this.db.prepare(`SELECT * FROM ${this.t('sessions')} WHERE id = ?`).get(id) as Session | undefined) ?? null;
  }

  latestSession(): Session | null {
    return (this.db.prepare(`SELECT * FROM ${this.t('sessions')} ORDER BY id DESC LIMIT 1`).get() as Session | undefined) ?? null;
  }

  setTopic(id: number, topic: string): boolean {
    return this.db.prepare(`UPDATE ${this.t('sessions')} SET topic = ? WHERE id = ?`).run(topic.trim(), id).changes > 0;
  }

  listSessions(limit = 30): SessionSummary[] {
    const rows = this.db.prepare(`SELECT * FROM ${this.t('sessions')} ORDER BY id DESC LIMIT ?`).all(limit) as Session[];
    return rows.map(s => ({ ...s, ...this.sessionCounts(s.id) }));
  }

  sessionCounts(sessionId: number): { open: number; done: number; dropped: number } {
    const rows = this.db.prepare(
      `SELECT i.status AS status, COUNT(*) AS n FROM ${this.t('session_items')} si
         JOIN ${this.t('items')} i ON i.id = si.item_id
        WHERE si.session_id = ? GROUP BY i.status`,
    ).all(sessionId) as Array<{ status: ItemStatus; n: number }>;
    const out = { open: 0, done: 0, dropped: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  sessionItems(sessionId: number): Item[] {
    const rows = this.db.prepare(
      `SELECT i.* FROM ${this.t('session_items')} si JOIN ${this.t('items')} i ON i.id = si.item_id
        WHERE si.session_id = ? ORDER BY si.position ASC, i.id ASC`,
    ).all(sessionId) as ItemRow[];
    return rows.map(r => this.hydrate(r));
  }

  /** Links an item into a session. Returns false when it was already there. */
  linkToSession(sessionId: number, itemId: number, kind: EventKind = 'pulled'): boolean {
    const have = this.db.prepare(
      `SELECT 1 FROM ${this.t('session_items')} WHERE session_id = ? AND item_id = ?`,
    ).get(sessionId, itemId);
    if (have) return false;
    const pos = this.db.prepare(
      `SELECT COALESCE(MAX(position), 0) + 1 AS p FROM ${this.t('session_items')} WHERE session_id = ?`,
    ).get(sessionId) as { p: number };
    this.db.prepare(
      `INSERT INTO ${this.t('session_items')} (session_id, item_id, position, added_at) VALUES (?, ?, ?, ?)`,
    ).run(sessionId, itemId, pos.p, nowSec());
    if (kind === 'pulled') this.event(itemId, sessionId, 'pulled', '');
    return true;
  }

  // ---- items --------------------------------------------------------------

  createItem(input: ItemCreate, sessionId: number | null): Item {
    const now = nowSec();
    const r = this.db.prepare(
      `INSERT INTO ${this.t('items')} (title, notes, status, priority, due, parent_id, created_session, created_at, updated_at)
       VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.title.trim(), (input.notes ?? '').trim(), input.priority ?? 0, input.due ?? null,
      input.parent_id ?? null, sessionId, now, now,
    );
    const id = Number(r.lastInsertRowid);
    this.setTags(id, normalizeTags(input.tags));
    this.event(id, sessionId, 'added', '');
    if (sessionId != null) this.linkToSession(sessionId, id, 'added');
    return this.getItem(id)!;
  }

  getItem(id: number): Item | null {
    const row = this.db.prepare(`SELECT * FROM ${this.t('items')} WHERE id = ?`).get(id) as ItemRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  updateItem(id: number, patch: ItemPatch, sessionId: number | null): Item | null {
    const cur = this.getItem(id);
    if (!cur) return null;
    const sets: string[] = [];
    const params: unknown[] = [];
    const changed: string[] = [];
    const col = (name: string, next: unknown, current: unknown) => {
      if (next === undefined || next === current) return;
      sets.push(`${name} = ?`); params.push(next); changed.push(name);
    };
    const trimmed = (s: string | undefined) => (s === undefined ? undefined : s.trim());
    col('title', trimmed(patch.title), cur.title);
    col('notes', trimmed(patch.notes), cur.notes);
    col('due', patch.due, cur.due);
    col('priority', patch.priority, cur.priority);
    col('blocker', trimmed(patch.blocker), cur.blocker);
    col('parent_id', patch.parent_id, cur.parent_id);
    if (sets.length) {
      sets.push('updated_at = ?'); params.push(nowSec(), id);
      this.db.prepare(`UPDATE ${this.t('items')} SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
    if (patch.tags !== undefined) {
      const next = normalizeTags(patch.tags);
      if (next.join(',') !== cur.tags.join(',')) { this.setTags(id, next); changed.push('tags'); }
    }
    if (changed.length) this.event(id, sessionId, 'edited', changed.join(','));
    return this.getItem(id);
  }

  setStatus(id: number, status: ItemStatus, sessionId: number | null, reason = ''): Item | null {
    const cur = this.getItem(id);
    if (!cur) return null;
    if (cur.status === status) return cur;
    const now = nowSec();
    if (status === 'open') {
      this.db.prepare(
        `UPDATE ${this.t('items')} SET status = 'open', done_at = NULL, closed_session = NULL, drop_reason = '', updated_at = ? WHERE id = ?`,
      ).run(now, id);
      this.event(id, sessionId, 'reopened', '');
    } else {
      this.db.prepare(
        `UPDATE ${this.t('items')} SET status = ?, done_at = ?, closed_session = ?, drop_reason = ?, updated_at = ? WHERE id = ?`,
      ).run(status, status === 'done' ? now : null, sessionId, status === 'dropped' ? reason.trim() : '', now, id);
      this.event(id, sessionId, status, status === 'dropped' ? reason.trim() : '');
    }
    // Closing from a session the item was never shown in still records where it
    // happened, so the session's own counts stay honest.
    if (sessionId != null) this.linkToSession(sessionId, id, 'added');
    return this.getItem(id);
  }

  setTags(id: number, tags: string[]): void {
    this.db.prepare(`DELETE FROM ${this.t('item_tags')} WHERE item_id = ?`).run(id);
    const ins = this.db.prepare(`INSERT OR IGNORE INTO ${this.t('item_tags')} (item_id, tag) VALUES (?, ?)`);
    for (const tag of tags) ins.run(id, tag);
  }

  children(parentId: number): Item[] {
    const rows = this.db.prepare(`SELECT * FROM ${this.t('items')} WHERE parent_id = ? ORDER BY id ASC`).all(parentId) as ItemRow[];
    return rows.map(r => this.hydrate(r));
  }

  /**
   * The one open item that is clearly the same thing, or null. Equality after
   * normalisation, or containment when the shorter side is long enough to
   * mean something ("taxes" must not swallow "tax the jeep").
   */
  matchOpen(title: string): Item | null {
    const want = normalizeTitle(title);
    if (!want) return null;
    const rows = this.db.prepare(`SELECT * FROM ${this.t('items')} WHERE status = 'open' ORDER BY id DESC`).all() as ItemRow[];
    let partial: ItemRow | null = null;
    for (const r of rows) {
      const have = normalizeTitle(r.title);
      if (have === want) return this.hydrate(r);
      const shorter = Math.min(have.length, want.length);
      if (!partial && shorter >= 12 && (have.includes(want) || want.includes(have))) partial = r;
    }
    return partial ? this.hydrate(partial) : null;
  }

  find(opts: { q?: string; tag?: string; status?: ItemStatus; limit?: number; offset?: number }): Item[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status) { where.push('i.status = ?'); params.push(opts.status); }
    if (opts.tag) {
      where.push(`EXISTS (SELECT 1 FROM ${this.t('item_tags')} it WHERE it.item_id = i.id AND it.tag = ?)`);
      params.push(normalizeTag(opts.tag));
    }
    const terms = (opts.q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    for (const term of terms) {
      const like = '%' + term.replace(/[\\%_]/g, c => '\\' + c) + '%';
      where.push(String.raw`(lower(i.title) LIKE ? ESCAPE '\' OR lower(i.notes) LIKE ? ESCAPE '\')`);
      params.push(like, like);
    }
    const sql = `SELECT i.* FROM ${this.t('items')} i ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY i.priority DESC, CASE WHEN i.due IS NULL THEN 1 ELSE 0 END, i.due ASC, i.id DESC
                 LIMIT ? OFFSET ?`;
    params.push(opts.limit ?? 50, opts.offset ?? 0);
    return (this.db.prepare(sql).all(...params) as ItemRow[]).map(r => this.hydrate(r));
  }

  tags(): TagCount[] {
    return this.db.prepare(
      `SELECT it.tag AS tag, COUNT(*) AS count FROM ${this.t('item_tags')} it
         JOIN ${this.t('items')} i ON i.id = it.item_id
        GROUP BY it.tag ORDER BY count DESC, tag ASC`,
    ).all() as TagCount[];
  }

  counts(): { open: number; done: number; dropped: number } {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM ${this.t('items')} GROUP BY status`).all() as Array<{ status: ItemStatus; n: number }>;
    const out = { open: 0, done: 0, dropped: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  events(itemId: number): ItemEvent[] {
    return this.db.prepare(`SELECT * FROM ${this.t('events')} WHERE item_id = ? ORDER BY id ASC`).all(itemId) as ItemEvent[];
  }

  private event(itemId: number, sessionId: number | null, kind: EventKind, detail: string): void {
    this.db.prepare(
      `INSERT INTO ${this.t('events')} (item_id, session_id, kind, detail, at) VALUES (?, ?, ?, ?, ?)`,
    ).run(itemId, sessionId, kind, detail, nowSec());
  }

  private hydrate(r: ItemRow): Item {
    const tags = (this.db.prepare(`SELECT tag FROM ${this.t('item_tags')} WHERE item_id = ? ORDER BY tag`).all(r.id) as Array<{ tag: string }>).map(x => x.tag);
    return { ...r, tags };
  }
}

export function migrate(db: PluginDb): void {
  const t = (n: string) => db.table(n);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${t('sessions')} (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL UNIQUE,
      date            TEXT NOT NULL,
      topic           TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${t('items')} (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT NOT NULL,
      notes           TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped')),
      priority        INTEGER NOT NULL DEFAULT 0,
      due             TEXT,
      parent_id       INTEGER,
      blocker         TEXT NOT NULL DEFAULT '',
      drop_reason     TEXT NOT NULL DEFAULT '',
      created_session INTEGER,
      closed_session  INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      done_at         INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_${t('items')}_status ON ${t('items')}(status);
    CREATE INDEX IF NOT EXISTS idx_${t('items')}_parent ON ${t('items')}(parent_id);
    CREATE TABLE IF NOT EXISTS ${t('item_tags')} (
      item_id INTEGER NOT NULL,
      tag     TEXT NOT NULL,
      PRIMARY KEY (item_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_${t('item_tags')}_tag ON ${t('item_tags')}(tag);
    CREATE TABLE IF NOT EXISTS ${t('session_items')} (
      session_id INTEGER NOT NULL,
      item_id    INTEGER NOT NULL,
      position   INTEGER NOT NULL,
      added_at   INTEGER NOT NULL,
      PRIMARY KEY (session_id, item_id)
    );
    CREATE TABLE IF NOT EXISTS ${t('events')} (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id    INTEGER NOT NULL,
      session_id INTEGER,
      kind       TEXT NOT NULL,
      detail     TEXT NOT NULL DEFAULT '',
      at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${t('events')}_item ON ${t('events')}(item_id);
  `);
}
