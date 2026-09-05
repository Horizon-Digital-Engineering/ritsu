/**
 * Property-based tests over the pure functions the security posture leans on.
 * Where an example-based test proves one input behaves, these prove an
 * INVARIANT holds across hundreds of adversarial inputs per run — exactly the
 * right tool for sanitizers and fences, whose failure mode is the input
 * nobody thought to write down.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { fenceUntrusted } from '../util/untrusted.js';
import { htmlToText, clampLimit } from '../admin/server.js';
import { asNumber, asString } from '../util/cast.js';

const RUNS = { numRuns: 300 };

// ── the browser markdown renderer, extracted via its markers ────────────────
const wsSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'admin', 'workspace.js'), 'utf8');
const mdSrc = wsSrc.slice(wsSrc.indexOf('// MD-PURE-START'), wsSrc.indexOf('// MD-PURE-END'));
const esc = (s: string) => s.replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
// The renderer under test is a browser script; the marker-delimited slice is
// pure (esc is its only dependency), so evaluating it here is the seam.
// eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
const md = new Function('esc', `${mdSrc}; return md;`)(esc) as (raw: string) => string;

/** Tags md() is allowed to emit — anything else reaching '<' is an escape. */
const ALLOWED_TAG = /^<\/?(?:h[2-5]|strong|em|code|a |a>|ul|ol|li|blockquote|hr>|br>|div|pre|button|span|details|summary)/;

describe('property: md() containment', () => {
  it('never lets an input-controlled tag or handler survive', () => {
    fc.assert(fc.property(fc.string({ maxLength: 400 }), (input) => {
      const out = md(input);
      // Every '<' must open one of OUR literal tags.
      for (let i = out.indexOf('<'); i !== -1; i = out.indexOf('<', i + 1)) {
        assert.match(out.slice(i, i + 14), ALLOWED_TAG, `stray tag at ${i} for ${JSON.stringify(input)}`);
      }
      assert.equal(/ on\w+=/.test(out.replace(/data-action/g, '')), false, 'no event handlers');
      assert.equal(/href="(?!https?:)/.test(out), false, 'hrefs are http(s) only');
    }), RUNS);
  });

  it('survives inputs built from hostile fragments', () => {
    const hostile = fc.array(fc.constantFrom(
      '<script>', '</script>', 'javascript:', 'onerror=', '"', "'", '`', '$', '\\',
      '<img src=x>', '[x](', ')', '**', '```', '', '&amp;', '\n', '# ', '- ',
    ), { maxLength: 30 }).map(a => a.join(''));
    fc.assert(fc.property(hostile, (input) => {
      const out = md(input);
      assert.equal(out.includes('<script'), false);
      assert.equal(out.includes('<img'), false);
      assert.equal(/href="javascript/i.test(out), false);
    }), RUNS);
  });
});

describe('property: htmlToText', () => {
  // This is text EXTRACTION, not sanitization: its output is fenced data,
  // never rendered. So the honest invariants are narrower than "no angle
  // brackets" — a lone '<' in prose, or one produced by decoding a literal
  // &lt;, is correct output.
  it('script/style content never survives, and no complete raw tag does', () => {
    fc.assert(fc.property(fc.string({ maxLength: 200 }), (raw) => {
      fc.pre(!raw.includes('<') && !raw.includes('>'));
      // Sentinel-wrapped so a one-character secret can't collide with the
      // template's own prose outside the tags.
      const secret = `ZQXSECRET${raw}TERCESXQZ`;
      const out = htmlToText(`a<script x=y>${secret}</script\t z>b<style>${secret}</style>c`);
      assert.equal(out.includes('ZQXSECRET'), false, JSON.stringify(raw));
    }), RUNS);
    fc.assert(fc.property(fc.string({ maxLength: 300 }), (input) => {
      const out = htmlToText(input);
      assert.equal(/<[a-zA-Z!/][^>]*>/.test(out.replace(/&/g, '')), false,
        `a complete raw tag survived for ${JSON.stringify(input)}`);
    }), RUNS);
  });

  it('decodes exactly one layer: doubled entities never fully unwrap', () => {
    // No bare '&': every ampersand enters pre-encoded as '&amp;', so a '<'
    // in the output could only come from a double decode.
    const entityish = fc.array(fc.constantFrom(
      '&amp;', 'amp;', 'lt;', 'gt;', 'quot;', ';', 'script',
    ), { maxLength: 30 }).map(a => a.join(''));
    fc.assert(fc.property(entityish, (input) => {
      // No raw angle brackets go in, so none may come out: '&amp;lt;' must
      // yield the four characters '&lt;', never a freshly minted '<'.
      const out = htmlToText(input);
      assert.equal(out.includes('<'), false, JSON.stringify(input));
      assert.equal(out.includes('>'), false, JSON.stringify(input));
    }), RUNS);
  });
});

describe('property: fenceUntrusted', () => {
  it('always yields matching one-time markers, and defangs planted ones', () => {
    fc.assert(fc.property(fc.string({ maxLength: 300 }), fc.string({ maxLength: 60 }), (content, source) => {
      const out = fenceUntrusted(source, content);
      const begin = /<<<UNTRUSTED ([0-9a-f]{18})/.exec(out);
      assert.ok(begin, 'opening marker present');
      const nonce = begin[1];
      assert.ok(out.includes(`UNTRUSTED ${nonce}>>>`), 'matching closer present');
      // The content body between the markers must not contain a well-formed
      // marker of its own — planted ones get defanged. The marker string also
      // appears earlier in the fence's own instruction sentence, so the REAL
      // opener is the LAST occurrence.
      const bodyStart = out.lastIndexOf(begin[0]) + begin[0].length;
      const body = out.slice(bodyStart, out.lastIndexOf(`UNTRUSTED ${nonce}>>>`));
      assert.equal(/<<<\s*UNTRUSTED/i.test(body), false, 'no forged opener inside');
    }), RUNS);
  });

  it('a hostile source line cannot break the header', () => {
    fc.assert(fc.property(fc.string({ maxLength: 300 }), (source) => {
      const out = fenceUntrusted(source, 'body');
      const header = out.slice(0, out.indexOf('\n') === -1 ? out.length : out.indexOf('\n'));
      assert.equal(/<<<\s*UNTRUSTED/i.test(header.replace(/<<<UNTRUSTED [0-9a-f]{18}/, '')), false);
    }), RUNS);
  });
});

describe('property: numeric guards', () => {
  it('clampLimit always lands in [1, max] or on the fallback', () => {
    fc.assert(fc.property(
      fc.oneof(fc.anything(), fc.double(), fc.string()), fc.integer({ min: 1, max: 500 }), fc.integer({ min: 501, max: 5000 }),
      (raw, fallback, max) => {
        const out = clampLimit(raw, fallback, max);
        assert.ok(Number.isInteger(out));
        assert.ok(out === fallback || (out >= 1 && out <= max), `${String(out)}`);
      }), RUNS);
  });

  it('asNumber never returns NaN or Infinity; asString never stringifies objects', () => {
    fc.assert(fc.property(fc.anything(), (v) => {
      const n = asNumber(v);
      assert.ok(n === null || Number.isFinite(n));
      const s = asString(v);
      assert.equal(s.includes('[object'), false);
    }), RUNS);
  });
});
