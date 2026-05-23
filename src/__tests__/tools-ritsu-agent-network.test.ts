import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildNetworkTools } from '../tools/ritsu-agent/network.js';
import type { RaTool } from '../model/ritsu-agent/types.js';

function findTool(tools: RaTool[], name: string): RaTool {
  const t = tools.find(x => x.name === name);
  if (!t) throw new Error(`tool ${name} not in list`);
  return t;
}

/** Build a stub fetch that returns specific responses for specific URLs. */
function stubFetch(routes: Record<string, { status?: number; body: string; contentType?: string }>): typeof fetch {
  return (async (url: unknown, _init?: unknown) => {
    const u = typeof url === 'string' ? url : (url as URL).toString();
    const route = Object.entries(routes).find(([prefix]) => u.startsWith(prefix));
    if (!route) throw new Error(`stub fetch: no route for ${u}`);
    const r = route[1];
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      statusText: r.status === 200 ? 'OK' : 'ERR',
      headers: new Headers({ 'content-type': r.contentType ?? 'text/plain' }),
      text: async () => r.body,
      json: async () => JSON.parse(r.body) as unknown,
      body: {
        getReader: () => {
          let sent = false;
          return {
            read: async () => sent
              ? { done: true, value: undefined }
              : (sent = true, { done: false, value: new TextEncoder().encode(r.body) }),
            cancel: async () => undefined,
          };
        },
      },
    } as unknown as Response;
  });
}

describe('ritsu-agent network tools', () => {
  describe('WebFetch', () => {
    it('GETs a URL and returns body with content-type tag', async () => {
      const tools = buildNetworkTools({
        fetchImpl: stubFetch({ 'https://example.com': { body: 'hello world', contentType: 'text/html' } }),
      });
      const WebFetch = findTool(tools, 'WebFetch');
      const out = await WebFetch.handler({ url: 'https://example.com/' });
      assert.ok((out).includes('[text/html]'));
      assert.ok((out).includes('hello world'));
    });

    it('rejects non-http(s) schemes', async () => {
      const tools = buildNetworkTools({ fetchImpl: stubFetch({}) });
      const WebFetch = findTool(tools, 'WebFetch');
      const out = await WebFetch.handler({ url: 'file:///etc/passwd' });
      assert.match(out, /only http\(s\)/);
    });

    it('surfaces non-2xx HTTP errors', async () => {
      const tools = buildNetworkTools({
        fetchImpl: stubFetch({ 'https://example.com': { status: 404, body: '' } }),
      });
      const WebFetch = findTool(tools, 'WebFetch');
      const out = await WebFetch.handler({ url: 'https://example.com/missing' });
      assert.match(out, /HTTP 404/);
    });

    it('errors clearly when url missing', async () => {
      const tools = buildNetworkTools({ fetchImpl: stubFetch({}) });
      const WebFetch = findTool(tools, 'WebFetch');
      const out = await WebFetch.handler({ url: '' });
      assert.match(out, /url required/);
    });
  });

  describe('WebSearch (searxng)', () => {
    it('queries the configured searxng URL and formats results', async () => {
      const searxngBody = JSON.stringify({
        query: 'ritsu',
        results: [
          { title: 'Ritsu Project', url: 'https://example.com/ritsu', content: 'Multi-agent MCP server.' },
          { title: 'Another',      url: 'https://example.org/abc',   content: 'unrelated' },
        ],
      });
      const tools = buildNetworkTools({
        searxng_url: 'http://search.local',
        fetchImpl: stubFetch({ 'http://search.local/search': { body: searxngBody, contentType: 'application/json' } }),
      });
      const WebSearch = findTool(tools, 'WebSearch');
      const out = await WebSearch.handler({ query: 'ritsu' });
      assert.match(out, /\[1\] Ritsu Project — https:\/\/example\.com\/ritsu/);
      assert.ok((out).includes('Multi-agent MCP server.'));
      assert.match(out, /\[2\] Another/);
    });

    it('honors `limit`', async () => {
      const searxngBody = JSON.stringify({
        results: Array.from({ length: 5 }, (_, i) => ({ title: `t${i}`, url: `https://x/${i}`, content: '' })),
      });
      const tools = buildNetworkTools({
        searxng_url: 'http://search.local',
        fetchImpl: stubFetch({ 'http://search.local/search': { body: searxngBody, contentType: 'application/json' } }),
      });
      const WebSearch = findTool(tools, 'WebSearch');
      const out = await WebSearch.handler({ query: 'x', limit: 2 });
      assert.ok((out).includes('[1] t0'));
      assert.ok((out).includes('[2] t1'));
      assert.ok(!(out).includes('[3]'));
    });

    it('reports no results gracefully', async () => {
      const tools = buildNetworkTools({
        searxng_url: 'http://search.local',
        fetchImpl: stubFetch({ 'http://search.local/search': { body: '{"results":[]}', contentType: 'application/json' } }),
      });
      const WebSearch = findTool(tools, 'WebSearch');
      const out = await WebSearch.handler({ query: 'nothing' });
      assert.equal(out, '(no results)');
    });

    it('surfaces upstream errors', async () => {
      const tools = buildNetworkTools({
        searxng_url: 'http://search.local',
        fetchImpl: stubFetch({ 'http://search.local/search': { status: 502, body: '' } }),
      });
      const WebSearch = findTool(tools, 'WebSearch');
      const out = await WebSearch.handler({ query: 'x' });
      assert.match(out, /searxng HTTP 502/);
    });
  });
});
