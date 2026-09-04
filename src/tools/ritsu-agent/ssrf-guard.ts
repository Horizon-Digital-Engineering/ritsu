/**
 * SSRF guard for outbound HTTP from agent tools (currently WebFetch +
 * WebSearch). The threat we're closing:
 *
 *   An agent is prompt-injected into calling our outbound-HTTP tool with
 *   a URL that targets internal infrastructure: cloud metadata
 *   (169.254.169.254 — AWS/GCP IMDSv1 creds), loopback admin panels,
 *   LAN devices (10/8, 172.16/12, 192.168/16), link-local IPv6, etc.
 *
 * Defense in depth — four layers, all of which must pass:
 *
 *   1. URL parse: reject anything that isn't an http(s) scheme, anything
 *      with embedded userinfo (`http://user@host/`), and any host that's
 *      an IP literal pointing into a private range.
 *   2. Manual redirect handling: `redirect: 'manual'` on the underlying
 *      fetch. Each `Location` is run back through layer 1 + the dispatcher
 *      before we follow. Caps the chain at MAX_REDIRECTS to stop loops.
 *   3. DNS-resolution-time validation via a custom undici dispatcher
 *      whose `connect.lookup` rejects any resolved IP that's in a private
 *      range. This is what kills DNS rebinding: connect.lookup IS the
 *      resolution, so a server that returns a "good" A record on the
 *      first probe and a "bad" one on the actual connect can't slip past.
 *   4. Time + size caps come from the caller (timeout + max bytes) — we
 *      don't enforce them here, but they're part of the same posture.
 *
 * What this file deliberately does NOT do:
 *   - We do not extract embedded IPv4 from 6to4 (2002::/16) or Teredo
 *     (2001::/32) tunnels. Those are exotic enough that mainstream
 *     attackers don't reach for them; we accept the risk and document it.
 *   - We do not maintain an allowlist of "public" hosts. The deny list
 *     of private ranges is the contract; anything not in it is allowed.
 *     An opt-in operator allowlist (RITSU_WEBFETCH_ALLOW_PRIVATE_HOSTS)
 *     exists for legitimate cases (an internal docs server, an in-cluster
 *     API the operator intentionally wants reachable from agents).
 */
import { isIPv4, isIPv6 } from 'node:net';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

/**
 * Disallowed IPv4 ranges. We block anything that isn't a routable public
 * address. CIDR is stored as `[base, bitsToMask]` for fast bitwise checks.
 *
 * Sources: RFC 1918 (private), RFC 5735 (special-use), RFC 6890 (registry),
 * RFC 6598 (CGN), plus the cloud metadata convention (169.254.169.254 is
 * already covered by 169.254/16 link-local, but we list it explicitly so
 * the deny reason is operator-meaningful).
 */
const IPV4_DENY: ReadonlyArray<readonly [string, number, string]> = [
  ['0.0.0.0',         8,  'unspecified / "this network"'],
  ['10.0.0.0',        8,  'RFC 1918 private'],
  ['100.64.0.0',      10, 'RFC 6598 CGN'],
  ['127.0.0.0',       8,  'loopback'],
  ['169.254.0.0',     16, 'link-local / cloud metadata'],
  ['172.16.0.0',      12, 'RFC 1918 private'],
  ['192.0.0.0',       24, 'RFC 6890 reserved'],
  ['192.0.2.0',       24, 'TEST-NET-1'],
  ['192.168.0.0',     16, 'RFC 1918 private'],
  ['198.18.0.0',      15, 'benchmark / RFC 2544'],
  ['198.51.100.0',    24, 'TEST-NET-2'],
  ['203.0.113.0',     24, 'TEST-NET-3'],
  ['224.0.0.0',       4,  'multicast'],
  ['240.0.0.0',       4,  'reserved'],
  ['255.255.255.255', 32, 'limited broadcast'],
];

/**
 * Disallowed IPv6 ranges. Stored canonically (lowercase, expanded enough
 * to parse). The IPv4-mapped range (::ffff:0:0/96) needs special handling
 * — we extract the embedded IPv4 and re-check against the IPv4 list.
 */
const IPV6_DENY: ReadonlyArray<readonly [string, number, string]> = [
  ['::',     128, 'unspecified'],
  ['::1',    128, 'loopback'],
  ['fc00::', 7,   'unique local (RFC 4193)'],
  ['fe80::', 10,  'link-local'],
  ['ff00::', 8,   'multicast'],
];

/** Parse an IPv4 dotted-quad to a 32-bit number. Returns null on malformed input. */
function parseIPv4(ip: string): number | null {
  if (!isIPv4(ip)) return null;
  const parts = ip.split('.').map(s => Number(s));
  return (parts[0] * 2 ** 24) + (parts[1] * 2 ** 16) + (parts[2] * 2 ** 8) + parts[3];
}

/**
 * Expand any valid IPv6 string to its 128-bit BigInt value. Handles `::`,
 * the IPv4-mapped suffix (`::ffff:a.b.c.d`), and zone IDs (`%eth0`,
 * stripped). Returns null on input we can't parse.
 */
function parseIPv6(ip: string): bigint | null {
  if (!isIPv6(ip)) return null;
  // Strip zone id (e.g. `fe80::1%eth0` → `fe80::1`).
  const noZone = ip.split('%')[0];
  // Trailing IPv4 form: `::ffff:1.2.3.4` → `::ffff:0102:0304`.
  let normalized = noZone;
  const lastColon = noZone.lastIndexOf(':');
  const tail = noZone.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    const hi = (v4 >>> 16) & 0xffff;
    const lo = v4 & 0xffff;
    normalized = noZone.slice(0, lastColon + 1) + hi.toString(16) + ':' + lo.toString(16);
  }
  // Expand `::` to the right number of zero groups.
  const dblIdx = normalized.indexOf('::');
  let groups: string[];
  if (dblIdx === -1) {
    groups = normalized.split(':');
  } else {
    const left = dblIdx === 0 ? [] : normalized.slice(0, dblIdx).split(':');
    const right = dblIdx === normalized.length - 2 ? [] : normalized.slice(dblIdx + 2).split(':');
    const missing = 8 - left.length - right.length;
    groups = [...left, ...Array<string>(missing).fill('0'), ...right];
  }
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    const v = parseInt(g, 16);
    if (!Number.isFinite(v) || v < 0 || v > 0xffff) return null;
    n = (n << 16n) | BigInt(v);
  }
  return n;
}

function ipv4Reason(addr: number): string | null {
  for (const [base, bits, reason] of IPV4_DENY) {
    const baseN = parseIPv4(base);
    if (baseN === null) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((addr & mask) === (baseN & mask)) return reason;
  }
  return null;
}

function ipv6Reason(addr: bigint): string | null {
  // IPv4-mapped (::ffff:0:0/96): pull out the low 32 bits and re-check
  // against the IPv4 list. Without this, `::ffff:127.0.0.1` slips past
  // because no IPv6 range covers loopback-as-IPv4.
  const ipv4MappedPrefix = 0xffffn;
  const top96 = addr >> 32n;
  if (top96 === ipv4MappedPrefix) {
    const v4 = Number(addr & 0xffffffffn);
    const r = ipv4Reason(v4);
    if (r) return `IPv4-mapped (${r})`;
  }
  for (const [base, bits, reason] of IPV6_DENY) {
    const baseN = parseIPv6(base);
    if (baseN === null) continue;
    if (bits === 0) return reason;
    const shift = BigInt(128 - bits);
    if ((addr >> shift) === (baseN >> shift)) return reason;
  }
  return null;
}

/**
 * Return a deny reason if `ip` is in any disallowed range, or null if it's
 * a public address we're willing to talk to.
 */
export function denyReasonFor(ip: string): string | null {
  if (isIPv4(ip)) {
    const n = parseIPv4(ip);
    return n === null ? 'malformed IPv4' : ipv4Reason(n);
  }
  if (isIPv6(ip)) {
    const n = parseIPv6(ip);
    return n === null ? 'malformed IPv6' : ipv6Reason(n);
  }
  return 'not an IP literal';
}

/** Operator escape-hatch: comma-separated hostnames that bypass guard. */
function allowHosts(): ReadonlySet<string> {
  const raw = process.env.RITSU_WEBFETCH_ALLOW_PRIVATE_HOSTS ?? '';
  return new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

export interface UrlValidationOk { ok: true; url: URL }
export interface UrlValidationErr { ok: false; reason: string }
export type UrlValidation = UrlValidationOk | UrlValidationErr;

/**
 * Stage-1 validation. Runs BEFORE any network call. Catches:
 *   - non-http(s) schemes (file://, gopher://, javascript:, data:)
 *   - userinfo (`http://creds@host/`) — easy to misparse
 *   - IP-literal hosts pointing into private ranges (no DNS step at all)
 *
 * Hostname hosts get a `null` IP check here and are validated at
 * resolution time by the dispatcher.
 */
export function validateUrl(rawUrl: string): UrlValidation {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return { ok: false, reason: 'not a valid URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `only http(s) URLs are allowed (got ${u.protocol})` };
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'URLs with embedded credentials are not allowed' };
  }
  // URL.hostname KEEPS the brackets around an IPv6 literal (`[::1]`); strip
  // them before classifying. Bracketed form fails isIPv6/isIPv4 directly,
  // and an unstripped allow-host comparison would never match either.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (allowHosts().has(host.toLowerCase())) return { ok: true, url: u };
  if (isIPv4(host) || isIPv6(host)) {
    const reason = denyReasonFor(host);
    if (reason) return { ok: false, reason: `${host} blocked: ${reason}` };
  }
  return { ok: true, url: u };
}

/**
 * Build an undici dispatcher whose connect.lookup performs DNS resolution
 * and rejects results that resolve to private ranges. This is the layer
 * that closes DNS rebinding — every connect call routes through here,
 * including connects made for the (manually-followed) redirects.
 */
export function createSafeDispatcher(): Dispatcher {
  return new Agent({
    connect: {
      lookup: (hostname, options, cb) => {
        if (allowHosts().has(hostname.toLowerCase())) {
          return dnsLookup(hostname, options, cb);
        }
        // Always ask for both families so we can reject hostnames whose
        // ANY resolved address is private (covers split DNS where v4 is
        // public but v6 resolves to ::1, or vice-versa).
        dnsLookup(hostname, { all: true, family: 0 }, (err, addrs: LookupAddress[]) => {
          if (err) { cb(err, '', 0); return; }
          for (const a of addrs) {
            const reason = denyReasonFor(a.address);
            if (reason) {
              cb(new Error(`SSRF guard: ${hostname} resolves to ${a.address} (${reason})`), '', 0);
              return;
            }
          }
          // Honour the caller's family preference for the actual return.
          const family = typeof options === 'object' ? options.family : 0;
          const chosen = family === 4
            ? addrs.find(a => a.family === 4)
            : family === 6
              ? addrs.find(a => a.family === 6)
              : addrs[0];
          if (!chosen) { cb(new Error(`no ${family ? `IPv${family}` : ''} address`), '', 0); return; }
          cb(null, chosen.address, chosen.family);
        });
      },
    },
  });
}

export interface SafeFetchOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  maxRedirects?: number;
  method?: string;
  body?: string;
}

const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Fetch with the full SSRF guard stack applied. Caller is responsible for
 * the timeout (via `signal`) and the response-size cap (consume the body
 * stream with an upper bound). Everything address-policy-related is
 * handled here.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const dispatcher = createSafeDispatcher();
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = rawUrl;
  let method = opts.method ?? 'GET';
  let body = opts.body;
  let hops = 0;
  while (true) {
    const v = validateUrl(current);
    if (!v.ok) throw new Error(`SSRF guard: ${v.reason}`);
    const res = await undiciFetch(v.url.href, {
      method,
      body,
      redirect: 'manual',
      signal: opts.signal,
      headers: opts.headers,
      dispatcher,
    });
    // 3xx with Location → re-validate and follow manually. Anything else
    // (including 3xx without a Location header) is final.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      if (hops >= maxRedirects) {
        throw new Error(`SSRF guard: too many redirects (>${maxRedirects})`);
      }
      // Resolve relative redirects against the current URL. 307/308 keep the
      // method and body; every other 3xx degrades to GET, per fetch.
      current = new URL(loc, v.url).href;
      if (res.status !== 307 && res.status !== 308) { method = 'GET'; body = undefined; }
      hops++;
      continue;
    }
    return res;
  }
}
