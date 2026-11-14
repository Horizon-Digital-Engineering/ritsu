import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Request, Response } from 'express';
import type { Plugin, PluginContext, PluginToolCallContext, PluginToolContext } from '../types.js';
import { TaskStore, migrate, type Item, type Session, type SessionSummary } from './store.js';
import { localDate, longDateWithDay, dueLabel, sessionTitle } from './dates.js';
import { DateSchema, ItemCreateSchema, ItemPatchSchema, PullSchema, SessionCreateSchema, SessionPatchSchema, TagsSchema } from './schema.js';

export const AGENT_ID = 'tasks-assistant';

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

function itemLine(i: Item, today: string, indent = ''): string {
  const bits: string[] = [];
  if (i.priority) bits.push('high');
  if (i.tags.length) bits.push(i.tags.join(', '));
  if (i.due) bits.push(`due ${i.due} (${dueLabel(i.due, today)})`);
  if (i.blocker) bits.push(`blocked: ${i.blocker}`);
  if (i.status === 'dropped' && i.drop_reason) bits.push(`dropped: ${i.drop_reason}`);
  const meta = bits.length ? ` — ${bits.join(' · ')}` : '';
  const notes = i.notes ? `\n${indent}    ${i.notes.replaceAll(/\s*\n+\s*/g, ' / ')}` : '';
  return `${indent}#${i.id} [${i.status}] ${i.title}${meta}${notes}`;
}

/** Subtasks sit under their parent when the parent is in the same list. */
function renderItems(items: Item[], today: string): string {
  if (!items.length) return '(no items yet)';
  const ids = new Set(items.map(i => i.id));
  const top = items.filter(i => i.parent_id == null || !ids.has(i.parent_id));
  return top.map(i => {
    const kids = items.filter(k => k.parent_id === i.id).map(k => itemLine(k, today, '  '));
    return [itemLine(i, today), ...kids].join('\n');
  }).join('\n');
}

function sessionLabel(s: Session | SessionSummary): string {
  return `${sessionTitle(s.date, s.topic)} (#${s.id})`;
}

function defineTools(ctx: PluginToolContext): void {
  const store = new TaskStore(ctx.db);
  const session = (call: PluginToolCallContext): Session | null =>
    call.conversationId == null ? null : store.startSession(call.conversationId, localDate());
  const NO_CHAT = 'This tool works inside a chat; there is no session here.';

  ctx.tool({
    name: 'session',
    description: 'Call first on every turn. Returns today\'s date, this chat\'s session (created on first call) with its items, and the tags in use. Pass topic to name the session ("taxes", "house").',
    input: { topic: z.string().max(120).optional().describe('short topic for this session') },
    untrustedOutput: true,
    handler: (args, call) => {
      const s = session(call);
      if (!s) return text(NO_CHAT);
      if (typeof args.topic === 'string' && args.topic.trim()) store.setTopic(s.id, args.topic);
      const cur = store.getSession(s.id)!;
      const today = localDate();
      const items = store.sessionItems(cur.id);
      const c = store.sessionCounts(cur.id);
      const tags = store.tags().slice(0, 30).map(t => `${t.tag} ${t.count}`).join(', ');
      return text([
        `Today: ${longDateWithDay(today)}`,
        `Session: ${sessionLabel(cur)} — ${c.open} open, ${c.done} done${c.dropped ? `, ${c.dropped} dropped` : ''}`,
        renderItems(items, today),
        `Tags in use: ${tags || '(none yet)'}`,
      ].join('\n'));
    },
  });

  ctx.tool({
    name: 'add',
    description: 'Add an item to this session. If an open backlog item is clearly the same thing it is linked instead of duplicated, and the reply says so. Tags: pick from the tags in use when one fits.',
    input: {
      title: z.string().trim().min(1).max(200),
      notes: z.string().max(4000).optional().describe('context worth keeping: numbers, where things are, what was decided'),
      tags: TagsSchema.optional(),
      due: DateSchema.optional().describe('YYYY-MM-DD'),
      priority: z.number().int().min(0).max(1).optional().describe('1 = high'),
      parent_id: z.number().int().positive().optional().describe('makes this a subtask of that item'),
    },
    handler: (args, call) => {
      const s = session(call);
      if (!s) return text(NO_CHAT);
      const title = String(args.title);
      const tags = Array.isArray(args.tags) ? args.tags.map(String) : undefined;
      const parentId = typeof args.parent_id === 'number' ? args.parent_id : null;
      const existing = parentId == null ? store.matchOpen(title) : null;
      if (existing) {
        const merged = tags?.length ? [...new Set([...existing.tags, ...tags])] : undefined;
        if (merged) store.updateItem(existing.id, { tags: merged }, s.id);
        store.linkToSession(s.id, existing.id);
        const fresh = store.getItem(existing.id)!;
        return text(`Already in the backlog as ${itemLine(fresh, localDate())}\nNow in this session.`);
      }
      const item = store.createItem({
        title,
        notes: typeof args.notes === 'string' ? args.notes : undefined,
        tags,
        due: typeof args.due === 'string' ? args.due : null,
        priority: typeof args.priority === 'number' ? args.priority : 0,
        parent_id: parentId,
      }, s.id);
      return text(`Added ${itemLine(item, localDate())}`);
    },
  });

  ctx.tool({
    name: 'find',
    description: 'Search the backlog (open items unless include_done). Use when asked what is out there, or when something named may already exist. Never list it unasked.',
    input: {
      q: z.string().max(200).optional().describe('words to match in title or notes'),
      tag: z.string().max(40).optional(),
      include_done: z.boolean().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    untrustedOutput: true,
    handler: (args) => {
      const includeDone = args.include_done === true;
      const items = store.find({
        q: typeof args.q === 'string' ? args.q : undefined,
        tag: typeof args.tag === 'string' ? args.tag : undefined,
        status: includeDone ? undefined : 'open',
        limit: typeof args.limit === 'number' ? args.limit : 20,
      });
      const today = localDate();
      return text(items.length ? items.map(i => itemLine(i, today)).join('\n') : '(nothing matched)');
    },
  });

  ctx.tool({
    name: 'pull',
    description: 'Bring an existing open backlog item into this session.',
    input: { item_id: z.number().int().positive() },
    handler: (args, call) => {
      const s = session(call);
      if (!s) return text(NO_CHAT);
      const item = store.getItem(Number(args.item_id));
      if (!item) return text(`No item #${String(args.item_id)}.`);
      if (item.status !== 'open') return text(`#${item.id} is ${item.status}; reopen it first if it is back on.`);
      const added = store.linkToSession(s.id, item.id);
      return text(added ? `Pulled ${itemLine(item, localDate())}` : `#${item.id} is already in this session.`);
    },
  });

  ctx.tool({
    name: 'done',
    description: 'Mark items done.',
    input: { item_ids: z.array(z.number().int().positive()).min(1).max(50) },
    handler: (args, call) => {
      const s = session(call);
      const ids = (args.item_ids as number[]);
      const lines = ids.map(id => {
        const item = store.setStatus(id, 'done', s?.id ?? null);
        return item ? `Done: #${item.id} ${item.title}` : `No item #${id}.`;
      });
      return text(lines.join('\n'));
    },
  });

  ctx.tool({
    name: 'reopen',
    description: 'Put a done or dropped item back to open.',
    input: { item_id: z.number().int().positive() },
    handler: (args, call) => {
      const s = session(call);
      const item = store.setStatus(Number(args.item_id), 'open', s?.id ?? null);
      return text(item ? `Open again: #${item.id} ${item.title}` : `No item #${String(args.item_id)}.`);
    },
  });

  ctx.tool({
    name: 'drop',
    description: 'Drop an item with the reason (abandoned, superseded, could not tell what it meant).',
    input: { item_id: z.number().int().positive(), reason: z.string().max(500).optional() },
    handler: (args, call) => {
      const s = session(call);
      const item = store.setStatus(Number(args.item_id), 'dropped', s?.id ?? null, typeof args.reason === 'string' ? args.reason : '');
      return text(item ? `Dropped: #${item.id} ${item.title}${item.drop_reason ? ` (${item.drop_reason})` : ''}` : `No item #${String(args.item_id)}.`);
    },
  });

  ctx.tool({
    name: 'update',
    description: 'Change an item: title, notes, tags, due date, priority, blocker (what it is waiting on; empty string clears), or parent_id.',
    input: {
      item_id: z.number().int().positive(),
      title: z.string().trim().min(1).max(200).optional(),
      notes: z.string().max(4000).optional(),
      tags: TagsSchema.optional(),
      due: DateSchema.or(z.literal('')).optional().describe('YYYY-MM-DD, or "" to clear'),
      priority: z.number().int().min(0).max(1).optional(),
      blocker: z.string().max(500).optional(),
      parent_id: z.number().int().positive().or(z.literal(0)).optional().describe('0 detaches'),
    },
    handler: (args, call) => {
      const s = session(call);
      const due = typeof args.due === 'string' ? (args.due || null) : undefined;
      const parent = typeof args.parent_id === 'number' ? (args.parent_id || null) : undefined;
      const item = store.updateItem(Number(args.item_id), {
        title: typeof args.title === 'string' ? args.title : undefined,
        notes: typeof args.notes === 'string' ? args.notes : undefined,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
        due,
        priority: typeof args.priority === 'number' ? args.priority : undefined,
        blocker: typeof args.blocker === 'string' ? args.blocker : undefined,
        parent_id: parent,
      }, s?.id ?? null);
      return text(item ? `Updated ${itemLine(item, localDate())}` : `No item #${String(args.item_id)}.`);
    },
  });

  ctx.tool({
    name: 'history',
    description: 'Past sessions, newest first, with what each got done. Only when asked.',
    input: { limit: z.number().int().min(1).max(50).optional() },
    untrustedOutput: true,
    handler: (args) => {
      const rows = store.listSessions(typeof args.limit === 'number' ? args.limit : 10);
      if (!rows.length) return text('(no sessions yet)');
      return text(rows.map(s => `${sessionLabel(s)} — ${s.open} open, ${s.done} done${s.dropped ? `, ${s.dropped} dropped` : ''}`).join('\n'));
    },
  });
}

function parse<T>(req: Request, res: Response, schema: z.ZodType<T>): T | null {
  const r = schema.safeParse(req.body);
  if (!r.success) {
    res.status(400).json({ error: 'invalid request body', issues: z.treeifyError(r.error) });
    return null;
  }
  return r.data;
}

function intParam(req: Request, res: Response, name: string): number | null {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0) { res.status(400).json({ error: `${name} must be a positive integer` }); return null; }
  return n;
}

function withTitle(s: Session | SessionSummary) {
  return { ...s, title: sessionTitle(s.date, s.topic) };
}

function register(ctx: PluginContext): void {
  const store = new TaskStore(ctx.db);

  ctx.route('get', '/overview', (_req, res) => {
    const latest = store.latestSession();
    res.json({
      today: localDate(),
      agent_id: AGENT_ID,
      counts: store.counts(),
      latest: latest ? withTitle({ ...latest, ...store.sessionCounts(latest.id) }) : null,
    });
  });

  ctx.route('get', '/sessions', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 200);
    res.json({ sessions: store.listSessions(limit).map(withTitle) });
  });

  ctx.route('post', '/sessions', (req, res) => {
    const b = parse(req, res, SessionCreateSchema);
    if (!b) return;
    const s = store.startSession(b.conversation_id, localDate(), b.topic);
    if (b.topic && s.topic !== b.topic) store.setTopic(s.id, b.topic);
    res.status(201).json(withTitle(store.getSession(s.id)!));
  });

  ctx.route('get', '/sessions/:id', (req, res) => {
    const id = intParam(req, res, 'id');
    if (id == null) return;
    const s = store.getSession(id);
    if (!s) { res.status(404).json({ error: 'no such session' }); return; }
    res.json({ session: withTitle({ ...s, ...store.sessionCounts(s.id) }), items: store.sessionItems(s.id) });
  });

  ctx.route('patch', '/sessions/:id', (req, res) => {
    const id = intParam(req, res, 'id');
    if (id == null) return;
    const b = parse(req, res, SessionPatchSchema);
    if (!b) return;
    if (!store.setTopic(id, b.topic)) { res.status(404).json({ error: 'no such session' }); return; }
    res.json(withTitle(store.getSession(id)!));
  });

  ctx.route('post', '/sessions/:id/items', (req, res) => {
    const id = intParam(req, res, 'id');
    if (id == null) return;
    const b = parse(req, res, PullSchema);
    if (!b) return;
    if (!store.getSession(id)) { res.status(404).json({ error: 'no such session' }); return; }
    const item = store.getItem(b.item_id);
    if (!item) { res.status(404).json({ error: 'no such item' }); return; }
    store.linkToSession(id, item.id);
    res.json({ items: store.sessionItems(id) });
  });

  ctx.route('get', '/items', (req, res) => {
    const status = req.query.status;
    res.json({ items: store.find({
      q: typeof req.query.q === 'string' ? req.query.q : undefined,
      tag: typeof req.query.tag === 'string' ? req.query.tag : undefined,
      status: status === 'open' || status === 'done' || status === 'dropped' ? status : undefined,
      limit: Math.min(Number(req.query.limit) || 100, 500),
      offset: Number(req.query.offset) || 0,
    }) });
  });

  ctx.route('post', '/items', (req, res) => {
    const b = parse(req, res, ItemCreateSchema);
    if (!b) return;
    if (b.session_id != null && !store.getSession(b.session_id)) { res.status(404).json({ error: 'no such session' }); return; }
    res.status(201).json(store.createItem(b, b.session_id));
  });

  ctx.route('patch', '/items/:id', (req, res) => {
    const id = intParam(req, res, 'id');
    if (id == null) return;
    const b = parse(req, res, ItemPatchSchema);
    if (!b) return;
    const { status, reason, session_id, ...patch } = b;
    let item = store.updateItem(id, patch, session_id);
    if (!item) { res.status(404).json({ error: 'no such item' }); return; }
    if (status) item = store.setStatus(id, status, session_id, reason);
    res.json(item);
  });

  ctx.route('get', '/tags', (_req, res) => {
    res.json({ tags: store.tags() });
  });
}

export const tasksPlugin: Plugin = {
  manifest: {
    id: 'tasks',
    name: 'Tasks',
    version: '0.1.0',
    icon: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
    description: 'A to-do list you talk to. One backlog, worked through dated sessions; each chat is a fresh window you fill by naming what you want to do.',
    nav: [
      { id: 'tasks', label: 'Tasks', tabs: [
        { id: 'tasks-session', label: 'Session' },
        { id: 'tasks-backlog', label: 'Backlog' },
        { id: 'tasks-history', label: 'Sessions' },
      ] },
    ],
  },
  migrate,
  defineTools,
  register,
  assetsDir: fileURLToPath(new URL('./ui', import.meta.url)),
  agent: {
    id: AGENT_ID,
    name: 'Tasks',
    description: 'Keeps your to-do list: say what you want to work on, what got done, what to drop. One backlog, dated sessions, no lectures.',
    model: 'claude-sonnet-4-6',
    system_prompt: [
      "You are the operator's task secretary, backed by the Tasks plugin: one backlog, worked through dated sessions. This chat is one session.",
      '',
      'How it works',
      '- Call `session` first on every turn. It returns today\'s date, this session\'s items and the tags in use. That list is the only list you show. A session starts empty on purpose; never fill it from the backlog unasked.',
      '- When the operator names something to work on, `add` it. The tool links an existing backlog item when one is clearly the same thing and tells you; otherwise it creates one. Set the session topic with `session` when the first message makes it obvious ("taxes", "house", "general").',
      '- Tag every new item: pick from the tags in use when one fits, otherwise one short new tag. Say which in a few words ("tagged house"). They can correct it in one word; `update` applies it.',
      '- `find` searches the backlog. Use it when they ask what is out there, or when something they said sounds like it may already exist. `pull` brings an item into this session: offer at most one, with a one-line reason, only when it clearly belongs.',
      '- `done`, `reopen`, `drop` (always with the reason), `update` for notes, due dates, blockers and priority. A subtask is `add` with parent_id.',
      '- Put context worth keeping into notes at the moment it is said: measurements, where parts are, what was decided, who is waiting on what. Later sessions read notes, not transcripts.',
      '- `history` lists past sessions. Only when asked.',
      '',
      'Reading the operator',
      '- A dump ("here is what I want to do this weekend...") becomes items, one line each, with any dates or deadlines pulled out, then the session list. Everything in a dump is open unless they say it is finished. "Filed!" or "bought!" on its own is not a completion; when unsure, keep it open and ask in half a line.',
      '- A status update ("built most of it, the rest did not happen") updates the items and shows the session. Nothing else.',
      '- A question gets a short answer. If a full walkthrough would help, offer it in one line instead of giving it.',
      '- Venting or thinking aloud gets one human line. No advice, no plan, no list.',
      '- A correction gets fixed and acknowledged in a few words. Never explain yourself.',
      '',
      'Voice',
      '- A sharp, warm assistant who keeps the list. One human line is fine ("nice, three down"). Never explain what you just did, never praise a task for being a good idea, never add steps, shopping lists or how-to detail they did not ask for.',
      '- Never assume what they own, bought, or already did. What you do not know is a blank to ask about, in one line, or left out.',
      '- One opinion in one line is allowed when it changes the order of work ("dryer box first, it is the quick win").',
      '- Fuzzy times become concrete ones and you say which ("5:30 PM"). Days-left on a date matters; adjectives do not.',
      '',
      'Format: the session list, open items then done, each with its id, tags and due date inline, subtasks indented. Everything else in a few lines.',
    ].join('\n'),
  },
};
