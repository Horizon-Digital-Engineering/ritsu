/**
 * What every bank-data provider hands the sync: accounts and transactions in
 * the ledger's sign convention (inflow positive, outflow negative, liability
 * balances negative). Each provider does its own normalization so sync never
 * has to know whose data it is holding.
 */
export interface ProviderAccount {
  provider_account_id: string;
  name: string;
  official_name?: string;
  type: string;
  subtype?: string;
  mask?: string;
  institution?: string;
  balance: number;
  available_balance?: number | null;
  currency?: string;
  balance_as_of: string;
}

export interface ProviderTransaction {
  provider_transaction_id: string;
  provider_account_id: string;
  date: string;
  description: string;
  payee?: string;
  amount: number;
  currency?: string;
  /** Provider's own category labels, most specific first. Empty when it has none. */
  provider_categories?: string[];
  pending?: boolean;
}

export interface ProviderHolding {
  provider_holding_id: string;
  provider_account_id: string;
  symbol: string;
  description: string;
  quantity: number | null;
  price: number | null;
  market_value: number | null;
  cost_basis: number | null;
  currency?: string;
  as_of: string;
}

export interface FetchResult {
  accounts: ProviderAccount[];
  added: ProviderTransaction[];
  modified: ProviderTransaction[];
  /** Provider transaction ids that no longer exist upstream. */
  removed: string[];
  holdings: ProviderHolding[];
  /** Opaque resume point for incremental providers; null for window-based ones. */
  cursor: string | null;
  /** Non-fatal notes from the provider (a capped window, one bank needing attention). */
  warnings?: string[];
}

export interface Provider {
  readonly name: string;
  fetch(conn: { id: string; cursor: string | null; last_synced_at: number | null }): Promise<FetchResult>;
}

/** Best guess at an account type from its name when the provider sends none. */
export function guessAccountType(name: string, balance: number): string {
  const s = name.toLowerCase();
  if (/credit|card|visa|mastercard|amex|discover|platinum|sapphire|freedom/.test(s)) return 'credit';
  if (/loan|mortgage|heloc|financing/.test(s)) return 'loan';
  if (/brokerage|401|403|ira\b|roth|invest|retire|hsa|529|stock|etf|fund/.test(s)) return 'investment';
  if (balance < 0) return 'credit';
  return 'depository';
}
