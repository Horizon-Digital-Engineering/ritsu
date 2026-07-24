import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { PlaidClient, PlaidError } from '../plugins/finance/plaid.js';

// A fetch double: returns a canned JSON body + status, and records the last
// request so we can assert on the path/body the client sent.
function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const recording = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }) as unknown as typeof fetch;
  return { fetch: recording, calls };
}

function client(fetchImpl: typeof fetch, env: 'sandbox' | 'production' = 'sandbox') {
  return new PlaidClient({ creds: { clientId: 'cid', secret: 'sek', env }, fetchImpl });
}

describe('PlaidClient', () => {
  it('posts credentials to the sandbox base and parses the response', async () => {
    const f = fakeFetch(200, { access_token: 'acc-1', item_id: 'item-1' });
    const r = await client(f.fetch).exchangePublicToken('public-xyz');
    assert.deepEqual(r, { access_token: 'acc-1', item_id: 'item-1' });
    assert.equal(f.calls[0].url, 'https://sandbox.plaid.com/item/public_token/exchange');
    assert.deepEqual(f.calls[0].body, { client_id: 'cid', secret: 'sek', public_token: 'public-xyz' });
  });

  it('uses the production base in production env', async () => {
    const f = fakeFetch(200, { accounts: [] });
    await client(f.fetch, 'production').getBalances('acc');
    assert.ok(f.calls[0].url.startsWith('https://production.plaid.com/'));
  });

  it('throws a typed PlaidError carrying the code + status on a non-2xx response', async () => {
    const f = fakeFetch(400, { error_code: 'INVALID_ACCESS_TOKEN', error_message: 'the token is bad' });
    await assert.rejects(
      () => client(f.fetch).getBalances('bad-token'),
      (e: unknown) => {
        assert.ok(e instanceof PlaidError);
        assert.equal(e.code, 'INVALID_ACCESS_TOKEN');
        assert.equal(e.message, 'the token is bad');
        assert.equal(e.httpStatus, 400);
        return true;
      },
    );
  });

  it('falls back to a generic code/message when the error body is not a string', async () => {
    // error_code is a non-string (object) — must not stringify to "[object Object]".
    const f = fakeFetch(500, { error_code: { nested: true } });
    await assert.rejects(
      () => client(f.fetch).syncTransactions('t'),
      (e: unknown) => {
        assert.ok(e instanceof PlaidError);
        assert.equal(e.code, 'PLAID_ERROR');
        assert.match(e.message, /Plaid \/transactions\/sync failed \(500\)/);
        return true;
      },
    );
  });

  it('syncTransactions forwards the cursor only when provided', async () => {
    const f = fakeFetch(200, { added: [], modified: [], removed: [], next_cursor: 'c2', has_more: false });
    await client(f.fetch).syncTransactions('tok', 'cursor-1');
    assert.equal((f.calls[0].body as { cursor?: string }).cursor, 'cursor-1');
    const f2 = fakeFetch(200, { added: [], modified: [], removed: [], next_cursor: '', has_more: false });
    await client(f2.fetch).syncTransactions('tok');
    assert.equal((f2.calls[0].body as { cursor?: string }).cursor, undefined);
  });

  it('getLinkResults digs the public_token out of nested link sessions', async () => {
    const f = fakeFetch(200, {
      link_sessions: [{ results: { item_add_results: [{ public_token: 'pub-from-session' }] } }],
    });
    assert.equal((await client(f.fetch).getLinkResults('lt')).public_token, 'pub-from-session');
  });

  it('getLinkResults returns null when no token is present yet', async () => {
    const f = fakeFetch(200, { link_sessions: [] });
    assert.equal((await client(f.fetch).getLinkResults('lt')).public_token, null);
  });

  it('getInstitution swallows lookup failures (best-effort cosmetic)', async () => {
    const f = fakeFetch(404, { error_code: 'INSTITUTION_NOT_FOUND' });
    assert.equal(await client(f.fetch).getInstitution('ins_x'), null);
  });

  it('createLinkToken returns the hosted-link url', async () => {
    const f = fakeFetch(200, { link_token: 'lt', hosted_link_url: 'https://link', expiration: 'soon' });
    const r = await client(f.fetch).createLinkToken({ userId: 'op' });
    assert.equal(r.hosted_link_url, 'https://link');
  });
});
