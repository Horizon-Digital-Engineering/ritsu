/**
 * Minimal READ-ONLY Plaid REST client. Only the aggregation endpoints the
 * finance plugin needs — no payment/transfer surface exists here at all.
 *
 * Auth is client_id + secret in the JSON body (Plaid's scheme). Credentials
 * and access tokens are passed in per call from the SecretStore; this module
 * never persists or logs them. `fetchImpl` is injectable for tests.
 */
export type PlaidEnv = 'sandbox' | 'production';

export interface PlaidCreds { clientId: string; secret: string; env: PlaidEnv }

export interface PlaidClientOpts {
  creds: PlaidCreds;
  fetchImpl?: typeof fetch;
}

export class PlaidError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus: number) {
    super(message);
    this.name = 'PlaidError';
  }
}

// ---- response DTOs (only the fields we consume) ---------------------------
export interface PlaidBalances { current: number | null; available: number | null; iso_currency_code: string | null }
export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  balances: PlaidBalances;
}
export interface PlaidPFC { primary: string; detailed: string }
export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  date: string;
  name: string;
  merchant_name: string | null;
  amount: number;
  iso_currency_code: string | null;
  personal_finance_category: PlaidPFC | null;
  category: string[] | null;
  pending: boolean;
}
export interface SyncResponse {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: Array<{ transaction_id: string }>;
  next_cursor: string;
  has_more: boolean;
}
export interface LinkTokenResponse { link_token: string; hosted_link_url?: string; expiration: string }
export interface ExchangeResponse { access_token: string; item_id: string }

export class PlaidClient {
  constructor(private readonly opts: PlaidClientOpts) {}

  private base(): string {
    return this.opts.creds.env === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com';
  }

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const res = await doFetch(this.base() + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.opts.creds.clientId, secret: this.opts.creds.secret, ...body }),
    });
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      throw new PlaidError(
        String(json.error_code ?? 'PLAID_ERROR'),
        String(json.error_message ?? json.display_message ?? `Plaid ${path} failed (${res.status})`),
        res.status,
      );
    }
    return json as T;
  }

  /** Create a Hosted Link token — the operator opens hosted_link_url, links a
   *  bank on Plaid's page, and Plaid returns a public_token (via redirect or
   *  webhook) to exchange. Hosted Link avoids embedding Plaid's CDN JS. */
  createLinkToken(opts: { userId: string; clientName?: string; webhook?: string; redirectUri?: string }): Promise<LinkTokenResponse> {
    return this.call<LinkTokenResponse>('/link/token/create', {
      user: { client_user_id: opts.userId },
      client_name: opts.clientName ?? 'Ritsu Finance',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
      hosted_link: {},
      ...(opts.webhook ? { webhook: opts.webhook } : {}),
      ...(opts.redirectUri ? { redirect_uri: opts.redirectUri } : {}),
    });
  }

  exchangePublicToken(publicToken: string): Promise<ExchangeResponse> {
    return this.call<ExchangeResponse>('/item/public_token/exchange', { public_token: publicToken });
  }

  async getBalances(accessToken: string): Promise<PlaidAccount[]> {
    const r = await this.call<{ accounts: PlaidAccount[] }>('/accounts/balance/get', { access_token: accessToken });
    return r.accounts;
  }

  syncTransactions(accessToken: string, cursor?: string): Promise<SyncResponse> {
    return this.call<SyncResponse>('/transactions/sync', {
      access_token: accessToken,
      ...(cursor ? { cursor } : {}),
      count: 500,
    });
  }

  async getInstitution(institutionId: string): Promise<{ name: string } | null> {
    try {
      const r = await this.call<{ institution: { name: string } }>('/institutions/get_by_id', {
        institution_id: institutionId,
        country_codes: ['US'],
      });
      return { name: r.institution.name };
    } catch {
      return null;  // institution lookup is best-effort cosmetic
    }
  }
}
