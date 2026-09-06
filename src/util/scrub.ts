/**
 * Strip credential-shaped substrings from text before it is returned to a
 * model. Defense-in-depth for connector ERROR messages: those embed upstream
 * HTTP/SMTP/IMAP responses, which don't echo our credentials today — but if a
 * provider ever did, or a future catch serialized more of the error, this
 * keeps a token out of the LLM's context. Intentionally aggressive (over-
 * redaction of an error string is harmless).
 */
const PATTERNS: RegExp[] = [
  /Bearer\s+[a-z0-9._~+/=-]{8,}/gi,      // Authorization: Bearer <token>
  /Basic\s+[a-z0-9+/=]{4,}/gi,           // Authorization: Basic <base64(user:pass)> — any length
  /oauth_[a-z_]+="?[^&\s"']+"?/gi,        // OAuth 1.0a params (signature/nonce/token) — Twitter
  /\b[A-Za-z0-9_-]{40,}\b/g,             // long opaque tokens / API keys
  /[A-Za-z0-9+/]{40,}={0,2}/g,           // base64 blobs (e.g. an oauth_signature) the `_-` class misses
  /\bAKIA[0-9A-Z]{16}\b/g,               // AWS-style key ids
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}
