import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Request, Response } from 'express';
import type { Plugin, PluginContext, PluginToolContext, PluginSecrets, PluginLogger } from '../types.js';
import { migrate } from './migrate.js';
import { FinanceStore } from './store.js';
import { PlaidClient, type PlaidEnv } from './providers/plaid.js';
import { SimpleFinClient, claimSetupToken } from './providers/simplefin.js';
import type { Provider } from './providers/types.js';
import { syncConnection, reapplyRules, refreshRecurring, enrichNew, type SyncResult } from './sync.js';
import { previewImport, commitImport } from './import/index.js';
import {
  netWorth, netWorthSeries, expandLines, cashFlow, spendByCategory, spendByPayee, incomeBySource, categoryTrend,
  budgetReport, upcomingRecurring, goalProgress, monthKey, monthRange, lastMonths, addDays,
} from './report.js';
import * as S from './schema.js';
import { categorizeByKeyword } from './categories.js';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const today = () => new Date().toISOString().slice(0, 10);
const money = (n: number | null | undefined, ccy = 'USD') => n == null ? '—' : `${n < 0 ? '-' : ''}${ccy === 'USD' ? '$' : `${ccy} `}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const whole = (n: number, ccy = 'USD') => `${n < 0 ? '-' : ''}${ccy === 'USD' ? '$' : `${ccy} `}${Math.abs(Math.round(n)).toLocaleString('en-US')}`;

// ---- providers from the plugin's secrets -----------------------------------
function plaidFrom(secrets: PluginSecrets): PlaidClient | null {
  const clientId = secrets.get('plaid_client_id');
  const secret = secrets.get('plaid_secret');
  if (!clientId || !secret) return null;
  const env = (secrets.get('plaid_env') as PlaidEnv) || 'sandbox';
  return new PlaidClient({ creds: { clientId, secret, env } });
}

function providerFor(store: FinanceStore, secrets: PluginSecrets, connId: string): Provider {
  const conn = store.getConnection(connId);
  if (!conn) throw new Error(`unknown connection ${connId}`);
  if (conn.provider === 'plaid') {
    const plaid = plaidFrom(secrets);
    const token = secrets.get(`plaid:${conn.id}:access_token`);
    if (!plaid || !token) throw new Error('Plaid credentials or access token missing');
    return plaid.provider(token, conn.label);
  }
  if (conn.provider === 'simplefin') {
    const url = secrets.get(`simplefin:${conn.id}:access_url`);
    if (!url) throw new Error('SimpleFIN access URL missing');
    return new SimpleFinClient(url).provider();
  }
  throw new Error(`unknown provider ${conn.provider}`);
}

async function syncAll(store: FinanceStore, secrets: PluginSecrets, logger: PluginLogger): Promise<Record<string, SyncResult | string>> {
  const out: Record<string, SyncResult | string> = {};
  for (const c of store.listConnections()) {
    try {
      out[c.id] = await syncConnection(store, providerFor(store, secrets, c.id), c.id);
      logger.info('synced', { connection: c.id, ...(out[c.id] as SyncResult) });
    } catch (e) {
      const msg = (e as Error).message;
      store.setConnectionStatus(c.id, 'error', msg);
      out[c.id] = `error: ${msg}`;
      logger.warn('sync-failed', { connection: c.id, err: msg });
    }
  }
  return out;
}

/** Plaid link completion: exchange, persist the token, record the connection, first sync. */
async function linkPlaid(store: FinanceStore, secrets: PluginSecrets, plaid: PlaidClient, publicToken: string, institution?: string): Promise<string> {
  const { access_token, item_id } = await plaid.exchangePublicToken(publicToken);
  secrets.set(`plaid:${item_id}:access_token`, access_token);
  store.upsertConnection({ id: item_id, provider: 'plaid', label: institution ?? 'Plaid' });
  await syncConnection(store, plaid.provider(access_token, institution ?? ''), item_id);
  return item_id;
}

// ---- report assembly shared by routes and tools ----------------------------
function linesFor(store: FinanceStore, from: string, to: string) {
  const txns = store.ledger(from, to);
  const splits = store.splitsFor(txns.filter(t => t.category_source === 'user').map(t => t.id));
  return { txns, lines: expandLines(txns, splits) };
}

function asOf(store: FinanceStore): string | null {
  const ts = store.lastSyncedAt();
  const manual = store.listAccounts().map(a => a.balance_as_of).filter(Boolean).sort((a, b) => a.localeCompare(b)).at(-1);
  if (!ts) return manual ?? null;
  return new Date(ts * 1000).toISOString();
}

function overview(store: FinanceStore) {
  const accounts = store.listAccounts();
  const categories = store.listCategories(true);
  const t = today();
  const month = monthKey(t);
  const { from, to } = monthRange(month);
  const { lines } = linesFor(store, from, to);
  const months = lastMonths(month, 6);
  const sixMo = linesFor(store, monthRange(months[0]).from, to).lines;
  const flow = cashFlow(sixMo, categories, months);
  const budgets = budgetReport(lines, categories, store.listBudgets(), month);
  const from30 = addDays(t, -30);
  const series = netWorthSeries(store.balanceHistory(from30, t), store.balancesBefore(from30), accounts, from30, t);
  const nw = netWorth(accounts);
  const recent = store.listTransactions({ limit: 12 }).rows;
  return {
    as_of: asOf(store),
    net_worth: nw,
    net_worth_change_30d: series.length >= 2 ? nw.net - series[0].net : null,
    net_worth_series: series,
    month, cash_flow: flow,
    budgets: { totals: budgets.totals, over: budgets.lines.filter(l => l.over).slice(0, 5) },
    top_categories: spendByCategory(lines, categories).slice(0, 6),
    upcoming: upcomingRecurring(store.listRecurring(), t, 14),
    goals: store.listGoals().map(g => goalProgress(g, accounts, t)),
    recent,
    uncategorized_count: store.listTransactions({ uncategorized: true, limit: 1 }).total,
    unreviewed_count: store.listTransactions({ unreviewed: true, limit: 1 }).total,
  };
}

// ---- agent tools (read-only over the ledger; fenced) -----------------------
function defineTools(ctx: PluginToolContext): void {
  const store = new FinanceStore(ctx.db);
  const stamp = () => { const a = asOf(store); return a ? `(data as of ${a.slice(0, 16).replace('T', ' ')} UTC)` : '(no data synced yet)'; };
  const catName = () => new Map(store.listCategories(true).map(c => [c.id, c.name]));

  ctx.tool({
    name: 'net_worth',
    description: 'Net worth right now (assets minus credit-card and loan balances), by account type, with the 30-day change.',
    input: {},
    untrustedOutput: true,
    handler: () => {
      const accounts = store.listAccounts();
      if (!accounts.length) return text('(no accounts yet)');
      const nw = netWorth(accounts);
      const t = today(), from = addDays(t, -30);
      const series = netWorthSeries(store.balanceHistory(from, t), store.balancesBefore(from), accounts, from, t);
      const delta = series.length >= 2 ? nw.net - series[0].net : null;
      const lines = nw.byType.map(x => `  ${x.type}: ${money(x.total, nw.currency)} (${x.accounts} acct)`).join('\n');
      return text(`Net worth: ${money(nw.net, nw.currency)} ${stamp()}\n  assets: ${money(nw.assets, nw.currency)}\n  liabilities: ${money(nw.liabilities, nw.currency)}${delta != null ? `\n  30-day change: ${money(delta, nw.currency)}` : ''}\nBy type:\n${lines}`);
    },
  });

  ctx.tool({
    name: 'list_accounts',
    description: 'Every account with its balance, type, institution and when the balance was last updated. Hidden accounts are marked.',
    input: {},
    untrustedOutput: true,
    handler: () => {
      const accts = store.listAccounts();
      if (!accts.length) return text('(no accounts yet)');
      return text(accts.map(a => `${a.name}${a.mask ? ` ••${a.mask}` : ''} [${a.type}${a.subtype ? `/${a.subtype}` : ''}] ${a.institution ? `@ ${a.institution} ` : ''}— ${money(a.balance, a.currency)} as of ${a.balance_as_of || '?'}${a.hidden ? ' (hidden)' : ''}${a.closed ? ' (closed)' : ''}`).join('\n'));
    },
  });

  ctx.tool({
    name: 'cash_flow',
    description: 'Income vs expenses per month for the last N months (default 6), with net and savings rate. Transfers excluded.',
    input: { months: z.number().int().min(1).max(36).optional().describe('how many months back, default 6') },
    untrustedOutput: true,
    handler: (args) => {
      const n = typeof args.months === 'number' ? args.months : 6;
      const months = lastMonths(monthKey(today()), n);
      const { lines } = linesFor(store, monthRange(months[0]).from, monthRange(months.at(-1)!).to);
      const rows = cashFlow(lines, store.listCategories(true), months);
      if (!rows.some(r => r.income || r.expenses)) return text(`(no transactions in the last ${n} months)`);
      return text(`Cash flow ${stamp()}\n` + rows.map(r => `  ${r.month}: income ${whole(r.income)}, expenses ${whole(r.expenses)}, net ${whole(r.net)}${r.savings_rate != null ? ` (${Math.round(r.savings_rate * 100)}% saved)` : ''}`).join('\n'));
    },
  });

  ctx.tool({
    name: 'spending_report',
    description: 'Spending for a period grouped by category, category group, or payee. Defaults to this month. Only outflows; transfers excluded.',
    input: {
      from: z.string().optional().describe('YYYY-MM-DD start (default: first of this month)'),
      to: z.string().optional().describe('YYYY-MM-DD end (default: today)'),
      by: z.enum(['category', 'group', 'payee']).optional().describe('grouping, default category'),
    },
    untrustedOutput: true,
    handler: (args) => {
      const t = today();
      const from = typeof args.from === 'string' ? args.from : monthRange(monthKey(t)).from;
      const to = typeof args.to === 'string' ? args.to : t;
      const { lines } = linesFor(store, from, to);
      const cats = store.listCategories(true);
      const by = args.by === 'payee' ? 'payee' : args.by === 'group' ? 'group' : 'category';
      const rows = by === 'payee' ? spendByPayee(lines, cats, 20).map(r => ({ name: r.payee, total: r.total, count: r.count }))
        : spendByCategory(lines, cats, by === 'group').map(r => ({ name: r.name, total: r.total, count: r.count }));
      if (!rows.length) return text(`(no spending between ${from} and ${to})`);
      const total = rows.reduce((s, r) => s + r.total, 0);
      return text(`Spending ${from} → ${to} by ${by}, total ${money(total)} ${stamp()}\n` + rows.map(r => `  ${r.name}: ${money(r.total)} (${r.count})`).join('\n'));
    },
  });

  ctx.tool({
    name: 'transactions',
    description: 'Find transactions by text, category, account or date range; newest first. Shows date, payee, amount, category and notes.',
    input: {
      query: z.string().max(100).optional().describe('text in payee, description or notes'),
      category_id: z.string().max(60).optional(),
      account_id: z.string().max(120).optional(),
      from: z.string().optional().describe('YYYY-MM-DD'),
      to: z.string().optional().describe('YYYY-MM-DD'),
      uncategorized: z.boolean().optional().describe('only rows without a category'),
      limit: z.number().int().min(1).max(200).optional().describe('default 50'),
    },
    untrustedOutput: true,
    handler: (args) => {
      const names = catName();
      const { rows, total } = store.listTransactions({
        q: typeof args.query === 'string' ? args.query : undefined,
        category_id: typeof args.category_id === 'string' ? args.category_id : undefined,
        account_id: typeof args.account_id === 'string' ? args.account_id : undefined,
        from: typeof args.from === 'string' ? args.from : undefined,
        to: typeof args.to === 'string' ? args.to : undefined,
        uncategorized: args.uncategorized === true,
        limit: typeof args.limit === 'number' ? args.limit : 50,
      });
      if (!rows.length) return text('(no matching transactions)');
      return text(`${total} match${total === 1 ? '' : 'es'}${rows.length < total ? `, showing ${rows.length}` : ''} ${stamp()}\n` +
        rows.map(r => `${r.date} ${r.payee}: ${money(r.amount, r.currency)} [${names.get(r.category_id ?? '') ?? 'uncategorized'}]${r.notes ? ` — ${r.notes}` : ''}${r.tags.length ? ` #${r.tags.join(' #')}` : ''}`).join('\n'));
    },
  });

  ctx.tool({
    name: 'recurring',
    description: 'Recurring charges and bills: confirmed and detected subscriptions with cadence, typical amount and next expected date; what is due in the next 30 days first.',
    input: {},
    untrustedOutput: true,
    handler: () => {
      const items = store.listRecurring().filter(r => r.status !== 'dismissed');
      if (!items.length) return text('(no recurring charges yet — they appear after a few months of history)');
      const t = today();
      const up = upcomingRecurring(items, t, 30);
      const monthly = items.reduce((s, r) => s + Math.abs(r.amount) * ({ weekly: 4.33, biweekly: 2.17, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 }[r.cadence] ?? 1), 0);
      const fmt = (r: typeof items[number]) => `  ${r.display_name}: ${money(Math.abs(r.amount))} ${r.cadence}, next ${r.next_date || '?'}${r.status === 'detected' ? ' (detected, unconfirmed)' : ''}`;
      return text(`Recurring ${stamp()}\nEstimated monthly total: ${money(monthly)}\n\nDue within 30 days:\n${up.length ? up.map(fmt).join('\n') : '  (none)'}\n\nAll:\n${items.map(fmt).join('\n')}`);
    },
  });

  ctx.tool({
    name: 'budget_status',
    description: "A month's spending against its budgets per category (default: this month): budgeted, actual, remaining, and what is over.",
    input: { month: z.string().optional().describe('YYYY-MM, default current month') },
    untrustedOutput: true,
    handler: (args) => {
      const month = typeof args.month === 'string' && /^\d{4}-\d{2}$/.test(args.month) ? args.month : monthKey(today());
      const { from, to } = monthRange(month);
      const { lines } = linesFor(store, from, to);
      const r = budgetReport(lines, store.listCategories(true), store.listBudgets(), month);
      if (!r.lines.length) return text(`(no budgets set) Actual spend in ${month}: ${money(r.totals.actual_expenses)}`);
      const T = r.totals;
      return text(`Budget ${month} ${stamp()}\n  expenses: ${money(T.actual_expenses)} of ${money(T.budgeted_expenses)} budgeted (${money(T.unbudgeted_expenses)} in unbudgeted categories)\n  income: ${money(T.actual_income)} of ${money(T.budgeted_income)} expected\n` +
        r.lines.map(l => `  ${l.name}: ${money(l.actual)} / ${money(l.budget)} — ${l.over ? `OVER by ${money(-l.remaining)}` : `${money(l.remaining)} left`}`).join('\n'));
    },
  });

  ctx.tool({
    name: 'category_trend',
    description: 'Monthly totals for one category or category group over the last N months (default 6) — "how has my grocery spend moved".',
    input: {
      category_id: z.string().max(60).optional(),
      group: z.string().max(60).optional().describe('category group name, e.g. "Food & Dining"'),
      months: z.number().int().min(1).max(36).optional(),
    },
    untrustedOutput: true,
    handler: (args) => {
      const n = typeof args.months === 'number' ? args.months : 6;
      const months = lastMonths(monthKey(today()), n);
      const { lines } = linesFor(store, monthRange(months[0]).from, monthRange(months.at(-1)!).to);
      const rows = categoryTrend(lines, store.listCategories(true), months, typeof args.category_id === 'string' ? args.category_id : undefined, typeof args.group === 'string' ? args.group : undefined);
      const label = typeof args.category_id === 'string' ? (catName().get(args.category_id) ?? args.category_id) : typeof args.group === 'string' ? args.group : 'all spending';
      const avg = rows.reduce((s, r) => s + r.total, 0) / rows.length;
      return text(`${label}, last ${n} months (avg ${money(avg)}/mo) ${stamp()}\n` + rows.map(r => `  ${r.month}: ${money(r.total)}`).join('\n'));
    },
  });

  ctx.tool({
    name: 'goals',
    description: 'Savings and payoff goals with progress, amount remaining, and the monthly pace needed to hit the target date.',
    input: {},
    untrustedOutput: true,
    handler: () => {
      const goals = store.listGoals();
      if (!goals.length) return text('(no goals set)');
      const accounts = store.listAccounts();
      const t = today();
      return text(goals.map(g => {
        const p = goalProgress(g, accounts, t);
        return `${g.name} (${g.kind}): ${money(p.current)} of ${money(g.target_amount)} — ${Math.round(p.progress * 100)}%${g.target_date ? `, target ${g.target_date}, needs ${money(p.monthly_needed)}/mo${p.on_track == null ? '' : p.on_track ? ', on track' : ', behind'}` : ''}`;
      }).join('\n'));
    },
  });

  ctx.tool({
    name: 'holdings',
    description: 'Investment holdings by account: symbol, quantity, market value and cost basis, where the provider supplies them.',
    input: {},
    untrustedOutput: true,
    handler: () => {
      const rows = store.listHoldings();
      if (!rows.length) return text('(no holdings data)');
      const accts = new Map(store.listAccounts().map(a => [a.id, a.name]));
      return text(rows.map(h => `${accts.get(h.account_id) ?? h.account_id}: ${h.symbol || h.description} ×${h.quantity ?? '?'} = ${money(h.market_value, h.currency)}${h.cost_basis != null ? ` (basis ${money(h.cost_basis, h.currency)})` : ''} as of ${h.as_of}`).join('\n'));
    },
  });
}

// ---- admin routes ----------------------------------------------------------
function parse<T>(req: Request, res: Response, schema: z.ZodType<T>, src: unknown = req.body): T | null {
  const r = schema.safeParse(src);
  if (!r.success) { res.status(400).json({ error: 'invalid request', issues: z.treeifyError(r.error) }); return null; }
  return r.data;
}
const param = (req: Request, name: string) => String(req.params[name] ?? '');
const fail = (res: Response, e: unknown) => { res.status(502).json({ error: (e as Error).message }); };

function register(ctx: PluginContext): void {
  const store = new FinanceStore(ctx.db);
  const { secrets, logger } = ctx;
  const requirePlaid = (res: Response): PlaidClient | null => {
    const p = plaidFrom(secrets);
    if (!p) res.status(409).json({ error: 'Plaid is not configured — save credentials first' });
    return p;
  };

  ctx.schedule({
    name: 'sync', title: 'Finance: sync connections', kind: 'every', spec: '24h',
    run: async () => {
      const r = await syncAll(store, secrets, logger);
      const errors = Object.entries(r).filter(([, v]) => typeof v === 'string');
      return errors.length ? `Finance sync errors:\n${errors.map(([k, v]) => `- ${store.getConnection(k)?.label || k}: ${v as string}`).join('\n')}` : '';
    },
  });

  // ---- overview / accounts ----
  ctx.route('get', '/overview', (_req, res) => { res.json(overview(store)); });
  ctx.route('get', '/accounts', (_req, res) => {
    const accounts = store.listAccounts();
    res.json({ accounts, net_worth: netWorth(accounts), as_of: asOf(store), connections: store.listConnections().map(c => ({ id: c.id, label: c.label, provider: c.provider, status: c.status })) });
  });
  ctx.route('post', '/accounts', (req, res) => {
    const b = parse(req, res, S.ManualAccountSchema); if (!b) return;
    const id = `manual:${randomBytes(6).toString('hex')}`;
    store.upsertAccount({ id, connection_id: null, name: b.name, type: b.type, balance: b.balance, currency: b.currency, institution: b.institution, balance_as_of: today() });
    res.status(201).json({ account: store.getAccount(id) });
  });
  ctx.route('patch', '/accounts/:id', (req, res) => {
    const b = parse(req, res, S.AccountPatchSchema); if (!b) return;
    res.status(store.updateAccount(param(req, 'id'), b) ? 200 : 404).json({ account: store.getAccount(param(req, 'id')) });
  });
  ctx.route('put', '/accounts/:id/balance', (req, res) => {
    const b = parse(req, res, S.BalanceSchema); if (!b) return;
    res.status(store.setBalance(param(req, 'id'), b.balance, b.as_of ?? today()) ? 200 : 404).json({ account: store.getAccount(param(req, 'id')) });
  });
  ctx.route('delete', '/accounts/:id', (req, res) => { res.status(store.deleteAccount(param(req, 'id')) ? 204 : 404).end(); });
  ctx.route('get', '/networth/history', (req, res) => {
    const t = today();
    const from = typeof req.query.from === 'string' ? req.query.from : addDays(t, -365);
    const to = typeof req.query.to === 'string' ? req.query.to : t;
    res.json({ from, to, series: netWorthSeries(store.balanceHistory(from, to), store.balancesBefore(from), store.listAccounts(), from, to) });
  });

  // ---- transactions ----
  ctx.route('get', '/transactions', (req, res) => {
    const q = parse(req, res, S.TxnQuerySchema, req.query); if (!q) return;
    const r = store.listTransactions(q);
    res.json({ ...r, splits: Object.fromEntries(store.splitsFor(r.rows.map(x => x.id))) });
  });
  ctx.route('post', '/transactions', (req, res) => {
    const b = parse(req, res, S.ManualTxnSchema); if (!b) return;
    if (!store.getAccount(b.account_id)) { res.status(404).json({ error: 'unknown account' }); return; }
    const guess = b.category_id ? null : categorizeByKeyword(b.payee);
    const t = store.insertManualTransaction({ ...b, category_id: b.category_id ?? guess, category_source: b.category_id ? 'user' : guess ? 'provider' : 'none' });
    if (!b.category_id) enrichNew(store, store.listRules(), t);
    res.status(201).json({ transaction: store.getTransaction(t.id) });
  });
  ctx.route('patch', '/transactions/:id', (req, res) => {
    const b = parse(req, res, S.TxnPatchSchema); if (!b) return;
    const ok = store.updateTransaction(param(req, 'id'), b);
    res.status(ok ? 200 : 404).json({ transaction: store.getTransaction(param(req, 'id')) });
  });
  ctx.route('delete', '/transactions/:id', (req, res) => { res.status(store.deleteTransaction(param(req, 'id')) ? 204 : 404).end(); });
  ctx.route('put', '/transactions/:id/splits', (req, res) => {
    const b = parse(req, res, S.SplitsSchema); if (!b) return;
    const t = store.getTransaction(param(req, 'id'));
    if (!t) { res.status(404).json({ error: 'unknown transaction' }); return; }
    const sum = b.splits.reduce((s, x) => s + x.amount, 0);
    if (b.splits.length && Math.abs(sum - t.amount) > 0.005) { res.status(400).json({ error: `splits total ${sum.toFixed(2)} must equal the transaction amount ${t.amount.toFixed(2)}` }); return; }
    store.setSplits(t.id, b.splits);
    res.json({ transaction: store.getTransaction(t.id), splits: store.splitsFor([t.id]).get(t.id) ?? [] });
  });
  ctx.route('post', '/transactions/bulk', (req, res) => {
    const b = parse(req, res, S.BulkSchema); if (!b) return;
    let n = 0;
    store.transaction(() => { for (const id of b.ids) if (store.updateTransaction(id, { category_id: b.category_id, reviewed: b.reviewed, excluded: b.excluded })) n++; });
    res.json({ updated: n });
  });
  ctx.route('get', '/transactions/export.csv', (req, res) => {
    const from = typeof req.query.from === 'string' ? req.query.from : '1900-01-01';
    const to = typeof req.query.to === 'string' ? req.query.to : '2999-12-31';
    const names = new Map(store.listCategories(true).map(c => [c.id, c.name]));
    const accts = new Map(store.listAccounts().map(a => [a.id, a.name]));
    const rows = store.ledger(from, to, { includeExcluded: true });
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const body = ['date,account,payee,description,amount,currency,category,notes,excluded,tags',
      ...rows.map(r => [r.date, esc(accts.get(r.account_id) ?? r.account_id), esc(r.payee), esc(r.description), r.amount.toFixed(2), r.currency,
        esc(names.get(r.category_id ?? '') ?? ''), esc(r.notes), r.excluded ? '1' : '0', esc(r.tags.join(' '))].join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transactions-${from}-${to}.csv"`);
    res.send(body);
  });
  ctx.route('get', '/tags', (_req, res) => { res.json({ tags: store.listTags() }); });

  // ---- categories / rules ----
  ctx.route('get', '/categories', (req, res) => { res.json({ categories: store.listCategories(req.query.all === '1'), map: store.providerCategoryMap() }); });
  ctx.route('post', '/categories', (req, res) => {
    const b = parse(req, res, S.CategorySchema); if (!b) return;
    if (store.getCategory(b.id)) { res.status(409).json({ error: 'category id exists' }); return; }
    res.status(201).json({ category: store.createCategory(b) });
  });
  ctx.route('patch', '/categories/:id', (req, res) => {
    const b = parse(req, res, S.CategoryPatchSchema); if (!b) return;
    res.status(store.updateCategory(param(req, 'id'), b) ? 200 : 404).json({ category: store.getCategory(param(req, 'id')) });
  });
  ctx.route('delete', '/categories/:id', (req, res) => { res.status(store.deleteCategory(param(req, 'id')) ? 204 : 404).end(); });
  ctx.route('put', '/category-map', (req, res) => {
    const b = parse(req, res, S.CategoryMapSchema); if (!b) return;
    store.setProviderCategory(b.provider_category, b.category_id);
    res.json({ map: store.providerCategoryMap() });
  });
  ctx.route('get', '/rules', (_req, res) => { res.json({ rules: store.listRules() }); });
  ctx.route('post', '/rules', (req, res) => {
    const b = parse(req, res, S.RuleSchema); if (!b) return;
    const { apply_to_existing, ...def } = b;
    const rule = store.createRule(def);
    const applied = apply_to_existing ? reapplyRules(store) : 0;
    res.status(201).json({ rule, applied });
  });
  ctx.route('patch', '/rules/:id', (req, res) => {
    const b = parse(req, res, S.RulePatchSchema); if (!b) return;
    const id = Number(param(req, 'id'));
    res.status(store.updateRule(id, b) ? 200 : 404).json({ rule: store.listRules().find(r => r.id === id) ?? null });
  });
  ctx.route('delete', '/rules/:id', (req, res) => { res.status(store.deleteRule(Number(param(req, 'id'))) ? 204 : 404).end(); });
  ctx.route('post', '/rules/apply', (_req, res) => { res.json({ applied: reapplyRules(store) }); });

  // ---- budgets ----
  ctx.route('get', '/budgets', (req, res) => {
    const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : monthKey(today());
    const { from, to } = monthRange(month);
    const { lines } = linesFor(store, from, to);
    const categories = store.listCategories();
    res.json({ ...budgetReport(lines, categories, store.listBudgets(), month), budgets: store.listBudgets(), categories, spend: spendByCategory(lines, categories) });
  });
  ctx.route('put', '/budgets', (req, res) => {
    const b = parse(req, res, S.BudgetSchema); if (!b) return;
    store.setBudget(b.category_id, b.month, b.amount);
    res.json({ ok: true });
  });
  ctx.route('delete', '/budgets/:category/:month', (req, res) => { res.status(store.deleteBudget(param(req, 'category'), param(req, 'month')) ? 204 : 404).end(); });

  // ---- recurring ----
  ctx.route('get', '/recurring', (_req, res) => {
    const items = store.listRecurring();
    res.json({ recurring: items, upcoming: upcomingRecurring(items, today(), 30) });
  });
  ctx.route('post', '/recurring/detect', (_req, res) => { res.json({ detected: refreshRecurring(store), recurring: store.listRecurring() }); });
  ctx.route('post', '/recurring', (req, res) => {
    const b = parse(req, res, S.RecurringCreateSchema); if (!b) return;
    res.status(201).json({ recurring: store.createRecurring(b) });
  });
  ctx.route('patch', '/recurring/:id', (req, res) => {
    const b = parse(req, res, S.RecurringPatchSchema); if (!b) return;
    const id = Number(param(req, 'id'));
    res.status(store.updateRecurring(id, b) ? 200 : 404).json({ recurring: store.getRecurring(id) });
  });
  ctx.route('delete', '/recurring/:id', (req, res) => { res.status(store.deleteRecurring(Number(param(req, 'id'))) ? 204 : 404).end(); });

  // ---- reports ----
  ctx.route('get', '/reports/cashflow', (req, res) => {
    const n = Math.min(36, Math.max(1, Number(req.query.months) || 12));
    const months = lastMonths(monthKey(today()), n);
    const { lines } = linesFor(store, monthRange(months[0]).from, monthRange(months.at(-1)!).to);
    const categories = store.listCategories(true);
    res.json({ months: cashFlow(lines, categories, months), income_sources: incomeBySource(lines, categories).slice(0, 10) });
  });
  ctx.route('get', '/reports/spending', (req, res) => {
    const t = today();
    const from = typeof req.query.from === 'string' ? req.query.from : monthRange(monthKey(t)).from;
    const to = typeof req.query.to === 'string' ? req.query.to : t;
    const { lines } = linesFor(store, from, to);
    const categories = store.listCategories(true);
    res.json({ from, to, by_category: spendByCategory(lines, categories), by_group: spendByCategory(lines, categories, true), by_payee: spendByPayee(lines, categories, 20), total: spendByCategory(lines, categories).reduce((s, r) => s + r.total, 0) });
  });
  ctx.route('get', '/reports/trend', (req, res) => {
    const n = Math.min(36, Math.max(1, Number(req.query.months) || 12));
    const months = lastMonths(monthKey(today()), n);
    const { lines } = linesFor(store, monthRange(months[0]).from, monthRange(months.at(-1)!).to);
    const categories = store.listCategories(true);
    const groups = [...new Set(categories.filter(c => c.kind === 'expense').map(c => c.group_name))];
    res.json({
      months,
      total: categoryTrend(lines, categories, months),
      category: typeof req.query.category_id === 'string' ? categoryTrend(lines, categories, months, req.query.category_id) : null,
      by_group: groups.map(g => ({ group: g, series: categoryTrend(lines, categories, months, undefined, g) })).filter(g => g.series.some(s => s.total > 0)),
    });
  });

  // ---- goals / holdings ----
  ctx.route('get', '/goals', (_req, res) => {
    const accounts = store.listAccounts(); const t = today();
    res.json({ goals: store.listGoals().map(g => goalProgress(g, accounts, t)) });
  });
  ctx.route('post', '/goals', (req, res) => {
    const b = parse(req, res, S.GoalSchema); if (!b) return;
    const accounts = store.listAccounts();
    const start = b.kind === 'payoff' ? accounts.filter(a => b.account_ids.includes(a.id)).reduce((s, a) => s + a.balance, 0) : null;
    res.status(201).json({ goal: store.createGoal({ ...b, start_balance: start }) });
  });
  ctx.route('patch', '/goals/:id', (req, res) => {
    const b = parse(req, res, S.GoalPatchSchema); if (!b) return;
    const { kind: _k, ...patch } = b;
    res.status(store.updateGoal(Number(param(req, 'id')), patch) ? 200 : 404).json({ ok: true });
  });
  ctx.route('delete', '/goals/:id', (req, res) => { res.status(store.deleteGoal(Number(param(req, 'id'))) ? 204 : 404).end(); });
  ctx.route('get', '/holdings', (_req, res) => { res.json({ holdings: store.listHoldings() }); });

  // ---- connections ----
  ctx.route('get', '/connections', (_req, res) => {
    res.json({
      connections: store.listConnections(),
      plaid: { configured: secrets.has('plaid_client_id') && secrets.has('plaid_secret'), env: secrets.get('plaid_env') || 'sandbox' },
      as_of: asOf(store),
      imports: store.listImports(),
    });
  });
  ctx.route('post', '/connections/simplefin', async (req, res) => {
    const b = parse(req, res, S.SimpleFinSetupSchema); if (!b) return;
    try {
      const accessUrl = await claimSetupToken(b.setup_token);
      const id = `sf_${randomBytes(5).toString('hex')}`;
      secrets.set(`simplefin:${id}:access_url`, accessUrl);
      store.upsertConnection({ id, provider: 'simplefin', label: b.label || 'SimpleFIN' });
      const result = await syncConnection(store, new SimpleFinClient(accessUrl).provider(), id);
      // Name the connection after the banks it actually returned.
      const orgs = [...new Set(store.listAccounts().filter(a => a.connection_id === id).map(a => a.institution).filter(Boolean))];
      if (!b.label && orgs.length) store.upsertConnection({ id, provider: 'simplefin', label: orgs.join(', ').slice(0, 80) });
      logger.info('simplefin-linked', { connection: id, accounts: result.accounts });
      res.status(201).json({ connection: store.getConnection(id), result });
    } catch (e) { fail(res, e); }
  });
  ctx.route('post', '/connections/plaid/config', (req, res) => {
    const b = parse(req, res, S.PlaidConfigSchema); if (!b) return;
    secrets.set('plaid_client_id', b.client_id); secrets.set('plaid_secret', b.secret); secrets.set('plaid_env', b.env);
    logger.info('plaid-config-set', { env: b.env });
    res.json({ configured: true, env: b.env });
  });
  ctx.route('post', '/connections/plaid/sandbox', async (req, res) => {
    const plaid = requirePlaid(res); if (!plaid) return;
    const b = parse(req, res, S.SandboxLinkSchema); if (!b) return;
    try {
      const inst = b.institution_id || 'ins_109508';
      const { public_token } = await plaid.sandboxPublicToken(inst);
      const name = (await plaid.getInstitution(inst))?.name;
      res.status(201).json({ connection_id: await linkPlaid(store, secrets, plaid, public_token, name) });
    } catch (e) { fail(res, e); }
  });
  ctx.route('post', '/connections/plaid/link/start', async (_req, res) => {
    const plaid = requirePlaid(res); if (!plaid) return;
    try {
      const r = await plaid.createLinkToken({ userId: 'operator' });
      secrets.set('pending_link_token', r.link_token);
      res.json({ hosted_link_url: r.hosted_link_url ?? null, expiration: r.expiration });
    } catch (e) { fail(res, e); }
  });
  ctx.route('post', '/connections/plaid/link/complete', async (_req, res) => {
    const plaid = requirePlaid(res); if (!plaid) return;
    const linkToken = secrets.get('pending_link_token');
    if (!linkToken) { res.status(409).json({ error: 'no pending link session — start one first' }); return; }
    try {
      const { public_token } = await plaid.getLinkResults(linkToken);
      if (!public_token) { res.json({ linked: false, pending: true }); return; }
      const id = await linkPlaid(store, secrets, plaid, public_token);
      secrets.delete('pending_link_token');
      res.json({ linked: true, connection_id: id });
    } catch (e) { fail(res, e); }
  });
  ctx.route('post', '/connections/plaid/exchange', async (req, res) => {
    const plaid = requirePlaid(res); if (!plaid) return;
    const b = parse(req, res, S.ExchangeSchema); if (!b) return;
    try { res.json({ linked: true, connection_id: await linkPlaid(store, secrets, plaid, b.public_token) }); }
    catch (e) { fail(res, e); }
  });
  ctx.route('post', '/sync', async (_req, res) => { res.json({ results: await syncAll(store, secrets, logger), as_of: asOf(store) }); });
  ctx.route('post', '/connections/:id/sync', async (req, res) => {
    const id = param(req, 'id');
    try { res.json({ result: await syncConnection(store, providerFor(store, secrets, id), id) }); }
    catch (e) { store.setConnectionStatus(id, 'error', (e as Error).message); fail(res, e); }
  });
  ctx.route('delete', '/connections/:id', (req, res) => {
    const id = param(req, 'id');
    const conn = store.getConnection(id);
    if (!conn) { res.status(404).end(); return; }
    store.deleteConnection(id);
    secrets.delete(`plaid:${id}:access_token`);
    secrets.delete(`simplefin:${id}:access_url`);
    logger.info('connection-removed', { connection: id });
    res.status(204).end();
  });

  // ---- import ----
  ctx.route('post', '/import/preview', (req, res) => {
    const b = parse(req, res, S.ImportSchema); if (!b) return;
    if (!store.getAccount(b.account_id)) { res.status(404).json({ error: 'unknown account' }); return; }
    res.json(previewImport(store, b.account_id, b.content, b.filename, { flip_sign: b.flip_sign, has_header: b.has_header, columns: b.columns }));
  });
  ctx.route('post', '/import/commit', (req, res) => {
    const b = parse(req, res, S.ImportSchema); if (!b) return;
    if (!store.getAccount(b.account_id)) { res.status(404).json({ error: 'unknown account' }); return; }
    const r = commitImport(store, b.account_id, b.content, b.filename, { flip_sign: b.flip_sign, has_header: b.has_header, columns: b.columns });
    logger.info('imported', { account: b.account_id, ...r });
    res.status(201).json(r);
  });
  ctx.route('delete', '/imports/:id', (req, res) => { res.json({ removed: store.deleteImport(Number(param(req, 'id'))) }); });

}

export const financePlugin: Plugin = {
  manifest: {
    id: 'finance',
    name: 'Finance',
    version: '0.2.0',
    description: 'Your money in one place: accounts and net worth, a full transaction ledger with categories, rules and splits, budgets, recurring bills, cash flow and reports. Read-only bank aggregation plus file import; the data stays in your database.',
    icon: 'M12 2v20M17 6.5c0-1.9-2.2-3.5-5-3.5S7 4.6 7 6.5 9.2 10 12 10s5 1.6 5 3.5-2.2 3.5-5 3.5-5-1.6-5-3.5',
    nav: [
      { id: 'finance', label: 'Finance', tabs: [
        { id: 'finance-dashboard', label: 'Dashboard' },
        { id: 'finance-accounts', label: 'Accounts' },
        { id: 'finance-transactions', label: 'Transactions' },
        { id: 'finance-budgets', label: 'Budgets' },
        { id: 'finance-recurring', label: 'Recurring' },
        { id: 'finance-reports', label: 'Reports' },
        { id: 'finance-rules', label: 'Categories & Rules' },
        { id: 'finance-connections', label: 'Connections' },
      ] },
    ],
  },
  migrate,
  defineTools,
  register,
  assetsDir: fileURLToPath(new URL('./ui', import.meta.url)),
  agent: {
    name: 'Finance Assistant',
    description: 'Your money, answered from your own ledger: balances, net worth, cash flow, spending, subscriptions, budgets and goals.',
    model: 'claude-sonnet-4-6',
    system_prompt: [
      "You are the operator's personal finance assistant, backed by the Finance plugin: a ledger of their own accounts and transactions in their own database.",
      'You can SEE money but never move it, pay bills, or link banks — the operator does that in the Finance app. Never claim otherwise.',
      '',
      'Tools: net_worth, list_accounts, cash_flow(months), spending_report(from,to,by), transactions(query,category_id,account_id,from,to,uncategorized), recurring, budget_status(month), category_trend(category_id|group,months), goals, holdings.',
      'Every tool reports when its data was last synced; mention staleness only when it matters to the answer.',
      '',
      'Answer plainly with the numbers, rounded to whole dollars unless cents matter. When asked "where is my money going", lead with spending_report and cash_flow. When asked about a merchant or a charge, use transactions. When they ask what they pay for monthly, use recurring.',
      'Advise like a sharp friend who has read the whole ledger: point out what is unusual, what is over budget, and what the trend is. Be specific and cite the figures you used.',
    ].join('\n'),
  },
};

