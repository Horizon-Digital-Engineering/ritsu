import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Catches the bug shipped in 0.6.1 where admin/app.js used top-level
 * `await` but ui.html loaded it as a classic script (`<script src=…
 * defer>` without `type="module"`). The browser parser threw
 * SyntaxError on every load, the page was permanently stuck on
 * "loading…", and there was no test in CI that would have noticed —
 * the file isn't typechecked (it's hand-written JS, not TS).
 *
 * Strategy: dynamic import() of app.js. Node will parse it as an ES
 * module; if there's a syntax error (top-level await without module
 * context, unclosed template literal, etc.), the import rejects with
 * SyntaxError. Runtime errors past the parse stage (no `document`
 * defined in Node, etc.) are expected and intentionally ignored —
 * we only assert against the parse-time class.
 *
 * Companion check on ui.html: assert the script tag explicitly says
 * `type="module"`. If someone re-bumps the file to a classic script
 * (intentionally or via a copy-paste regression), this test catches
 * it without needing a browser in CI.
 */
describe('admin static assets parse cleanly', () => {
  it('admin/app.js has no syntax errors (parses as an ES module)', async () => {
    const appJs = pathToFileURL(resolve('src/admin/app.js')).href;
    let syntaxError: Error | null = null;
    try {
      await import(appJs);
    } catch (err) {
      if (err instanceof SyntaxError) syntaxError = err;
      // ReferenceError (no `document`), TypeError, etc. are runtime
      // errors past the parse stage — they're EXPECTED in Node and
      // do not indicate a broken script in the browser.
    }
    assert.equal(syntaxError, null, syntaxError ?? undefined);
  });

  it('admin/ui.html loads app.js with type="module"', () => {
    const html = readFileSync(resolve('src/admin/ui.html'), 'utf8');
    // Specifically guard against the regression: a script tag that
    // references app.js MUST carry type="module" because app.js uses
    // top-level await. A classic `<script src=… defer>` would parse-
    // error in the browser.
    // No XSS sink here: `html` is a static test fixture read from disk and the
    // match is only asserted on, never rendered. semgrep's script-tag rule
    // can't see that, so suppress it on the line it reports (the assert).
    const tagMatch = html.match(/<script[^>]*\bsrc=["'][^"']*app\.js[^"']*["'][^>]*>/);
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    assert.ok(tagMatch, 'no <script src="…app.js"> tag found in ui.html');
    const tag = tagMatch[0];
    assert.match(
      tag,
      /\btype=["']module["']/,
      `app.js script tag is missing type="module": ${tag}`,
    );
  });
});
