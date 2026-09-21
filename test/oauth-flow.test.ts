import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Client, createClient } from '@libsql/client'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACCESS_TTL,
  CODE_TTL,
  GRANT_TTL,
  LEGACY_CUTOFF,
  oauthConfig,
  REFRESH_TTL,
} from '../src/auth/config.js'
import { challengeFor, hash, randomCredential } from '../src/auth/crypto.js'
import { type AuditEvent, registerOAuth, sanitizedHttpError } from '../src/auth/http.js'
import { migrateOAuth } from '../src/auth/schema.js'
import { type ExchangeResult, OAuthStore, type TokenPair } from '../src/auth/store.js'

// These modules do not import application env, Dexcom services, or the production DB.
const ownerKey = 'O'.repeat(43)
const legacy = 'L'.repeat(43)
const clientSecret = 'S'.repeat(43)
const clientId = 'synthetic-client'
const issuer = 'https://mcp.example.invalid'
const callback = 'https://client.example.invalid/callback?existing=1'
const verifier = 'V'.repeat(43)
const challenge = challengeFor(verifier)
const startTime = Date.parse('2026-09-20T12:00:00Z') / 1000
const settings = {
  OAUTH_CLIENT_ID: clientId,
  OAUTH_CLIENT_SECRET: clientSecret,
  OAUTH_OWNER_APPROVAL_KEY_SHA256: hash(ownerKey),
  OAUTH_ISSUER_URL: issuer,
  OAUTH_ALLOWED_REDIRECT_URIS: callback,
  MCP_AUTH_TOKEN: legacy,
}
const config = oauthConfig(settings, startTime)
let db: Client
let secondDb: Client
let store: OAuthStore
let secondStore: OAuthStore
let now: number
let directory: string
let origin: string
let events: AuditEvent[]
let dropRefreshResponse: boolean
let server: Server

beforeEach(async () => {
  now = startTime
  events = []
  dropRefreshResponse = false
  directory = await mkdtemp(join(tmpdir(), 'dexcom-oauth-test-'))
  db = createClient({ url: `file:${join(directory, 'isolated.db')}` })
  secondDb = createClient({ url: `file:${join(directory, 'isolated.db')}` })
  await migrateOAuth(db)
  store = new OAuthStore(
    () => db,
    () => now,
  )
  secondStore = new OAuthStore(
    () => secondDb,
    () => now,
  )
  const app = express()
  app.use(express.json({ limit: '16kb' }))
  app.use(express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 20 }))
  app.use((_req, res, next) => {
    const json = res.json.bind(res)
    res.json = (body) => {
      if (dropRefreshResponse && body?.refresh_token) {
        dropRefreshResponse = false
        res.destroy() // Commit succeeded; delivery fails before any response reaches the client.
        return res
      }
      return json(body)
    }
    next()
  })
  const requireAuth = registerOAuth(app, config, store, (event) => events.push(event))
  for (const method of ['get', 'post', 'delete'] as const) {
    app[method]('/mcp', requireAuth, (_req, res) => {
      res.json({ ok: true })
    })
  }
  app.use(sanitizedHttpError)
  server = createServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local test listener unavailable')
  origin = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  db?.close()
  secondDb?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

// Fetch can only target the ephemeral loopback listener. Redirects are never followed.
function request(path: string, init: RequestInit = {}) {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new Error('External test request prohibited')
  return fetch(`${origin}${path}`, { ...init, redirect: 'manual' })
}
function form(path: string, body: Record<string, string>, headers: Record<string, string> = {}) {
  return request(path, { method: 'POST', headers, body: new URLSearchParams(body) })
}
function token(body: Record<string, string>) {
  return form('/token', { client_id: clientId, client_secret: clientSecret, ...body })
}
async function approval(overrides: Record<string, string> = {}) {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callback,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'synthetic-state',
    ...overrides,
  })
  const response = await request(`/authorize?${query}`)
  const html = await response.text()
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1] ?? ''
  const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? ''
  return { response, html, cookie, requestId, csrf }
}
type Pending = Awaited<ReturnType<typeof approval>>
function decide(
  pending: Pending,
  fields: Record<string, string> = {},
  headers: Record<string, string> = {},
) {
  return form(
    '/authorize',
    {
      request_id: pending.requestId,
      csrf_token: pending.csrf,
      owner_key: ownerKey,
      decision: 'approve',
      ...fields,
    },
    { origin: issuer, cookie: pending.cookie, ...headers },
  )
}
async function code() {
  const pending = await approval()
  const approved = await decide(pending)
  expect(approved.status).toBe(302)
  const location = new URL(approved.headers.get('location') ?? '')
  expect(location.searchParams.get('existing')).toBe('1')
  expect(location.searchParams.get('state')).toBe('synthetic-state')
  return location.searchParams.get('code') as string
}
function exchange(value: string, overrides: Record<string, string> = {}) {
  return token({
    grant_type: 'authorization_code',
    code: value,
    redirect_uri: callback,
    code_verifier: verifier,
    ...overrides,
  })
}
async function connect() {
  const value = await code()
  const response = await exchange(value)
  expect(response.status).toBe(200)
  return { code: value, pair: (await response.json()) as TokenPair }
}
function refresh(value: string, overrides: Record<string, string> = {}) {
  return token({ grant_type: 'refresh_token', refresh_token: value, ...overrides })
}
function mcp(value: string, method = 'POST') {
  return request('/mcp', { method, headers: { authorization: `Bearer ${value}` } })
}

async function race(operation: 'code' | 'refresh', args: string[]): Promise<ExchangeResult[]> {
  const workers = [0, 1].map(() =>
    fork(new URL('./helpers/oauth-race-worker.mjs', import.meta.url), {
      execArgv: ['--import', 'tsx'],
      env: { PATH: process.env.PATH, TMPDIR: tmpdir() },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    }),
  )
  try {
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            worker.once('error', reject)
            worker.once('exit', (code) => {
              if (code) reject(new Error(`Worker preparation exited ${code}`))
            })
            worker.once('message', (message: { ready?: boolean; error?: string }) => {
              if (message.ready) resolve()
              else reject(new Error(message.error))
            })
            worker.send({ operation: 'prepare', url: `file:${join(directory, 'isolated.db')}` })
          }),
      ),
    )
    return await Promise.all(
      workers.map(
        (worker) =>
          new Promise<ExchangeResult>((resolve, reject) => {
            worker.once('message', (message: { result?: ExchangeResult; error?: string }) => {
              if (message.result) resolve(message.result)
              else reject(new Error(message.error))
            })
            worker.send({ operation, args, now })
          }),
      ),
    )
  } finally {
    for (const worker of workers) worker.kill()
  }
}

describe('approval, discovery and PKCE over isolated Express HTTP', () => {
  it('advertises S256, refresh, offline access and the configured issuer, ignoring Host', async () => {
    const result = await request('/.well-known/oauth-authorization-server', {
      headers: { host: 'attacker.invalid' },
    })
    expect(await result.json()).toMatchObject({
      issuer,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      scopes_supported: ['offline_access'],
    })
    expect(await (await request('/.well-known/oauth-protected-resource')).json()).toEqual({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
    })
  })
  it('requires owner approval, creates no code on GET, and hardens the page and cookie', async () => {
    const pending = await approval()
    expect(pending.response.status).toBe(200)
    expect(pending.response.headers.get('location')).toBeNull()
    expect(pending.response.headers.get('set-cookie')).toMatch(
      /__Host-mcp-approval=.*HttpOnly; Secure; SameSite=Lax/,
    )
    expect(pending.response.headers.get('cache-control')).toBe('no-store')
    expect(pending.response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(pending.response.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    )
    expect(pending.html).toContain('baseline writes')
    expect(pending.html).not.toContain(ownerKey)
    expect((await db.execute('SELECT * FROM mcp_oauth_codes')).rows).toHaveLength(0)
  })
  it('sets the approval form-action to the exact configured origin instead of self', async () => {
    const pending = await approval()
    expect(pending.response.status).toBe(200)
    expect(pending.response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; form-action https://mcp.example.invalid; frame-ancestors 'none'; base-uri 'none'",
    )
  })
  it.each([
    'https://attacker.invalid',
    `${callback}&extra=1`,
    `${callback}#fragment`,
    callback.replace('/callback', '/callback/'),
    callback.replace('client.', 'CLIENT.'),
  ])('rejects exact redirect mismatch %s', async (uri) => {
    const pending = await approval({ redirect_uri: uri, client_id: 'wrong' })
    expect(pending.response.status).toBe(400)
    expect(JSON.parse(pending.html).error).toBe('invalid_request')
    expect(pending.response.headers.get('location')).toBeNull()
  })
  it.each([
    { code_challenge_method: 'plain' },
    { code_challenge_method: '' },
    { code_challenge: '' },
    { code_challenge: 'A'.repeat(42) },
    { code_challenge: `${'A'.repeat(42)}B` },
  ])('rejects missing, downgraded or malformed PKCE %j', async (fields) => {
    expect((await approval(fields)).response.status).toBe(400)
  })
  it('rejects duplicate query parameters and invalid client/response/scope/resource', async () => {
    expect(
      (
        await request(
          `/authorize?redirect_uri=${encodeURIComponent(callback)}&redirect_uri=${encodeURIComponent(callback)}`,
        )
      ).status,
    ).toBe(400)
    expect((await approval({ client_id: 'wrong' })).response.status).toBe(401)
    expect((await approval({ response_type: 'token' })).response.status).toBe(400)
    expect((await approval({ scope: 'admin' })).response.status).toBe(400)
    expect((await approval({ resource: 'https://other.invalid/mcp' })).response.status).toBe(400)
  })
  it.each([
    '',
    clientSecret,
    legacy,
    randomCredential(),
  ])('rejects a non-owner credential without issuing a code', async (key) => {
    const pending = await approval()
    expect((await decide(pending, { owner_key: key })).status).toBe(403)
    expect((await db.execute('SELECT * FROM mcp_oauth_codes')).rows).toHaveLength(0)
  })
  it('approves with absent or null Origin when CSRF, cookie nonce, and owner key are valid', async () => {
    for (const originHeader of [undefined, 'null']) {
      const pending = await approval()
      const headers: Record<string, string> = { cookie: pending.cookie }
      if (originHeader !== undefined) headers.origin = originHeader
      const response = await form(
        '/authorize',
        {
          request_id: pending.requestId,
          csrf_token: pending.csrf,
          owner_key: ownerKey,
          decision: 'approve',
        },
        headers,
      )
      expect(response.status).toBe(302)
      const location = new URL(response.headers.get('location') ?? '')
      expect(location.searchParams.get('state')).toBe('synthetic-state')
      const value = location.searchParams.get('code')
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect((await exchange(value as string)).status).toBe(200)
    }
  })
  it('rejects a foreign Origin even when CSRF, cookie nonce, and owner key are valid', async () => {
    const pending = await approval()
    const response = await decide(pending, {}, { origin: 'https://evil.com' })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'access_denied' })
    expect(response.headers.get('location')).toBeNull()
    // Rejection must not consume an otherwise valid approval request.
    expect((await decide(pending)).status).toBe(302)
  })
  it('rejects empty or foreign Origin, missing cookie, and mismatched CSRF/browser binding', async () => {
    const pending = await approval()
    for (const headers of [
      { origin: '' },
      { origin: 'https://attacker.invalid' },
      { cookie: '' },
      { cookie: `__Host-mcp-approval=${randomCredential()}` },
    ]) {
      expect((await decide(pending, {}, headers)).status).toBe(403)
    }
    expect((await decide(pending, { csrf_token: randomCredential() })).status).toBe(403)
    const other = await approval()
    expect((await decide(pending, { request_id: other.requestId })).status).toBe(403)
  })
  it('binds parameters in storage, ignores substituted form parameters, and consumes approval once', async () => {
    const pending = await approval()
    const result = await decide(pending, {
      redirect_uri: 'https://attacker.invalid',
      code_challenge: challengeFor('X'.repeat(43)),
    })
    expect(result.headers.get('location')).toContain(callback)
    expect((await decide(pending)).status).toBe(403)
    const value = new URL(result.headers.get('location') as string).searchParams.get(
      'code',
    ) as string
    expect((await exchange(value)).status).toBe(200)
  })
  it('denies without creating a code, preserving state only at the validated callback', async () => {
    const pending = await approval()
    const result = await decide(pending, { decision: 'deny', owner_key: '' })
    const location = new URL(result.headers.get('location') as string)
    expect(location.searchParams.get('error')).toBe('access_denied')
    expect(location.searchParams.get('state')).toBe('synthetic-state')
    expect(location.searchParams.has('code')).toBe(false)
    expect((await db.execute('SELECT * FROM mcp_oauth_codes')).rows).toHaveLength(0)
  })
  it('expires approvals at 600 seconds; starts code TTL at approval rather than GET', async () => {
    const stale = await approval()
    now += 600
    expect((await decide(stale)).status).toBe(403)
    const pending = await approval()
    now += 599
    const result = await decide(pending)
    const value = new URL(result.headers.get('location') as string).searchParams.get(
      'code',
    ) as string
    now += 59
    expect((await exchange(value)).status).toBe(200)
  })
  it('stores only credential hashes and issues independent 32-byte code/access/refresh values', async () => {
    const { code: value, pair } = await connect()
    for (const credential of [value, pair.access_token, pair.refresh_token]) {
      expect(Buffer.from(credential, 'base64url')).toHaveLength(32)
    }
    expect(
      new Set([value, pair.access_token, pair.refresh_token, ownerKey, legacy, clientSecret]).size,
    ).toBe(6)
    const data = []
    for (const table of [
      'approval_requests',
      'codes',
      'grants',
      'refresh_tokens',
      'access_tokens',
    ]) {
      data.push((await db.execute(`SELECT * FROM mcp_oauth_${table}`)).rows)
    }
    const serialized = JSON.stringify(data)
    for (const secret of [
      value,
      pair.access_token,
      pair.refresh_token,
      ownerKey,
      legacy,
      clientSecret,
      verifier,
    ]) {
      expect(serialized).not.toContain(secret)
    }
    expect(serialized).toContain(hash(pair.refresh_token))
    expect(serialized).toContain(hash(pair.access_token))
  })
  it.each([
    { code_verifier: 'X'.repeat(43) },
    { code_verifier: '' },
    { code_verifier: 'a'.repeat(129) },
    { code_verifier: 'é'.repeat(43) },
    { redirect_uri: `${callback}&x=1` },
    { client_id: 'wrong' },
    { client_secret: 'wrong' },
  ])('rejects mismatched code binding %j without consuming it', async (fields) => {
    const value = await code()
    expect((await exchange(value, fields)).status).toBeGreaterThanOrEqual(400)
    expect((await exchange(value)).status).toBe(200)
  })
  it('rejects legacy bearer as an authorization code and malformed/duplicate form inputs', async () => {
    expect((await exchange(legacy)).status).toBe(400)
    expect((await request('/token', { method: 'POST' })).status).toBe(401)
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    })
    body.append('client_secret', clientSecret)
    expect((await request('/token', { method: 'POST', body })).status).toBe(401)
  })
  it('expires an unused code at exactly 60 seconds', async () => {
    const value = await code()
    now += CODE_TTL
    const result = await exchange(value)
    expect(result.status).toBe(400)
    expect(await result.json()).toEqual({ error: 'invalid_grant' })
  })
})

describe('atomic exchange, rotating refresh and grant-wide revocation', () => {
  it('refreshes using only form credentials and refresh_token, preserving concurrent access', async () => {
    const { pair } = await connect()
    now += 55 * 60
    const response = await refresh(pair.refresh_token)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('pragma')).toBe('no-cache')
    const next = (await response.json()) as TokenPair
    expect(next).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'offline_access' })
    expect(next.refresh_token).not.toBe(pair.refresh_token)
    expect((await mcp(pair.access_token)).status).toBe(200)
    expect((await mcp(next.access_token)).status).toBe(200)
    expect((await mcp(next.refresh_token)).status).toBe(401)
  })
  it('serializes concurrent code redemption across two independent processes, then revokes on proven replay', async () => {
    const value = await code()
    const outcomes = await race('code', [value, clientId, callback, verifier, config.resource])
    expect(outcomes.map((r) => r.kind).sort()).toEqual(['code_reuse', 'issued'])
    expect((await db.execute('SELECT * FROM mcp_oauth_grants')).rows).toHaveLength(1)
    expect((await db.execute('SELECT * FROM mcp_oauth_access_tokens')).rows).toHaveLength(1)
    const issued = outcomes.find((r) => r.kind === 'issued')
    if (issued?.kind !== 'issued') throw new Error('Missing issued outcome')
    expect(await store.accepts(issued.pair.access_token, clientId, config.resource)).toBe(false)
  })
  it('serializes concurrent refreshes across two independent processes and revokes every descendant', async () => {
    const { pair } = await connect()
    const outcomes = await race('refresh', [pair.refresh_token, clientId, config.resource])
    expect(outcomes.map((r) => r.kind).sort()).toEqual(['issued', 'refresh_reuse'])
    const issued = outcomes.find((r) => r.kind === 'issued')
    if (issued?.kind !== 'issued') throw new Error('Missing issued outcome')
    expect((await mcp(pair.access_token)).status).toBe(401)
    expect((await mcp(issued.pair.access_token)).status).toBe(401)
    expect((await refresh(issued.pair.refresh_token)).status).toBe(400)
    expect((await db.execute('SELECT * FROM mcp_oauth_refresh_tokens')).rows).toHaveLength(2)
  })
  it('simulates a lost committed response, revokes on retry, and reconnects into a fresh independent grant', async () => {
    const { pair } = await connect()
    dropRefreshResponse = true
    await expect(refresh(pair.refresh_token)).rejects.toThrow()
    await vi.waitFor(() =>
      expect(
        events.some((e) => e.event === 'refresh_response' && e.outcome === 'closed_prematurely'),
      ).toBe(true),
    )
    now += 2
    const replay = await refresh(pair.refresh_token)
    expect(replay.status).toBe(400)
    expect(await replay.json()).toEqual({ error: 'invalid_grant' })
    expect((await mcp(pair.access_token)).status).toBe(401)
    const fresh = await connect()
    expect((await mcp(fresh.pair.access_token)).status).toBe(200)
    expect((await refresh(fresh.pair.refresh_token)).status).toBe(200)
    const grants = await store.listGrants()
    expect(grants).toHaveLength(2)
    expect(grants.filter((g) => g.revoked_at !== null)).toHaveLength(1)
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'refresh_reuse_revoked',
        reused_generation: 0,
        rotation_to_reuse_seconds: 2,
      }),
    )
  })
  it('does not revoke on wrong client credentials, unknown tokens or invalid scope/resource', async () => {
    const { pair } = await connect()
    const rotated = (await (await refresh(pair.refresh_token)).json()) as TokenPair
    expect((await refresh(pair.refresh_token, { client_secret: 'wrong' })).status).toBe(401)
    expect((await refresh(pair.refresh_token, { client_id: 'wrong' })).status).toBe(401)
    expect((await refresh(randomCredential())).status).toBe(400)
    expect((await refresh(rotated.refresh_token, { scope: 'admin' })).status).toBe(400)
    expect(
      (await refresh(rotated.refresh_token, { resource: 'https://attacker.invalid/mcp' })).status,
    ).toBe(400)
    expect((await mcp(rotated.access_token)).status).toBe(200)
    expect((await refresh(rotated.refresh_token)).status).toBe(200)
  })
  it('revokes the entire refresh family on proven authorization-code reuse, even after code expiry', async () => {
    const { code: value, pair } = await connect()
    const next = (await (await refresh(pair.refresh_token)).json()) as TokenPair
    now += CODE_TTL
    expect((await exchange(value, { code_verifier: 'X'.repeat(43) })).status).toBe(400)
    expect((await mcp(next.access_token)).status).toBe(200)
    expect((await exchange(value)).status).toBe(400)
    expect((await refresh(next.refresh_token)).status).toBe(400)
    expect((await mcp(next.access_token)).status).toBe(401)
  })
  it('rolls back code consumption and all issuance on insert failure', async () => {
    const value = await code()
    await db.execute(
      `CREATE TRIGGER fail_refresh BEFORE INSERT ON mcp_oauth_refresh_tokens BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`,
    )
    expect((await exchange(value)).status).toBe(503)
    expect(
      (await db.execute('SELECT consumed_at FROM mcp_oauth_codes')).rows[0].consumed_at,
    ).toBeNull()
    expect((await db.execute('SELECT * FROM mcp_oauth_grants')).rows).toHaveLength(0)
    expect((await db.execute('SELECT * FROM mcp_oauth_access_tokens')).rows).toHaveLength(0)
    await db.execute('DROP TRIGGER fail_refresh')
    expect((await exchange(value)).status).toBe(200)
  })
  it('rolls back rotation on insertion failure without consuming the current refresh credential', async () => {
    const { pair } = await connect()
    await db.execute(
      `CREATE TRIGGER fail_refresh BEFORE INSERT ON mcp_oauth_refresh_tokens BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`,
    )
    expect((await refresh(pair.refresh_token)).status).toBe(503)
    await db.execute('DROP TRIGGER fail_refresh')
    expect((await refresh(pair.refresh_token)).status).toBe(200)
  })
  it('allows operator revocation by grant ID and invalidates all descendants immediately', async () => {
    const { pair } = await connect()
    const rotated = (await (await refresh(pair.refresh_token)).json()) as TokenPair
    const grant = (await store.listGrants())[0]
    expect(await store.revokeGrant(String(grant.grant_id))).toBe(true)
    expect((await mcp(pair.access_token)).status).toBe(401)
    expect((await mcp(rotated.access_token)).status).toBe(401)
    expect((await refresh(rotated.refresh_token)).status).toBe(400)
    expect(await store.revokeGrant('nonexistent')).toBe(false)
  })
})

describe('expiry, cleanup, legacy cutoff and diagnostics', () => {
  it.each([
    'GET',
    'POST',
    'DELETE',
  ])('enforces access expiry and grant revocation on %s /mcp', async (method) => {
    const { pair } = await connect()
    now += ACCESS_TTL - 1
    expect((await mcp(pair.access_token, method)).status).toBe(200)
    now++
    const expired = await mcp(pair.access_token, method)
    expect(expired.status).toBe(401)
    expect(expired.headers.get('www-authenticate')).toContain('resource_metadata=')
    const rotated = (await (await refresh(pair.refresh_token)).json()) as TokenPair
    expect((await mcp(rotated.access_token, method)).status).toBe(200)
    await store.revokeGrant(String((await store.listGrants())[0].grant_id))
    expect((await mcp(rotated.access_token, method)).status).toBe(401)
  })
  it('expires an unused refresh token at seven days', async () => {
    const { pair } = await connect()
    now += REFRESH_TTL
    const result = await refresh(pair.refresh_token)
    expect(result.status).toBe(400)
    expect(await result.json()).toEqual({ error: 'invalid_grant' })
  })
  it('renews within seven days but never extends the absolute 30-day grant, and caps expires_in', async () => {
    let { pair } = await connect()
    for (let day = 6; day <= 24; day += 6) {
      now = startTime + day * 86400
      const result = await refresh(pair.refresh_token)
      expect(result.status).toBe(200)
      pair = (await result.json()) as TokenPair
    }
    now = startTime + GRANT_TTL - 60
    pair = (await (await refresh(pair.refresh_token)).json()) as TokenPair
    expect(pair.expires_in).toBe(60)
    const grant = (await store.listGrants())[0]
    expect(grant.expires_at).toBe(startTime + GRANT_TTL)
    const tokens = (
      await db.execute('SELECT expires_at FROM mcp_oauth_refresh_tokens ORDER BY generation DESC')
    ).rows
    expect(tokens[0].expires_at).toBe(grant.expires_at)
    now = startTime + GRANT_TTL
    expect((await refresh(pair.refresh_token)).status).toBe(400)
    expect((await mcp(pair.access_token)).status).toBe(401)
  })
  it('retains consumed hashes for replay detection and cleans safely after grant expiry', async () => {
    const { pair } = await connect()
    const next = (await (await refresh(pair.refresh_token)).json()) as TokenPair
    now += 86400
    await store.cleanup()
    expect((await db.execute('SELECT * FROM mcp_oauth_codes')).rows).toHaveLength(1)
    expect((await db.execute('SELECT * FROM mcp_oauth_refresh_tokens')).rows).toHaveLength(2)
    expect((await refresh(pair.refresh_token)).status).toBe(400)
    expect((await refresh(next.refresh_token)).status).toBe(400)
    now = startTime + GRANT_TTL
    await store.cleanup()
    for (const table of ['codes', 'grants', 'refresh_tokens', 'access_tokens']) {
      expect((await db.execute(`SELECT * FROM mcp_oauth_${table}`)).rows).toHaveLength(0)
    }
  })
  it.each([
    'GET',
    'POST',
    'DELETE',
  ])('accepts legacy only before October 4 on %s and never renews it', async (method) => {
    now = LEGACY_CUTOFF - 1
    expect((await mcp(legacy, method)).status).toBe(200)
    now = LEGACY_CUTOFF
    expect((await mcp(legacy, method)).status).toBe(401)
    expect((await exchange(legacy)).status).toBe(400)
    expect((await refresh(legacy)).status).toBe(400)
    const restarted = new OAuthStore(
      () => secondDb,
      () => now,
    )
    expect(await restarted.accepts(legacy, clientId, config.resource)).toBe(false)
    expect(
      oauthConfig({ ...settings, MCP_AUTH_TOKEN: undefined }, now).legacyBearer,
    ).toBeUndefined()
  })
  it('persists issued-token validity across a new store/connection and fails closed on database failure', async () => {
    const { pair } = await connect()
    expect(await secondStore.accepts(pair.access_token, clientId, config.resource)).toBe(true)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(db, 'execute').mockRejectedValue(
      new Error(`sensitive-driver-error ${pair.access_token}`),
    )
    expect((await mcp(pair.access_token)).status).toBe(503)
    expect(log).not.toHaveBeenCalled()
  })
  it('rejects duplicate Authorization headers even if Node selects the first valid one', async () => {
    const { pair } = await connect()
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = httpRequest(
        `${origin}/mcp`,
        {
          method: 'POST',
          headers: { Authorization: [`Bearer ${pair.access_token}`, 'Bearer attacker'] },
        },
        (response) => {
          response.resume()
          resolve(response.statusCode)
        },
      )
      outgoing.on('error', reject)
      outgoing.end()
    })
    expect(status).toBe(401)
  })

  it('scrubs parser and database errors from responses and logs, even when errors contain secrets', async () => {
    const { pair } = await connect()
    const logging = vi.spyOn(console, 'error').mockImplementation(() => {})
    const malformed = await request('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"secret":"${clientSecret}"`,
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'invalid_request' })
    vi.spyOn(store, 'refresh').mockRejectedValue(
      new Error(`driver query parameters ${pair.refresh_token} ${clientSecret}`),
    )
    const failed = await refresh(pair.refresh_token)
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({ error: 'server_error' })
    expect(logging).not.toHaveBeenCalled()
  })

  it('enforces individual access-token revocation without revoking the refresh grant', async () => {
    const { pair } = await connect()
    await db.execute({
      sql: 'UPDATE mcp_oauth_access_tokens SET revoked_at = ? WHERE token_hash = ?',
      args: [now, hash(pair.access_token)],
    })
    expect((await mcp(pair.access_token)).status).toBe(401)
    expect((await refresh(pair.refresh_token)).status).toBe(200)
  })

  it('rolls back replay revocation on database failure and never logs a successful revocation prematurely', async () => {
    const { pair } = await connect()
    const next = (await (await refresh(pair.refresh_token)).json()) as TokenPair
    await db.execute(
      `CREATE TRIGGER fail_revocation BEFORE UPDATE OF revoked_at ON mcp_oauth_grants BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`,
    )
    expect((await refresh(pair.refresh_token)).status).toBe(503)
    expect(events.some((event) => event.event === 'refresh_reuse_revoked')).toBe(false)
    await db.execute('DROP TRIGGER fail_revocation')
    expect((await refresh(pair.refresh_token)).status).toBe(400)
    expect((await mcp(next.access_token)).status).toBe(401)
    expect(events.some((event) => event.event === 'refresh_reuse_revoked')).toBe(true)
  })

  it('emits only the approved diagnostic fields and never logs token/secret/header material', async () => {
    const { code: value, pair } = await connect()
    now++
    const next = (await (await refresh(pair.refresh_token)).json()) as TokenPair
    now++
    await refresh(pair.refresh_token)
    await vi.waitFor(() => expect(events.some((e) => e.event === 'refresh_response')).toBe(true))
    const fields: Record<AuditEvent['event'], string[]> = {
      grant_issued: [],
      authorization_code_reuse_revoked: [],
      refresh_rotation_committed: ['consumed_generation', 'issued_generation'],
      refresh_reuse_revoked: ['reused_generation', 'rotation_to_reuse_seconds'],
      refresh_response: ['outcome'],
    }
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(
        ['event', 'timestamp', 'request_id', 'grant_id', ...fields[event.event]].sort(),
      )
      expect(event.grant_id).toMatch(/^[a-f0-9-]{36}$/)
      expect(event.request_id).toMatch(/^[a-f0-9-]{36}$/)
    }
    const serialized = JSON.stringify(events)
    for (const secret of [
      value,
      pair.access_token,
      pair.refresh_token,
      next.access_token,
      next.refresh_token,
      ownerKey,
      legacy,
      clientSecret,
      verifier,
    ]) {
      expect(serialized).not.toContain(secret)
      expect(serialized).not.toContain(hash(secret))
      expect(serialized).not.toContain(secret.slice(0, 12))
    }
    expect(serialized).not.toContain(callback)
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'refresh_response', outcome: 'finished' }),
    )
  })
})
