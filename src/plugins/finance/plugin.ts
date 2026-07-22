import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Request, Response } from 'express';
import type { Plugin, PluginContext, PluginToolContext, PluginSecrets } from '../types.js';
import { migrate } from './migrate.js';
import { FinanceStore } from './store.js';
import { PlaidClient, type PlaidEnv } from './plaid.js';
import { syncItem, type SyncResult } from './sync.js';
import {
  netWorth, spendByCategory, spendByMonth, topMerchants, detectSubscriptions, budgetStatus, inMonth,
} from './report.js';
import { ConfigSchema, ExchangeSchema, SandboxLinkSchema, TargetSchema } from './schema.js';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const money = (n: number | null, ccy = 'USD') => n == null ? '—' : `${ccy} ${n.toFixed(2)}`;
const currentMonth = () => new Date().toISOString().slice(0, 7);
const sinceDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

// ---- Plaid wiring from the plugin's secrets --------------------------------
function plaidFrom(secrets: PluginSecrets): PlaidClient | null {
  const clientId = secrets.get('plaid_client_id');
  const secret = secrets.get('plaid_secret');
  if (!clientId || !secret) return null;
  const env = (secrets.get('plaid_env') as PlaidEnv) || 'sandbox';
  return new PlaidClient({ creds: { clientId, secret, env } });
}

/** Exchange a public_token, persist the access token in the SecretStore, record
 *  the item, and do a first sync. Returns the item_id. */
async function linkPublicToken(store: FinanceStore, secrets: PluginSecrets, plaid: PlaidClient, publicToken: string, institutionName?: string): Promise<string> {
  const { access_token, item_id } = await plaid.exchangePublicToken(publicToken);
  secrets.set(`access_token:${item_id}`, access_token);
  store.upsertItem({ item_id, institution_name: institutionName });
  await syncItem(store, plaid, access_token, item_id);
  return item_id;
}

async function syncAll(store: FinanceStore, secrets: PluginSecrets, plaid: PlaidClient): Promise<Record<string, SyncResult | string>> {
  const out: Record<string, SyncResult | string> = {};
  for (const item of store.listItems()) {
    const token = secrets.get(`access_token:${item.item_id}`);
    if (!token) { out[item.item_id] = 'no access token'; continue; }
    try { out[item.item_id] = await syncItem(store, plaid, token, item.item_id); }
    catch (e) { store.setItemStatus(item.item_id, 'error', (e as Error).message); out[item.item_id] = `error: ${(e as Error).message}`; }
  }
  return out;
}

// ---- agent tools (READ-ONLY over the cache; fenced) ------------------------
function defineTools(ctx: PluginToolContext): void {
  const store = new FinanceStore(ctx.db);

  ctx.tool({
    name: 'net_worth',
    description: 'Current net worth: total assets minus liabilities (credit-card + loan balances), broken down by account type.',
    input: {},
    untrustedOutput: true,
    handler: () => {
      const nw = netWorth(store.listAccounts());
      if (nw.byType.length === 0) return text('(no accounts linked yet)');
      const lines = nw.byType.map(t => `  ${t.type}: ${money(t.total, nw.currency)} (${t.accounts} acct)`).join('\n');
      return text(`Net worth: ${money(nw.net, nw.currency)}\n  assets: ${money(nw.assets, nw.currency)}\n  liabilities: ${money(nw.liabilities, nw.currency)}\nBy type:\n${lines}`);
    },
  });

  ctx.tool({
    name: 'list_accounts',
    description: 'List every linked account with its current balance, type, and institution masking.',
    input: {},
    untrustedOutput: true,
    handler: () => {
      const accts = store.listAccounts();
      if (!accts.length) return text('(no accounts linked yet)');
      return text(accts.map(a => `${a.name}${a.mask ? ` ••${a.mask}` : ''} [${a.type}/${a.subtype}] — ${money(a.current_balance, a.iso_currency)}`).join('\n'));
    },
  });

  ctx.tool({
    name: 'spending_report',
    description: 'Spending by category over the last N days (default 30). Only outflows (spend), not income.',
    input: { days: z.number().int().min(1).max(3650).optional().describe('lookback window in days, default 30') },
    untrustedOutput: true,
    handler: (args) => {
      const days = typeof args.days === 'number' ? args.days : 30;
      const rows = spendByCategory(store.transactionsSince(sinceDaysAgo(days)));
      if (!rows.length) return text(`(no spending in the last ${days} days)`);
      const total = rows.reduce((s, r) => s + r.total, 0);
      return text(`Spending, last ${days} days (total ${money(total)}):\n` +
        rows.map(r => `  ${r.category}: ${money(r.total)} (${r.count})`).join('\n'));
    },
  });

  ctx.tool({
    name: 'subscriptions',
    description: 'Recurring charges detected over the last ~4 months (likely subscriptions), with cadence and average amount.',
    input: {},
    untrustedOutput: true,
    handler: () => {
      const subs = detectSubscriptions(store.transactionsSince(sinceDaysAgo(130)));
      if (!subs.length) return text('(no recurring charges detected)');
      return text('Likely subscriptions:\n' + subs.map(s => `  ${s.merchant}: ${money(s.avgAmount)} ${s.cadence} (${s.occurrences}×, last ${s.lastDate})`).join('\n'));
    },
  });

  ctx.tool({
    name: 'search_transactions',
    description: 'Search transactions by merchant or description text; newest first.',
    input: {
      query: z.string().min(1).max(100).describe('text to match in the merchant or description'),
      limit: z.number().int().min(1).max(200).optional().describe('max results, default 50'),
    },
    untrustedOutput: true,
    handler: (args) => {
      const rows = store.searchTransactions(String(args.query), typeof args.limit === 'number' ? args.limit : 50);
      if (!rows.length) return text('(no matching transactions)');
      return text(rows.map(t => `${t.date} ${t.merchant_name || t.name}: ${money(t.amount, t.iso_currency)}${t.pending ? ' (pending)' : ''}`).join('\n'));
    },
  });

  ctx.tool({
    name: 'budget_status',
    description: "This month's spending against your per-category monthly targets, flagging any you've gone over.",
    input: {},
    untrustedOutput: true,
    handler: () => {
      const targets = store.listTargets();
      if (!targets.length) return text('(no category targets set)');
      const month = currentMonth();
      const lines = budgetStatus(spendByCategory(inMonth(store.transactionsSince(`${month}-01`), month)), targets);
      return text(`Budget status for ${month}:\n` + lines.map(l =>
        `  ${l.category}: ${money(l.spent)} / ${money(l.limit)} — ${l.over ? `OVER by ${money(-l.remaining)}` : `${money(l.remaining)} left`}`).join('\n'));
    },
  });
}

// ---- admin routes ----------------------------------------------------------
function parse<T>(req: Request, res: Response, schema: z.ZodType<T>): T | null {
  const r = schema.safeParse(req.body);
  if (!r.success) { res.status(400).json({ error: 'invalid request body', issues: z.treeifyError(r.error) }); return null; }
  return r.data;
}

function register(ctx: PluginContext): void {
  const store = new FinanceStore(ctx.db);
  const { secrets, logger } = ctx;
  const requirePlaid = (res: Response): PlaidClient | null => {
    const p = plaidFrom(secrets);
    if (!p) { res.status(409).json({ error: 'Plaid is not configured — set credentials first' }); return null; }
    return p;
  };

  // Status: what's configured + linked. NEVER returns secret values.
  ctx.route('get', '/status', (_req, res) => {
    res.json({
      configured: secrets.has('plaid_client_id') && secrets.has('plaid_secret'),
      env: secrets.get('plaid_env') || 'sandbox',
      items: store.listItems().map(i => ({ item_id: i.item_id, institution_name: i.institution_name, status: i.status, error: i.error })),
    });
  });

  ctx.route('post', '/config', (req, res) => {
    const b = parse(req, res, ConfigSchema);
    if (!b) return;
    secrets.set('plaid_client_id', b.client_id);
    secrets.set('plaid_secret', b.secret);
    secrets.set('plaid_env', b.env);
    logger.info('config-set', { env: b.env });
    res.json({ configured: true, env: b.env });
  });

  ctx.route('get', '/accounts', (_req, res) => {
    const accounts = store.listAccounts();
    res.json({ accounts, netWorth: netWorth(accounts) });
  });

  ctx.route('get', '/report', (req, res) => {
    const days = Math.min(3650, Math.max(1, Number(req.query.days) || 90));
    const since = sinceDaysAgo(days);
    const txns = store.transactionsSince(since);
    const month = currentMonth();
    res.json({
      since, days,
      byCategory: spendByCategory(txns),
      byMonth: spendByMonth(txns),
      topMerchants: topMerchants(txns, 10),
      subscriptions: detectSubscriptions(store.transactionsSince(sinceDaysAgo(Math.max(days, 130)))),
      budgets: budgetStatus(spendByCategory(inMonth(txns, month)), store.listTargets()),
    });
  });

  // --- linking ---
  ctx.route('post', '/link/sandbox', async (req, res) => {
    const plaid = requirePlaid(res); if (!plaid) return;
    const b = parse(req, res, SandboxLinkSchema); if (!b) return;
    try {
      const inst = b.institution_id || 'ins_109508';
      const { public_token } = await plaid.sandboxPublicToken(inst);
      const name = (await plaid.getInstitution(inst))?.name;
      const itemId = await linkPublicToken(store, secrets, plaid, public_token, name);
      res.json({ linked: true, item_id: itemId });
    } catch (e) { res.status(502).json({ error: (e as Error).message }); }
  });

  ctx.route('post', '/link/start', async (_req, res) => {
    const plaid = requirePlaid(res); if (!plaid) return;
    try {
      const r = await plaid.createLinkToken({ userId: 'operator' });
      secrets.set('pending_link_token', r.link_token);
      res.json({ hosted_link_url: r.hosted_link_url ?? null, expiration: r.expiration });
    } catch (e) { res.status(502).json({ error: (e as Error).message }); }
  });

  ctx.route('post', '/link/complete', async (_req, res) => {
    const plaid = requirePlaid(res); if (!plaid) return;
    const linkToken = secrets.get('pending_link_token');
    if (!linkToken) { res.status(409).json({ error: 'no pending link session — start one first' }); return; }
    try {
      const { public_token } = await plaid.getLinkResults(linkToken);
      if (!public_token) { res.json({ linked: false, pending: true }); return; }
      const itemId = await linkPublicToken(store, secrets, plaid, public_token);
      secrets.delete('pending_link_token');
      res.json({ linked: true, item_id: itemId });
    } catch (e) { res.status(502).json({ error: (e as Error).message }); }
  });

  ctx.route('post', '/link/exchange', async (req, res) => {
    const plaid = requirePlaid(res); if (!plaid) return;
    const b = parse(req, res, ExchangeSchema); if (!b) return;
    try { res.json({ linked: true, item_id: await linkPublicToken(store, secrets, plaid, b.public_token) }); }
    catch (e) { res.status(502).json({ error: (e as Error).message }); }
  });

  ctx.route('post', '/sync', async (_req, res) => {
    const plaid = requirePlaid(res); if (!plaid) return;
    res.json({ results: await syncAll(store, secrets, plaid) });
  });

  ctx.route('delete', '/items/:itemId', (req, res) => {
    const itemId = String(req.params.itemId);
    store.deleteItem(itemId);
    secrets.delete(`access_token:${itemId}`);
    logger.info('item-unlinked', { item_id: itemId });
    res.status(204).end();
  });

  // --- targets (light budgets) ---
  ctx.route('post', '/targets', (req, res) => {
    const b = parse(req, res, TargetSchema); if (!b) return;
    store.setTarget(b.category, b.monthly_limit);
    res.status(201).json({ category: b.category, monthly_limit: b.monthly_limit });
  });

  ctx.route('delete', '/targets/:category', (req, res) => {
    res.status(store.deleteTarget(String(req.params.category)) ? 204 : 404).end();
  });
}

export const financePlugin: Plugin = {
  manifest: {
    id: 'finance',
    name: 'Finance',
    version: '0.1.0',
    description: 'Read-only personal finance: all accounts on one page + spend reporting, via Plaid bank aggregation.',
    nav: [
      { id: 'finance', label: 'Finance', tabs: [
        { id: 'finance-accounts', label: 'Accounts' },
        { id: 'finance-reporting', label: 'Reporting' },
      ] },
    ],
  },
  migrate,
  defineTools,
  register,
  assetsDir: fileURLToPath(new URL('./ui', import.meta.url)),
  agent: {
    name: 'Finance Assistant',
    description: 'Read-only money assistant — balances, net worth, spending, subscriptions, and budgets.',
    model: 'claude-sonnet-4-6',
    system_prompt: [
      "You are the operator's personal finance assistant, backed by the Finance plugin.",
      'It is READ-ONLY bank aggregation: you can SEE money but never move it, pay bills, or link banks — that is the operator, in the admin UI. Never claim otherwise.',
      '',
      'Your tools:',
      '- net_worth — assets minus credit/loan liabilities. list_accounts — every balance.',
      '- spending_report(days) — spend by category. top categories answer "where is my money going".',
      '- subscriptions — recurring charges; answers "what am I paying for".',
      '- search_transactions(query) — find specific charges. budget_status — this month vs your category targets.',
      '',
      'Answer plainly with the numbers. Round to whole dollars unless they ask for cents.',
    ].join('\n'),
  },
};
