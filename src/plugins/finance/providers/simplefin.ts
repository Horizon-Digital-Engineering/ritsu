/**
 * SimpleFIN Bridge: the operator pastes a one-time setup token, we claim it
 * for an access URL (kept in the SecretStore), and every sync is one GET of
 * accounts + transactions over a date window. Read-only by protocol; the
 * bridge refreshes from banks about once a day.
 */
import type { Provider, ProviderAccount, ProviderHolding, ProviderTransaction } from './types.js';
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
const num = (s: string | undefined | null): number | null => { if (s == null || s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };

/** How far back the first sync reaches; later syncs overlap the last one by two weeks. */
const INITIAL_DAYS = 400;
const OVERLAP_DAYS = 14;

export class SimpleFinError extends Error {
  constructor(message: string, readonly httpStatus: number) { super(message); this.name = 'SimpleFinError'; }
}

/** Exchange a setup token (base64 of the claim URL) for the access URL. */
export async function claimSetupToken(setupToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let claimUrl: string;
  try { claimUrl = Buffer.from(setupToken.trim(), 'base64').toString('utf8').trim(); }
  catch { throw new SimpleFinError('setup token is not valid base64', 400); }
  if (!/^https:\/\//.test(claimUrl)) throw new SimpleFinError('setup token does not decode to an https claim URL', 400);
  const res = await fetchImpl(claimUrl, { method: 'POST' });
  const body = (await res.text()).trim();
  if (!res.ok) throw new SimpleFinError(`claim failed (${res.status}): ${body.slice(0, 200)}`, res.status);
  if (!/^https:\/\/[^@/]+:[^@/]+@/.test(body)) throw new SimpleFinError('claim did not return an access URL', 502);
  return body;
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
        const today = new Date().toISOString().slice(0, 10);
        const since = conn.last_synced_at
          ? new Date(conn.last_synced_at * 1000 - OVERLAP_DAYS * 86_400_000).toISOString().slice(0, 10)
          : new Date(Date.now() - INITIAL_DAYS * 86_400_000).toISOString().slice(0, 10);
        const r = await this.fetchAccounts(since, today);
        if (r.errors?.length) throw new SimpleFinError(r.errors.join('; '), 502);
        const accounts: ProviderAccount[] = [], added: ProviderTransaction[] = [], holdings: ProviderHolding[] = [];
        for (const a of r.accounts ?? []) {
          const balance = num(a.balance) ?? 0;
          accounts.push({
            provider_account_id: a.id, name: a.name, type: guessAccountType(a.name, balance), institution: a.org?.name ?? a.org?.domain ?? '',
            balance, available_balance: num(a['available-balance']), currency: a.currency ?? 'USD', balance_as_of: day(a['balance-date']),
          });
          for (const t of a.transactions ?? []) {
            added.push({
              provider_transaction_id: t.id, provider_account_id: a.id, date: day(t.transacted_at ?? t.posted),
              description: t.description ?? '', payee: t.payee ?? '', amount: num(t.amount) ?? 0, currency: a.currency ?? 'USD',
              provider_categories: [], pending: !!t.pending,
            });
          }
          for (const h of a.holdings ?? []) {
            holdings.push({
              provider_holding_id: h.id, provider_account_id: a.id, symbol: h.symbol ?? '', description: h.description ?? '',
              quantity: num(h.shares), price: num(h.purchase_price), market_value: num(h.market_value), cost_basis: num(h.cost_basis),
              currency: h.currency ?? a.currency ?? 'USD', as_of: h.created ? day(h.created) : day(a['balance-date']),
            });
          }
        }
        return { accounts, added, modified: [], removed: [], holdings, cursor: null };
      },
    };
  }
}
