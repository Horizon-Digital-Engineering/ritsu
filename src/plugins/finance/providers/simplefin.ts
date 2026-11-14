/**
 * SimpleFIN Bridge: the operator pastes a one-time setup token, we claim it
 * for an access URL (kept in the SecretStore), and every sync is one GET of
 * accounts + transactions over a date window. Read-only by protocol; the
 * bridge refreshes from banks about once a day.
 */
import type { FetchResult, Provider, ProviderAccount, ProviderHolding, ProviderTransaction } from './types.js';
import { guessAccountType } from './types.js';

interface SfOrg { domain?: string; name?: string; url?: string; id?: string }
interface SfTxn { id: string; posted: number; amount: string; description?: string; payee?: string; memo?: string; pending?: boolean; transacted_at?: number }
interface SfHolding { id: string; created?: number; currency?: string; cost_basis?: string; description?: string; market_value?: string; purchase_price?: string; shares?: string; symbol?: string }
interface SfAccount {
  org?: SfOrg; id: string; name: string; currency?: string; balance: string; 'available-balance'?: string;
  'balance-date': number; transactions?: SfTxn[]; holdings?: SfHolding[];
}
interface SfResponse { errors?: string[]; accounts?: SfAccount[] }

const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
const num = (s: string | undefined | null): number | null => {
  if (s == null || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** The bridge serves at most 90 days per request, so the first sync walks back
 *  in windows; later syncs re-read a two-week overlap. */
const WINDOW_DAYS = 90;
const INITIAL_WINDOWS = 4;
const OVERLAP_DAYS = 14;
const dayStr = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class SimpleFinError extends Error {
  constructor(message: string, readonly httpStatus: number) { super(message); this.name = 'SimpleFinError'; }
}

/** Exchange a setup token (base64 of the claim URL) for the access URL. */
export async function claimSetupToken(setupToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let claimUrl: string;
  try { claimUrl = Buffer.from(setupToken.trim(), 'base64').toString('utf8').trim(); }
  catch { throw new SimpleFinError('setup token is not valid base64', 400); }
  if (!claimUrl.startsWith('https://')) throw new SimpleFinError('setup token does not decode to an https claim URL', 400);
  const res = await fetchImpl(claimUrl, { method: 'POST' });
  const body = (await res.text()).trim();
  if (!res.ok) throw new SimpleFinError(`claim failed (${res.status}): ${body.slice(0, 200)}`, res.status);
  if (!isAccessUrl(body)) throw new SimpleFinError('claim did not return an access URL', 502);
  return body;
}

/** `https://user:pass@host...`: credentials before the first `/`, with a colon strictly inside them. */
function isAccessUrl(url: string): boolean {
  if (!url.startsWith('https://')) return false;
  const at = url.indexOf('@', 8);
  if (at < 0) return false;
  const creds = url.slice(8, at);
  if (creds.includes('/')) return false;
  const colon = creds.indexOf(':', 1);
  return colon > 0 && colon < creds.length - 1;
}

export class SimpleFinClient {
  constructor(private readonly accessUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async fetchAccounts(startDate: string, endDate: string): Promise<SfResponse> {
    const u = new URL(this.accessUrl);
    const auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
    u.username = ''; u.password = '';
    u.pathname = u.pathname.replace(/\/$/, '') + '/accounts';
    u.searchParams.set('start-date', String(Math.floor(Date.parse(startDate) / 1000)));
    u.searchParams.set('end-date', String(Math.floor(Date.parse(endDate) / 1000) + 86_400));
    u.searchParams.set('pending', '1');
    const res = await this.fetchImpl(u.toString(), { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) throw new SimpleFinError(`accounts fetch failed (${res.status})`, res.status);
    return (await res.json()) as SfResponse;
  }

  provider(): Provider {
    return {
      name: 'simplefin',
      fetch: async (conn) => {
        const merged = new Merge();
        // Sequential on purpose: newest window first so balances and holdings come
        // from the freshest response, and the bridge rate-limits concurrent reads.
        for (const [from, to] of planWindows(conn.last_synced_at, Date.now())) {
          merged.add(await this.fetchAccounts(from, to));
        }
        return merged.result();
      },
    };
  }
}

/** The first sync walks back INITIAL_WINDOWS windows; later syncs re-read a short overlap. */
function planWindows(lastSyncedAt: number | null | undefined, now: number): Array<[string, string]> {
  if (lastSyncedAt) return [[dayStr(lastSyncedAt * 1000 - OVERLAP_DAYS * 86_400_000), dayStr(now)]];
  return Array.from({ length: INITIAL_WINDOWS }, (_, i) => [dayStr(now - (i + 1) * WINDOW_DAYS * 86_400_000), dayStr(now - i * WINDOW_DAYS * 86_400_000)]);
}

function toAccount(a: SfAccount): ProviderAccount {
  const balance = num(a.balance) ?? 0;
  return {
    provider_account_id: a.id, name: a.name, type: guessAccountType(a.name, balance), institution: a.org?.name ?? a.org?.domain ?? '',
    balance, available_balance: num(a['available-balance']), currency: a.currency ?? 'USD', balance_as_of: day(a['balance-date']),
  };
}

function toHolding(a: SfAccount, h: SfHolding): ProviderHolding {
  return {
    provider_holding_id: h.id, provider_account_id: a.id, symbol: h.symbol ?? '', description: h.description ?? '',
    quantity: num(h.shares), price: num(h.purchase_price), market_value: num(h.market_value), cost_basis: num(h.cost_basis),
    currency: h.currency ?? a.currency ?? 'USD', as_of: h.created ? day(h.created) : day(a['balance-date']),
  };
}

function toTransaction(a: SfAccount, t: SfTxn): ProviderTransaction {
  return {
    provider_transaction_id: t.id, provider_account_id: a.id, date: day(t.transacted_at ?? t.posted),
    description: t.description ?? '', payee: t.payee ?? '', amount: num(t.amount) ?? 0, currency: a.currency ?? 'USD',
    provider_categories: [], pending: !!t.pending,
  };
}

/** Folds window responses together: first sighting of an account or transaction wins. */
class Merge {
  private readonly accounts = new Map<string, ProviderAccount>();
  private readonly added = new Map<string, ProviderTransaction>();
  private readonly holdings: ProviderHolding[] = [];
  private readonly warnings: string[] = [];
  private sawAccounts = false;

  add(r: SfResponse): void {
    // The bridge reports a capped range or one bank needing attention in
    // `errors` while still returning everything else; that is a note, not a failure.
    for (const e of r.errors ?? []) if (!this.warnings.includes(e)) this.warnings.push(e);
    if (!r.accounts?.length) return;
    this.sawAccounts = true;
    for (const a of r.accounts) this.addAccount(a);
  }

  private addAccount(a: SfAccount): void {
    if (!this.accounts.has(a.id)) {
      this.accounts.set(a.id, toAccount(a));
      for (const h of a.holdings ?? []) this.holdings.push(toHolding(a, h));
    }
    for (const t of a.transactions ?? []) {
      if (!this.added.has(t.id)) this.added.set(t.id, toTransaction(a, t));
    }
  }

  result(): FetchResult {
    if (!this.sawAccounts && this.warnings.length) throw new SimpleFinError(this.warnings.join('; '), 502);
    return { accounts: [...this.accounts.values()], added: [...this.added.values()], modified: [], removed: [], holdings: this.holdings, cursor: null, warnings: this.warnings };
  }
}
