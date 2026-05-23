/**
 * Type-safe HTML escaping for server-rendered admin / OAuth pages.
 *
 * The goal: make it impossible to send unescaped user input to a browser
 * by accident. `escapeHtml(...)` and the `html\`...\`` tagged template are
 * the ONLY ways to produce a `SafeHtml` value, and `sendHtml(res, html)`
 * is the only sanctioned way to ship HTML to the wire. A plain string
 * cannot satisfy the SafeHtml type, so a route handler that tries to
 * `sendHtml(res, "<div>" + userInput + "</div>")` fails to typecheck.
 *
 * Runtime contract: `SafeHtml` is an instance of an internal class
 * (`SafeHtmlImpl`) whose .toString() returns the underlying HTML text.
 * The class branding means we can distinguish pre-escaped chunks from
 * raw strings inside the `html` template, even though both are
 * "string-shaped" at the JS level.
 */
import type { Response } from 'express';

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

class SafeHtmlImpl {
  readonly #raw: string;
  constructor(raw: string) { this.#raw = raw; }
  toString(): string { return this.#raw; }
}

/** Branded HTML string — produced only by escapeHtml / html`...`. */
export type SafeHtml = SafeHtmlImpl;

/**
 * Escape a raw string for safe HTML insertion. Returns a SafeHtml value
 * that can be interpolated into `html\`...\`` or passed to `sendHtml`.
 */
export function escapeHtml(s: string): SafeHtml {
  return new SafeHtmlImpl(s.replace(/[&<>"']/g, c => ENTITIES[c] ?? c));
}

/**
 * Tagged template that builds a SafeHtml. Each `${value}` is auto-handled:
 *   - SafeHtml values pass through unchanged (already escaped)
 *   - SafeHtml[] arrays concatenate without escape (for repeated fragments)
 *   - everything else is coerced to string and escaped
 *   - null / undefined render as empty
 *
 *   const greeting = html`<h1>Hello, ${name}</h1>`;
 *   const list    = html`<ul>${items.map(i => html`<li>${i}</li>`)}</ul>`;
 */
export function html(
  parts: TemplateStringsArray,
  ...values: ReadonlyArray<SafeHtml | string | number | null | undefined | ReadonlyArray<SafeHtml>>
): SafeHtml {
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    out += parts[i];
    if (i >= values.length) continue;
    const v = values[i];
    if (v === null || v === undefined) continue;
    if (v instanceof SafeHtmlImpl) {
      out += v.toString();
    } else if (Array.isArray(v)) {
      // TypeScript constrains array elements to SafeHtml via the values
      // parameter type, but Array.isArray narrows to any[]; reassert to
      // the constrained shape so the loop body is type-safe.
      const arr = v as ReadonlyArray<SafeHtml>;
      for (const item of arr) out += item.toString();
    } else {
      out += escapeHtml(String(v)).toString();
    }
  }
  return new SafeHtmlImpl(out);
}

/**
 * Send a SafeHtml document as a properly-typed HTML response. The signature
 * accepts only SafeHtml — a plain string fails to typecheck. This is the
 * single sanctioned path for shipping HTML; route handlers that build HTML
 * should funnel through here so an "I forgot to escape" mistake is caught
 * at compile time, not in production.
 */
export function sendHtml(res: Response, body: SafeHtml, status: number = 200): void {
  res.status(status).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(body.toString());
}
