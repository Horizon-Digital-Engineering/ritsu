import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildSearchRequest, formatHits, searchConfigError, isSearchProvider, SEARCH_PROVIDERS,
} from '../tools/ritsu-agent/search.js';

const UA = 'test-agent';

describe('search providers', () => {
  it('rejects a provider that is missing its credential or endpoint', () => {
    assert.match(searchConfigError({ provider: 'searxng' })!, /instance URL/);
    assert.equal(searchConfigError({ provider: 'searxng', url: 'http://x:8080' }), null);
    assert.match(searchConfigError({ provider: 'brave' })!, /API key/);
    assert.equal(searchConfigError({ provider: 'brave', apiKey: 'k' }), null);
  });

  it('searxng asks for JSON and carries no credential', () => {
    const r = buildSearchRequest({ provider: 'searxng', url: 'http://s:8080/' }, 'rust ffi', 5, UA);
    assert.ok(r.url.startsWith('http://s:8080/search?'));
    assert.match(r.url, /format=json/);
    assert.match(r.url, /q=rust\+ffi/);
    assert.equal(JSON.stringify(r.init.headers).includes('Authorization'), false);
  });

  it('each hosted provider sends its key in the header it expects', () => {
    const brave = buildSearchRequest({ provider: 'brave', apiKey: 'bk' }, 'q', 3, UA);
    assert.equal((brave.init.headers as Record<string, string>)['X-Subscription-Token'], 'bk');

    const tavily = buildSearchRequest({ provider: 'tavily', apiKey: 'tk' }, 'q', 3, UA);
    assert.equal((tavily.init.headers as Record<string, string>).Authorization, 'Bearer tk');
    assert.equal(tavily.init.method, 'POST');

    const serper = buildSearchRequest({ provider: 'serper', apiKey: 'sk' }, 'q', 3, UA);
    assert.equal((serper.init.headers as Record<string, string>)['X-API-KEY'], 'sk');
  });

  it('every provider maps its own response shape to the same hits', () => {
    const bodies: Record<string, unknown> = {
      searxng: { results: [{ title: 'T', url: 'u', content: 'snip' }] },
      brave: { web: { results: [{ title: 'T', url: 'u', description: 'snip' }] } },
      tavily: { results: [{ title: 'T', url: 'u', content: 'snip' }] },
      serper: { organic: [{ title: 'T', link: 'u', snippet: 'snip' }] },
    };
    for (const p of SEARCH_PROVIDERS) {
      const cfg = p === 'searxng' ? { provider: p, url: 'http://s' } : { provider: p, apiKey: 'k' };
      const hits = buildSearchRequest(cfg, 'q', 5, UA).parse(bodies[p]);
      assert.deepEqual(hits, [{ title: 'T', url: 'u', snippet: 'snip' }], `provider ${p}`);
    }
  });

  it('a malformed provider response yields no hits instead of throwing', () => {
    for (const p of SEARCH_PROVIDERS) {
      const cfg = p === 'searxng' ? { provider: p, url: 'http://s' } : { provider: p, apiKey: 'k' };
      const req = buildSearchRequest(cfg, 'q', 5, UA);
      assert.deepEqual(req.parse(null), []);
      assert.deepEqual(req.parse({ unexpected: true }), []);
    }
  });

  it('formats hits identically regardless of backend', () => {
    assert.equal(formatHits([]), '(no results)');
    const out = formatHits([{ title: ' A  B ', url: 'http://u', snippet: 'x\ny' }]);
    assert.equal(out, '[1] A B — http://u\n    x y');
  });

  it('validates provider names', () => {
    assert.ok(isSearchProvider('brave'));
    assert.ok(!isSearchProvider('google'));
  });
});
