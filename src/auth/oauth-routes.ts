import { type Express, type Request, type Response, urlencoded } from 'express';
import { z } from 'zod';
import type { OAuthStore } from './oauth-store.js';
import type { TokenStore } from './token-store.js';
import { logger } from '../util/log.js';
import { stripTrailingSlashes } from '../util/path-utils.js';
import { html, sendHtml, type SafeHtml } from '../util/safe-html.js';

/**
 * OAuth 2.1 / MCP-spec endpoints. Mounted on the MCP-port app so all
 * URLs share the canonical resource origin (`publicUrl`). That's important:
 * RFC 8707 says tokens are bound to the resource's canonical URI, which
 * for us is `${publicUrl}/mcp`.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-protected-resource     RFC 9728
 *   GET  /.well-known/oauth-authorization-server   RFC 8414
 *   POST /oauth/register                           RFC 7591 (DCR)
 *   GET  /oauth/authorize                          consent page (HTML)
 *   POST /oauth/authorize                          consent submission
 *   POST /oauth/token                              auth_code + refresh_token grants
 *
 * Consent flow is admin-gated: the operator must paste their admin token
 * on the consent page to approve any client. That's the bridge between
 * "OAuth flow" (client doesn't know who's behind ritsu) and "ritsu's
 * existing trust model" (only the box owner has the admin token).
 */

export interface OAuthRouteDeps {
  oauth: OAuthStore;
  tokens: TokenStore;
  /** Canonical public origin, e.g. `https://your-host.your-tailnet.ts.net:9443` */
  publicUrl: string;
}

export const RESOURCE_PATH = '/mcp';

const RegisterBody = z.object({
  client_name: z.string().max(200).optional(),
  redirect_uris: z.array(z.url()).min(1).max(8),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.literal('none').optional(),
  scope: z.string().optional(),
  software_id: z.string().optional(),
  software_version: z.string().optional(),
}).strict();

const TokenBodyAuthCode = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string(),
  redirect_uri: z.url(),
  client_id: z.string(),
  code_verifier: z.string().min(43).max(128),
  resource: z.url().optional(),
});

const TokenBodyRefresh = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string(),
  client_id: z.string(),
  scope: z.string().optional(),
});

/** Validate redirect_uri is registered for client AND meets OAuth 2.1 transport rule. */
function isValidRedirect(uri: string, registered: string[]): boolean {
  if (!registered.includes(uri)) return false;
  try {
    const u = new URL(uri);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]') return true;
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function mountOAuthRoutes(app: Express, deps: OAuthRouteDeps): void {
  const { oauth, tokens, publicUrl } = deps;
  const resourceCanonical = `${publicUrl}${RESOURCE_PATH}`;

  // Form parser for the consent submission + token endpoint
  // (the spec allows token endpoint to accept application/x-www-form-urlencoded).
  app.use('/oauth', urlencoded({ extended: false, limit: '64kb' }));

  // ---- Discovery -------------------------------------------------------

  app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.json({
      resource: resourceCanonical,
      authorization_servers: [publicUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
      resource_documentation: `${publicUrl}/admin`,
    });
  });

  app.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    res.json({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/oauth/authorize`,
      token_endpoint: `${publicUrl}/oauth/token`,
      registration_endpoint: `${publicUrl}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
      service_documentation: `${publicUrl}/admin`,
    });
  });

  // ---- Dynamic Client Registration (RFC 7591) --------------------------

  app.post('/oauth/register', (req: Request, res: Response) => {
    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_client_metadata', error_description: parsed.error.message });
      return;
    }
    // Validate redirect URIs: HTTPS or loopback only.
    for (const u of parsed.data.redirect_uris) {
      try {
        const url = new URL(u);
        const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
        if (!loopback && url.protocol !== 'https:') {
          res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'must be https or loopback' });
          return;
        }
      } catch {
        res.status(400).json({ error: 'invalid_redirect_uri' });
        return;
      }
    }
    const client = oauth.registerClient({
      client_name: parsed.data.client_name,
      redirect_uris: parsed.data.redirect_uris,
      scope: parsed.data.scope,
      software_id: parsed.data.software_id,
      software_version: parsed.data.software_version,
    });
    logger.info('oauth.client.registered', {
      client_id: client.client_id,
      client_name: client.client_name,
      software_id: client.software_id,
    });
    // RFC 7591 §3.2.1 success response
    res.status(201).json({
      client_id: client.client_id,
      client_id_issued_at: client.created_at,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      response_types: client.response_types,
      token_endpoint_auth_method: 'none',
      scope: client.scope,
    });
  });

  // ---- Authorization endpoint -----------------------------------------

  app.get('/oauth/authorize', (req: Request, res: Response) => {
    const qp = req.query as Record<string, string | undefined>;
    const err = validateAuthorize(qp, oauth);
    if ('error' in err) {
      // Per OAuth 2.1: if client_id / redirect_uri is wrong, do NOT redirect —
      // render an error page instead (otherwise we'd be a phishing redirector).
      res.status(400).type('text/plain').send(`OAuth error: ${err.error} — ${err.description}`);
      return;
    }
    sendHtml(res, renderConsent(err.client_name, qp));
  });

  app.post('/oauth/authorize', (req: Request, res: Response) => {
    const body = req.body as Record<string, string | undefined>;
    const adminToken = (body.admin_token ?? '').trim();
    if (!adminToken) {
      res.status(400).type('text/plain').send('admin_token required');
      return;
    }
    const adminRow = tokens.verify(adminToken, 'admin');
    if (!adminRow) {
      // Re-render consent with an error.
      const qp = req.body as Record<string, string | undefined>;
      const errCheck = validateAuthorize(qp, oauth);
      if ('error' in errCheck) {
        res.status(400).type('text/plain').send(errCheck.description);
        return;
      }
      // renderConsent returns a typed SafeHtml; sendHtml refuses anything
      // that isn't pre-escaped, so a plain-string accident here fails to
      // typecheck rather than shipping an XSS.
      sendHtml(res, renderConsent(errCheck.client_name, qp, 'invalid admin token'), 401);
      return;
    }
    // Re-validate from the form body (don't trust client to send same values twice).
    const check = validateAuthorize(body, oauth);
    if ('error' in check) {
      res.status(400).type('text/plain').send(check.description);
      return;
    }
    const decision = (body.decision ?? '').toLowerCase();
    if (decision !== 'approve') {
      const redirect = new URL(body.redirect_uri!);
      redirect.searchParams.set('error', 'access_denied');
      if (body.state) redirect.searchParams.set('state', body.state);
      res.redirect(302, redirect.toString());
      return;
    }
    const resource = stripTrailingSlashes(body.resource ?? resourceCanonical);
    const minted = oauth.mintAuthzCode({
      client_id: body.client_id!,
      redirect_uri: body.redirect_uri!,
      scope: (body.scope ?? 'mcp').trim() || 'mcp',
      code_challenge: body.code_challenge!,
      code_challenge_method: 'S256',
      resource,
    });
    const redirect = new URL(body.redirect_uri!);
    redirect.searchParams.set('code', minted.code);
    if (body.state) redirect.searchParams.set('state', body.state);
    logger.info('oauth.authz.granted', {
      client_id: body.client_id,
      admin_token_id: adminRow.id,
      resource,
    });
    res.redirect(302, redirect.toString());
  });

  // ---- Token endpoint --------------------------------------------------

  app.post('/oauth/token', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    // grant_type drives which downstream schema (TokenBodyAuthCode /
    // TokenBodyRefresh) parses the rest of the body. Parse it first so
    // an unrecognized value gets a clean error instead of cascading into
    // a more confusing "missing X" from the downstream schema.
    const dispatch = z.object({ grant_type: z.string() }).safeParse(req.body);
    if (!dispatch.success) {
      res.status(400).json({ error: 'invalid_request', error_description: 'grant_type required' });
      return;
    }
    switch (dispatch.data.grant_type) {
      case 'authorization_code': return handleAuthorizationCodeGrant(req, res, oauth);
      case 'refresh_token':       return handleRefreshTokenGrant(req, res, oauth);
      default:                    res.status(400).json({ error: 'unsupported_grant_type' });
    }
  });
}

/** RFC 6749 §4.1.3 — authorization_code grant. Validates the body shape,
 *  resolves the client, consumes the authz code (one-shot), enforces the
 *  RFC 8707 audience binding, and mints the access + refresh pair. */
function handleAuthorizationCodeGrant(req: Request, res: Response, oauth: OAuthStore): void {
  const parsed = TokenBodyAuthCode.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', error_description: parsed.error.message });
    return;
  }
  if (!oauth.getClient(parsed.data.client_id)) {
    res.status(400).json({ error: 'invalid_client' });
    return;
  }
  const info = oauth.consumeAuthzCode({
    code: parsed.data.code,
    client_id: parsed.data.client_id,
    redirect_uri: parsed.data.redirect_uri,
    code_verifier: parsed.data.code_verifier,
  });
  if (!info) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'code invalid, expired, used, or PKCE mismatch' });
    return;
  }
  // RFC 8707: if client sent `resource` on the token request, it MUST match
  // the resource bound to the authz code.
  if (parsed.data.resource && stripTrailingSlashes(parsed.data.resource) !== info.resource) {
    res.status(400).json({ error: 'invalid_target', error_description: 'resource mismatch with authorization request' });
    return;
  }
  const tok = oauth.mintTokens({ client_id: info.client_id, scope: info.scope, resource: info.resource });
  logger.info('oauth.token.issued', { client_id: info.client_id, scope: info.scope, resource: info.resource });
  res.json({
    access_token: tok.access_token,
    token_type: 'Bearer',
    expires_in: tok.expires_in,
    refresh_token: tok.refresh_token,
    scope: tok.scope,
  });
}

/** RFC 6749 §6 — refresh_token grant. Validates the body, resolves the
 *  client, rotates the refresh token (single-use, returns a new pair). */
function handleRefreshTokenGrant(req: Request, res: Response, oauth: OAuthStore): void {
  const parsed = TokenBodyRefresh.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', error_description: parsed.error.message });
    return;
  }
  if (!oauth.getClient(parsed.data.client_id)) {
    res.status(400).json({ error: 'invalid_client' });
    return;
  }
  const rotated = oauth.rotateRefresh({
    refresh_token: parsed.data.refresh_token,
    client_id: parsed.data.client_id,
  });
  if (!rotated) {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }
  res.json({
    access_token: rotated.access_token,
    token_type: 'Bearer',
    expires_in: rotated.expires_in,
    refresh_token: rotated.refresh_token,
    scope: rotated.scope,
  });
}

// ---- helpers -----------------------------------------------------------

type AuthorizeError = { error: string; description: string };
type AuthorizeOk = { client_name: string };

function validateAuthorize(qp: Record<string, string | undefined>, oauth: OAuthStore): AuthorizeError | AuthorizeOk {
  if (!qp.response_type || qp.response_type !== 'code') {
    return { error: 'unsupported_response_type', description: 'response_type must be code' };
  }
  if (!qp.client_id) return { error: 'invalid_request', description: 'client_id required' };
  if (!qp.redirect_uri) return { error: 'invalid_request', description: 'redirect_uri required' };
  if (!qp.code_challenge) return { error: 'invalid_request', description: 'code_challenge required (PKCE)' };
  if (qp.code_challenge_method !== 'S256') {
    return { error: 'invalid_request', description: 'code_challenge_method must be S256' };
  }
  const client = oauth.getClient(qp.client_id);
  if (!client) return { error: 'invalid_client', description: 'unknown client_id' };
  if (!isValidRedirect(qp.redirect_uri, client.redirect_uris)) {
    return { error: 'invalid_request', description: 'redirect_uri not registered for client (or not https/loopback)' };
  }
  return { client_name: client.client_name };
}

function renderConsent(
  clientName: string,
  qp: Record<string, string | undefined>,
  errorMsg?: string,
): SafeHtml {
  // All passthrough params need to round-trip through the form so the POST
  // can re-validate without trusting the client to re-send query string.
  // Building each <input> via `html` returns a SafeHtml; the array then
  // interpolates into the outer template without re-escape.
  const fields = ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'resource'] as const;
  const hidden = fields.map(k => html`<input type="hidden" name="${k}" value="${qp[k] ?? ''}">`);
  const errBlock = errorMsg ? html`<div class="err">${errorMsg}</div>` : html``;
  return html`<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ritsu — authorize MCP client</title>
<style>
  body { font: 14px -apple-system, system-ui, sans-serif; background:#111; color:#ddd; margin:0; padding:40px; display:flex; justify-content:center; }
  .card { max-width: 480px; width:100%; background:#1a1a1a; border:1px solid #333; border-radius:8px; padding:28px; }
  h1 { font-size:18px; margin:0 0 4px; font-weight:600; }
  .sub { color:#888; font-size:13px; margin-bottom:24px; }
  dl { margin: 0 0 24px; }
  dt { color:#888; font-size:12px; text-transform:uppercase; letter-spacing:0.04em; margin-top:12px; }
  dd { margin:2px 0 0; word-break: break-all; font-family: ui-monospace, Menlo, monospace; font-size:13px; color:#eee; }
  label { display:block; font-size:13px; color:#ccc; margin: 18px 0 6px; }
  input[type=password] { width:100%; box-sizing:border-box; background:#0e0e0e; border:1px solid #333; color:#eee; padding:10px 12px; border-radius:6px; font: 14px ui-monospace, Menlo, monospace; }
  .row { display:flex; gap:8px; margin-top:20px; }
  button { flex:1; padding:10px 14px; border-radius:6px; border:1px solid #333; background:#222; color:#eee; cursor:pointer; font:14px inherit; }
  button.primary { background:#2c5e2e; border-color:#3a7d3c; }
  button.primary:hover { background:#357538; }
  button.deny:hover { background:#2a2a2a; }
  .err { background:#3a1c1c; border:1px solid #6a2828; color:#f5c1c1; padding:10px 12px; border-radius:6px; margin: 0 0 16px; font-size:13px; }
  a { color:#7aa7d6; }
</style>
</head><body>
<div class="card">
  <h1>Authorize MCP client</h1>
  <div class="sub">A client wants to call this ritsu server's MCP tools on your behalf.</div>
  ${errBlock}
  <dl>
    <dt>Client</dt><dd>${clientName}</dd>
    <dt>Redirect URI</dt><dd>${qp.redirect_uri ?? ''}</dd>
    <dt>Scope</dt><dd>${qp.scope ?? 'mcp'}</dd>
    <dt>Resource</dt><dd>${qp.resource ?? '(default)'}</dd>
  </dl>
  <form method="post" action="/oauth/authorize" autocomplete="on">
    ${hidden}
    <label for="admin-token">Admin token (to confirm it's you)</label>
    <input id="admin-token" type="password" name="admin_token" autocomplete="current-password" required>
    <div class="row">
      <button class="deny" name="decision" value="deny" type="submit">Deny</button>
      <button class="primary" name="decision" value="approve" type="submit">Approve</button>
    </div>
  </form>
</div>
</body></html>`;
}
