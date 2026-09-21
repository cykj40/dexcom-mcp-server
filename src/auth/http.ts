import { randomUUID } from 'node:crypto'
import type {
  ErrorRequestHandler,
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express'
import { APPROVAL_TTL, LEGACY_CUTOFF, type OAuthConfig } from './config.js'
import { hash, isChallenge, isCredential, isVerifier, secretEquals } from './crypto.js'
import type { ExchangeResult, OAuthStore } from './store.js'

const COOKIE = '__Host-mcp-approval'
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  )
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

// All diagnostic objects are constructed here; never serialize a request, error, token, or DB row.
export type AuditEvent = { timestamp: string; request_id: string; grant_id: string } & (
  | { event: 'grant_issued' | 'authorization_code_reuse_revoked' }
  | { event: 'refresh_rotation_committed'; consumed_generation: number; issued_generation: number }
  | { event: 'refresh_reuse_revoked'; reused_generation: number; rotation_to_reuse_seconds: number }
  | { event: 'refresh_response'; outcome: 'finished' | 'closed_prematurely' }
)
export type AuditSink = (event: AuditEvent) => void

// Installed after the routes, including for parser errors raised before a route runs.
export const sanitizedHttpError: ErrorRequestHandler = (_error, _req, res, _next) => {
  if (res.headersSent) {
    res.end()
    return
  }
  res.setHeader('Cache-Control', 'no-store')
  res.status(400).json({ error: 'invalid_request' })
}

export function registerOAuth(
  app: Express,
  config: OAuthConfig,
  store: OAuthStore,
  audit: AuditSink = (event) => console.error(JSON.stringify(event)),
): RequestHandler {
  const noStore = (res: Response) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
  }
  const safe =
    (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      noStore(res)
      try {
        await handler(req, res)
      } catch {
        // DB/driver errors can include SQL parameters. Never forward them to logs or Express.
        if (!res.headersSent) res.status(503).json({ error: 'server_error' })
      }
    }

  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer: config.issuer,
      authorization_endpoint: `${config.issuer}/authorize`,
      token_endpoint: `${config.issuer}/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['offline_access'],
    })
  })
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({ resource: config.resource, authorization_servers: [config.issuer] })
  })

  app.get(
    '/authorize',
    safe(async (req, res) => {
      const p = record(req.query)
      // Validate the redirect before all branches; never redirect to an unvalidated destination.
      if (typeof p.redirect_uri !== 'string' || !config.redirects.has(p.redirect_uri)) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'redirect_uri missing or not allowed',
        })
        return
      }
      if (p.client_id !== config.clientId) {
        res.status(401).json({ error: 'invalid_client' })
        return
      }
      if (p.response_type !== 'code') {
        res.status(400).json({ error: 'unsupported_response_type' })
        return
      }
      if (
        p.code_challenge_method !== 'S256' ||
        !isChallenge(p.code_challenge) ||
        (p.state !== undefined && (typeof p.state !== 'string' || p.state.length > 2048))
      ) {
        res.status(400).json({ error: 'invalid_request' })
        return
      }
      if (p.scope !== undefined && p.scope !== 'offline_access') {
        res.status(400).json({ error: 'invalid_scope' })
        return
      }
      if (p.resource !== undefined && p.resource !== config.resource) {
        res.status(400).json({ error: 'invalid_target' })
        return
      }
      const approval = await store.createApproval({
        clientId: config.clientId,
        redirectUri: p.redirect_uri,
        state: (p.state as string | undefined) ?? null,
        scope: 'offline_access',
        challenge: p.code_challenge,
      })
      res.cookie(COOKIE, approval.browserNonce, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: APPROVAL_TTL * 1000,
      })
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      )
      res.setHeader('X-Frame-Options', 'DENY')
      res
        .type('html')
        .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Approve Dexcom MCP access</title></head>
      <body><h1>Approve Dexcom MCP access</h1>
      <p>Client: ${escapeHtml(config.clientId)}</p><p>Redirect: ${escapeHtml(p.redirect_uri)}</p>
      <p>This grants access to all registered MCP tools, including health data and event and baseline writes.
      Access renews automatically for up to 30 days, unless revoked or refresh credentials expire after seven days.</p>
      <p>Approve only a connection you just initiated. This request expires in ten minutes.</p>
      <form method="post" action="/authorize">
      <input type="hidden" name="request_id" value="${escapeHtml(approval.requestId)}">
      <input type="hidden" name="csrf_token" value="${escapeHtml(approval.csrfToken)}">
      <label>Owner approval key <input type="password" name="owner_key" autocomplete="current-password" required maxlength="43"></label>
      <button name="decision" value="approve">Approve</button>
      <button name="decision" value="deny" formnovalidate>Deny</button></form></body></html>`)
    }),
  )

  app.post(
    '/authorize',
    safe(async (req, res) => {
      const p = record(req.body)
      const cookies = (req.headers.cookie ?? '')
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.startsWith(`${COOKIE}=`))
      const nonce = cookies.length === 1 ? cookies[0].slice(COOKIE.length + 1) : undefined
      console.error(JSON.stringify({
        event: 'authorize_debug',
        origin_header: req.headers.origin ?? null,
        origin_matches_issuer: req.headers.origin === config.issuer,
        cookie_header_present: Boolean(req.headers.cookie),
        matching_cookie_count: cookies.length,
        request_id_valid_format: isCredential(p.request_id),
        csrf_token_valid_format: isCredential(p.csrf_token),
        nonce_valid_format: isCredential(nonce),
        decision_value: p.decision,
      }))
      if (
        req.headers.origin !== config.issuer ||
        !isCredential(p.request_id) ||
        !isCredential(p.csrf_token) ||
        !isCredential(nonce) ||
        (p.decision !== 'approve' && p.decision !== 'deny')
      ) {
        res.status(403).json({ error: 'access_denied' })
        return
      }
      if (
        p.decision === 'approve' &&
        (!isCredential(p.owner_key) || !secretEquals(hash(p.owner_key), config.ownerKeyHash))
      ) {
        res.status(403).json({ error: 'access_denied' })
        return
      }
      const decision = await store.decideApproval(
        p.request_id,
        nonce,
        p.csrf_token,
        p.decision === 'approve',
      )
      console.error(JSON.stringify({
        event: 'authorize_debug_decide',
        decision_is_null: decision === null,
        redirect_in_allowlist: decision ? config.redirects.has(decision.redirectUri) : null,
      }))
      if (!decision || !config.redirects.has(decision.redirectUri)) {
        res.status(403).json({ error: 'access_denied' })
        return
      }
      res.clearCookie(COOKIE, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
      const url = new URL(decision.redirectUri)
      if (decision.code) url.searchParams.set('code', decision.code)
      else url.searchParams.set('error', 'access_denied')
      if (decision.state !== null) url.searchParams.set('state', decision.state)
      res.redirect(302, url.toString())
    }),
  )

  app.post(
    '/token',
    safe(async (req, res) => {
      const p = record(req.body)
      const validSecret = secretEquals(p.client_secret, config.clientSecret)
      if (p.client_id !== config.clientId || !validSecret) {
        res.status(401).json({ error: 'invalid_client' })
        return
      }
      const requestId = randomUUID()
      const base = (grantId: string) => ({
        timestamp: new Date(store.now() * 1000).toISOString(),
        request_id: requestId,
        grant_id: grantId,
      })
      let result: ExchangeResult
      if (p.grant_type === 'authorization_code') {
        if (
          !isCredential(p.code) ||
          !isVerifier(p.code_verifier) ||
          typeof p.redirect_uri !== 'string' ||
          !config.redirects.has(p.redirect_uri)
        ) {
          res.status(400).json({ error: 'invalid_grant' })
          return
        }
        if (p.resource !== undefined && p.resource !== config.resource) {
          res.status(400).json({ error: 'invalid_target' })
          return
        }
        result = await store.exchangeCode(
          p.code,
          config.clientId,
          p.redirect_uri,
          p.code_verifier,
          config.resource,
        )
      } else if (p.grant_type === 'refresh_token') {
        if (!isCredential(p.refresh_token)) {
          res.status(400).json({ error: 'invalid_grant' })
          return
        }
        if (p.scope !== undefined && typeof p.scope !== 'string') {
          res.status(400).json({ error: 'invalid_scope' })
          return
        }
        if (p.resource !== undefined && p.resource !== config.resource) {
          res.status(400).json({ error: 'invalid_target' })
          return
        }
        result = await store.refresh(
          p.refresh_token,
          config.clientId,
          config.resource,
          p.scope as string | undefined,
        )
      } else {
        res.status(400).json({ error: 'unsupported_grant_type' })
        return
      }
      if (result.kind === 'issued') {
        const grantId = result.grantId
        if (p.grant_type === 'refresh_token') {
          audit({
            ...base(grantId),
            event: 'refresh_rotation_committed',
            consumed_generation: result.generation - 1,
            issued_generation: result.generation,
          })
          let recorded = false
          const finished = (outcome: 'finished' | 'closed_prematurely') => {
            if (recorded) return
            recorded = true
            audit({ ...base(grantId), event: 'refresh_response', outcome })
          }
          res.once('finish', () => finished('finished'))
          res.once('close', () =>
            finished(res.writableFinished ? 'finished' : 'closed_prematurely'),
          )
          if (res.destroyed) finished('closed_prematurely')
        } else audit({ ...base(grantId), event: 'grant_issued' })
        res.json(result.pair)
      } else {
        if (result.kind === 'refresh_reuse') {
          audit({
            ...base(result.grantId),
            event: 'refresh_reuse_revoked',
            reused_generation: result.generation,
            rotation_to_reuse_seconds: result.interval,
          })
        } else if (result.kind === 'code_reuse') {
          audit({ ...base(result.grantId), event: 'authorization_code_reuse_revoked' })
        }
        res.status(400).json({ error: result.kind === 'scope' ? 'invalid_scope' : 'invalid_grant' })
      }
    }),
  )

  return async (req: Request, res: Response, next: NextFunction) => {
    noStore(res)
    const unauthorized = () => {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${config.issuer}/.well-known/oauth-protected-resource", error="invalid_token"`,
      )
      res.status(401).json({ error: 'Unauthorized' })
    }
    // Node may discard repeated Authorization headers; inspect the raw names too.
    const authorizationCount = req.rawHeaders
      .filter((_, index) => index % 2 === 0)
      .filter((name) => name.toLowerCase() === 'authorization').length
    const header = req.headers.authorization
    if (authorizationCount > 1 || typeof header !== 'string') {
      unauthorized()
      return
    }
    const match = /^Bearer ([^\s]+)$/i.exec(header)
    if (!match) {
      unauthorized()
      return
    }
    const token = match[1]
    if (store.now() < LEGACY_CUTOFF && secretEquals(token, config.legacyBearer)) {
      next()
      return
    }
    if (!isCredential(token)) {
      unauthorized()
      return
    }
    try {
      if (!(await store.accepts(token, config.clientId, config.resource))) {
        unauthorized()
        return
      }
    } catch {
      res.status(503).json({ error: 'server_error' })
      return
    }
    next()
  }
}
