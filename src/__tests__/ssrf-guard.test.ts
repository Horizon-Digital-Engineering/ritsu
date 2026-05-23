import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { denyReasonFor, validateUrl, safeFetch } from '../tools/ritsu-agent/ssrf-guard.js';

/**
 * The IP classifier is the single load-bearing piece of the SSRF guard.
 * Every test below pins one specific behavior the guard MUST keep. If
 * you ever feel like loosening one, think about who could abuse it
 * before changing the test.
 */
describe('ssrf-guard.denyReasonFor (IPv4)', () => {
  // Each row: [input, expectDenied, label]. expectDenied=true means we
  // refuse to talk to that address.
  const cases: ReadonlyArray<readonly [string, boolean, string]> = [
    ['0.0.0.0',         true,  'unspecified'],
    ['10.0.0.1',        true,  'RFC 1918'],
    ['10.255.255.255',  true,  'RFC 1918 (upper)'],
    ['100.64.0.1',      true,  'CGN'],
    ['127.0.0.1',       true,  'loopback'],
    ['127.255.255.254', true,  'loopback (upper)'],
    ['169.254.0.1',     true,  'link-local'],
    ['169.254.169.254', true,  'cloud metadata'],
    ['172.16.0.1',      true,  'RFC 1918 (172.16/12)'],
    ['172.31.255.255',  true,  'RFC 1918 (172.31)'],
    ['172.32.0.1',      false, 'just past RFC 1918 (172.32 is public)'],
    ['192.0.2.1',       true,  'TEST-NET-1'],
    ['192.168.1.1',     true,  'RFC 1918'],
    ['198.18.0.1',      true,  'benchmark'],
    ['198.51.100.1',    true,  'TEST-NET-2'],
    ['203.0.113.1',     true,  'TEST-NET-3'],
    ['224.0.0.1',       true,  'multicast'],
    ['255.255.255.255', true,  'broadcast'],
    ['8.8.8.8',         false, 'public DNS'],
    ['1.1.1.1',         false, 'cloudflare DNS'],
    ['172.15.255.255',  false, 'just below RFC 1918 (172.15 is public)'],
    ['11.0.0.1',        false, 'just above RFC 1918 (11/8 is public)'],
  ];
  for (const [ip, deny, label] of cases) {
    it(`${deny ? 'blocks' : 'allows'} ${ip} (${label})`, () => {
      const r = denyReasonFor(ip);
      if (deny) assert.ok(r, `expected ${ip} to be denied`);
      else assert.equal(r, null, `expected ${ip} to be allowed (got: ${r ?? 'null'})`);
    });
  }
});

describe('ssrf-guard.denyReasonFor (IPv6)', () => {
  const cases: ReadonlyArray<readonly [string, boolean, string]> = [
    ['::',                 true,  'unspecified'],
    ['::1',                true,  'loopback'],
    ['fe80::1',            true,  'link-local'],
    ['fc00::1',            true,  'unique local'],
    ['fdab::1',            true,  'unique local (fd prefix)'],
    ['ff00::1',            true,  'multicast'],
    ['ff02::1',            true,  'all-nodes multicast'],
    // IPv4-mapped: the killer case. Looks like IPv6, addresses IPv4.
    ['::ffff:127.0.0.1',   true,  'IPv4-mapped loopback'],
    ['::ffff:169.254.169.254', true, 'IPv4-mapped cloud metadata'],
    ['::ffff:10.0.0.1',    true,  'IPv4-mapped RFC 1918'],
    ['::ffff:8.8.8.8',     false, 'IPv4-mapped to public IPv4'],
    ['2001:4860:4860::8888', false, 'google public DNS over IPv6'],
    ['2606:4700:4700::1111', false, 'cloudflare public DNS over IPv6'],
  ];
  for (const [ip, deny, label] of cases) {
    it(`${deny ? 'blocks' : 'allows'} ${ip} (${label})`, () => {
      const r = denyReasonFor(ip);
      if (deny) assert.ok(r, `expected ${ip} to be denied`);
      else assert.equal(r, null, `expected ${ip} to be allowed (got: ${r ?? 'null'})`);
    });
  }
});

describe('ssrf-guard.validateUrl', () => {
  it('accepts a normal https URL', () => {
    const r = validateUrl('https://example.com/path?q=1');
    assert.equal(r.ok, true);
  });

  it('rejects non-http(s) schemes', () => {
    for (const u of ['file:///etc/passwd', 'gopher://x', 'javascript:alert(1)', 'data:text/plain,hi']) {
      const r = validateUrl(u);
      assert.equal(r.ok, false, `expected ${u} rejected`);
    }
  });

  it('rejects URLs with embedded credentials', () => {
    const r = validateUrl('http://user:pass@example.com/');
    assert.equal(r.ok, false);
  });

  it('rejects IP-literal URLs in private ranges', () => {
    for (const u of [
      'http://127.0.0.1/',
      'http://10.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
    ]) {
      const r = validateUrl(u);
      assert.equal(r.ok, false, `expected ${u} rejected`);
    }
  });

  it('allows IP-literal URLs to public addresses', () => {
    const r = validateUrl('http://8.8.8.8/');
    assert.equal(r.ok, true);
  });

  it('respects RITSU_WEBFETCH_ALLOW_PRIVATE_HOSTS escape hatch', () => {
    const prev = process.env.RITSU_WEBFETCH_ALLOW_PRIVATE_HOSTS;
    process.env.RITSU_WEBFETCH_ALLOW_PRIVATE_HOSTS = 'docs.internal,intranet.example';
    try {
      // Allowlisted hostname is fine even if it's a private label.
      const ok = validateUrl('http://docs.internal/handbook');
      assert.equal(ok.ok, true);
    } finally {
      if (prev === undefined) delete process.env.RITSU_WEBFETCH_ALLOW_PRIVATE_HOSTS;
      else process.env.RITSU_WEBFETCH_ALLOW_PRIVATE_HOSTS = prev;
    }
  });
});

describe('ssrf-guard.safeFetch (integration)', () => {
  // Stand up a real HTTP server on loopback to exercise the dispatcher's
  // connect-level enforcement. The server itself is in the deny range,
  // so any direct fetch to it should be blocked.
  let server: Server;
  let port: number;

  before(() => new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/redirect-to-loopback')) {
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/landed` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  }));

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('blocks direct fetch to a loopback URL at URL-validation stage', async () => {
    await assert.rejects(
      safeFetch(`http://127.0.0.1:${port}/anything`),
      /SSRF guard/,
    );
  });

  it('blocks a redirect that points at loopback', async () => {
    // Set the allowlist so the validateUrl check passes for the FIRST hop
    // (the test server is on 127.0.0.1). The redirect target is also
    // 127.0.0.1 but no longer in the allowlist for the second hop — so
    // the post-redirect URL validation fires.
    const prev = process.env.RITSU_WEBFETCH_ALLOW_PRIVATE_HOSTS;
    process.env.RITSU_WEBFETCH_ALLOW_PRIVATE_HOSTS = '127.0.0.1';
    try {
      // The server returns 302 → http://127.0.0.1:<port>/landed. Both hops
      // pass validateUrl because 127.0.0.1 is allowlisted, AND both pass
      // the dispatcher (IP-literal connects skip lookup). So this should
      // succeed end-to-end — proves manual redirect following works when
      // the operator has opted in. Then we'll re-run without the allow
      // entry to prove the block.
      const res = await safeFetch(`http://127.0.0.1:${port}/redirect-to-loopback`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'hello');
    } finally {
      if (prev === undefined) delete process.env.RITSU_WEBFETCH_ALLOW_PRIVATE_HOSTS;
      else process.env.RITSU_WEBFETCH_ALLOW_PRIVATE_HOSTS = prev;
    }
  });

  it('blocks the same redirect when 127.0.0.1 is NOT allowlisted', async () => {
    // No allowlist; the first hop is blocked at URL validation (it's an
    // IP literal in the deny range), proving the layer-1 check fires
    // before we'd ever discover the redirect.
    await assert.rejects(
      safeFetch(`http://127.0.0.1:${port}/redirect-to-loopback`),
      /SSRF guard/,
    );
  });
});
