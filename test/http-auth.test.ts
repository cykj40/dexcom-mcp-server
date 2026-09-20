import { timingSafeEqual } from 'node:crypto'
import type { RequestHandler } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hash } from '../src/auth/crypto.js'

// No actual environment, database, Dexcom service, MCP transport, or listener is loaded.
const harness = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  routes: new Map<string, RequestHandler[]>(),
  registrations: [] as string[],
  migrate: vi.fn(async () => {}),
  initializeTokens: vi.fn(async () => {}),
  connect: vi.fn(async () => {}),
  listen: vi.fn(),
}))

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) }
})
vi.mock('../src/config/env.js', () => ({ env: harness.env }))
vi.mock('../src/db/database.js', () => ({
  closeDb: vi.fn(),
  getDb: vi.fn(() => {
    throw new Error('No database in boot tests')
  }),
}))
vi.mock('../src/auth/store.js', () => ({
  OAuthStore: class {
    cleanup = vi.fn(async () => {})
    now = () => 1789862400
  },
}))
vi.mock('../src/db/migrations.js', () => ({ runMigrations: harness.migrate }))
vi.mock('../src/services/dexcom-api.service.js', () => ({
  initializeTokens: harness.initializeTokens,
}))
vi.mock('../src/tools/index.js', () => ({ registerAllTools: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    connect = harness.connect
    close = vi.fn()
  },
}))
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}))
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: class {
    handleRequest = vi.fn()
  },
}))
vi.mock('express', () => {
  const jsonMiddleware = vi.fn()
  const urlencodedMiddleware = vi.fn()
  const register =
    (method: string) =>
    (path: string, ...handlers: RequestHandler[]) => {
      harness.registrations.push(`${method} ${path}`)
      harness.routes.set(`${method} ${path}`, handlers)
    }
  return {
    default: Object.assign(
      () => ({
        disable: vi.fn(),
        use: vi.fn((middleware: RequestHandler) => {
          if (middleware === jsonMiddleware) harness.registrations.push('express.json')
          if (middleware === urlencodedMiddleware) harness.registrations.push('express.urlencoded')
        }),
        get: register('GET'),
        post: register('POST'),
        delete: register('DELETE'),
        listen: harness.listen,
      }),
      {
        json: vi.fn(() => jsonMiddleware),
        urlencoded: vi.fn(() => urlencodedMiddleware),
      },
    ),
  }
})

const callback = 'https://client.example.invalid/callback?flow=one'
const otherCallback = 'https://other.example.invalid/callback'
const bearer = 'synthetic-mcp-bearer'
const clientSecret = 'synthetic-client-secret'
const clientId = 'synthetic-client-id'
const validEnv = {
  TRANSPORT: 'http',
  MCP_AUTH_TOKEN: bearer,
  OAUTH_CLIENT_ID: clientId,
  OAUTH_ISSUER_URL: 'https://server.example.invalid',
  OAUTH_OWNER_APPROVAL_KEY_SHA256: hash('A'.repeat(43)),
  OAUTH_CLIENT_SECRET: clientSecret,
  OAUTH_ALLOWED_REDIRECT_URIS: ` ${callback}, ${otherCallback} `,
}

const signals = ['SIGINT', 'SIGTERM'] as const
let originalListeners: Map<string, ReturnType<typeof process.listeners>>

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  harness.routes.clear()
  harness.registrations.length = 0
  Object.assign(harness.env, validEnv)
  originalListeners = new Map(signals.map((signal) => [signal, process.listeners(signal)]))
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-20T00:00:00Z'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // Only main().catch reaches this mock for startup validation failures.
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network access is prohibited in HTTP auth tests')
    }),
  )
})

afterEach(() => {
  for (const signal of signals) {
    for (const listener of process.listeners(signal)) {
      if (!originalListeners.get(signal)?.includes(listener)) {
        process.removeListener(signal, listener)
      }
    }
  }
  expect(fetch).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function boot(overrides: Record<string, string | undefined> = {}) {
  Object.assign(harness.env, overrides)
  const entrypoint = await import('../src/index.js')
  await vi.waitFor(() => {
    if (harness.env.TRANSPORT === 'http') {
      expect(harness.listen.mock.calls.length + vi.mocked(process.exit).mock.calls.length).toBe(1)
    } else {
      expect(harness.connect).toHaveBeenCalledOnce()
    }
  })
  return entrypoint
}

function expectBootRejected() {
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(1)
  expect(harness.migrate).not.toHaveBeenCalled()
  expect(harness.initializeTokens).not.toHaveBeenCalled()
  expect(harness.connect).not.toHaveBeenCalled()
  expect(harness.listen).not.toHaveBeenCalled()
  expect(harness.routes.size).toBe(0)
}

describe('HTTP startup validation', () => {
  for (const name of [
    'MCP_AUTH_TOKEN',
    'OAUTH_CLIENT_ID',
    'OAUTH_CLIENT_SECRET',
    'OAUTH_ALLOWED_REDIRECT_URIS',
    'OAUTH_ISSUER_URL',
    'OAUTH_OWNER_APPROVAL_KEY_SHA256',
  ]) {
    it.each([undefined, '', ' \t\n '])(`rejects %s for required setting ${name}`, async (value) => {
      await boot({ [name]: value })
      expectBootRejected()
      const error = vi.mocked(console.error).mock.calls[0]?.[1]
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(name)
    })
  }

  it.each([
    [',', ''],
    [`${callback},`, ''],
    [`,${callback}`, ''],
    [`${callback},not-a-url`, 'not-a-url'],
    [`${callback},/relative-callback`, '/relative-callback'],
    [`${callback},https://[broken`, 'https://[broken'],
  ])('rejects malformed allowlist %s before side effects', async (list, offendingEntry) => {
    await boot({ OAUTH_ALLOWED_REDIRECT_URIS: list })
    expectBootRejected()
    const error = vi.mocked(console.error).mock.calls[0]?.[1]
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      `Invalid OAUTH_ALLOWED_REDIRECT_URIS entry: ${JSON.stringify(offendingEntry)}`,
    )
  })

  it.each([
    'not-a-hash',
    'A'.repeat(64),
    hash(clientSecret),
    hash(bearer),
    hash(clientId),
  ])('rejects malformed/reused owner-key digest before startup side effects', async (digest) => {
    await boot({ OAUTH_OWNER_APPROVAL_KEY_SHA256: digest })
    expectBootRejected()
  })

  it.each([
    'http://server.example.invalid',
    'https://server.example.invalid/',
    'https://server.example.invalid/path',
    'https://user:pass@server.example.invalid',
    'not a url',
  ])('rejects invalid canonical issuer %s before startup side effects', async (issuer) => {
    await boot({ OAUTH_ISSUER_URL: issuer })
    expectBootRejected()
  })

  it('starts HTTP with a valid list', async () => {
    await boot()
    expect(process.exit).not.toHaveBeenCalled()
    expect(harness.migrate).toHaveBeenCalledOnce()
    expect(harness.initializeTokens).toHaveBeenCalledOnce()
    expect(harness.listen).toHaveBeenCalledOnce()
  })

  it('registers both body parsers before the token route', async () => {
    await boot()
    const tokenRoute = harness.registrations.indexOf('POST /token')
    expect(harness.registrations.indexOf('express.json')).toBeLessThan(tokenRoute)
    expect(harness.registrations.indexOf('express.urlencoded')).toBeLessThan(tokenRoute)
  })

  it.each([
    'stdio',
    undefined,
  ])('does not require HTTP settings for transport %s', async (transport) => {
    await boot({
      TRANSPORT: transport,
      MCP_AUTH_TOKEN: undefined,
      OAUTH_CLIENT_SECRET: undefined,
      OAUTH_ALLOWED_REDIRECT_URIS: undefined,
    })
    expect(process.exit).not.toHaveBeenCalled()
    expect(harness.listen).not.toHaveBeenCalled()
  })
})

// Guards http.ts:206-207: validSecret is computed unconditionally, so a wrong
// client_id must not short-circuit the client_secret comparison away.
describe('token endpoint constant-time client authentication', () => {
  async function postToken(body: Record<string, unknown>) {
    await boot()
    const handlers = harness.routes.get('POST /token')
    expect(handlers).toHaveLength(1)
    const response = {
      headersSent: false,
      setHeader: vi.fn(),
      status: vi.fn(() => response),
      json: vi.fn(() => response),
    }
    vi.mocked(timingSafeEqual).mockClear()
    await (handlers?.[0] as unknown as (q: unknown, s: unknown, n: unknown) => Promise<void>)(
      { body, query: {}, headers: {}, rawHeaders: [] },
      response,
      vi.fn(),
    )
    const comparedSecrets = vi
      .mocked(timingSafeEqual)
      .mock.calls.filter(([, configured]) =>
        Buffer.from(configured).equals(Buffer.from(clientSecret, 'utf8')),
      )
    return { response, comparedSecrets }
  }

  it.each([
    { id: clientId, status: 400, label: 'a correct client_id' },
    { id: 'wrong-client', status: 401, label: 'a wrong client_id' },
    { id: undefined, status: 401, label: 'a missing client_id' },
    { id: clientId.slice(0, -1), status: 401, label: 'a truncated client_id' },
  ])('compares the client secret given $label', async ({ id, status }) => {
    const { response, comparedSecrets } = await postToken({
      grant_type: 'refresh_token',
      client_id: id,
      client_secret: clientSecret,
    })
    // The branch taken differs, but the secret comparison runs exactly once either way.
    expect(response.status).toHaveBeenCalledWith(status)
    expect(comparedSecrets).toHaveLength(1)
    const [supplied, configured] = comparedSecrets[0]
    expect(supplied.byteLength).toBe(configured.byteLength)
  })

  it('compares the client secret even when it is absent and the client_id is wrong', async () => {
    const { response, comparedSecrets } = await postToken({
      grant_type: 'refresh_token',
      client_id: 'wrong-client',
    })
    expect(response.status).toHaveBeenCalledWith(401)
    expect(comparedSecrets).toHaveLength(1)
  })
})

describe('secret comparison', () => {
  it.each([
    { candidate: '', expected: undefined, valid: false, comparisons: 0 },
    { candidate: '', expected: '', valid: false, comparisons: 0 },
    { candidate: 'secret', expected: undefined, valid: false, comparisons: 0 },
    { candidate: 'secret', expected: '', valid: false, comparisons: 0 },
    ...[undefined, null, '', {}, ['secret'], 'secreT', 'secre', 'secret0', 'secret\0'].map(
      (candidate) => ({ candidate, expected: 'secret', valid: false, comparisons: 1 }),
    ),
    { candidate: 'secre', expected: 'secre\0', valid: false, comparisons: 1 },
    { candidate: 'secret', expected: 'secret', valid: true, comparisons: 1 },
    { candidate: 'é', expected: 'é', valid: true, comparisons: 1 },
    { candidate: 'é', expected: 'aa', valid: false, comparisons: 1 },
  ])('checks $candidate against $expected', async ({ candidate, expected, valid, comparisons }) => {
    const { secretEquals } = await boot()
    vi.mocked(timingSafeEqual).mockClear()
    expect(secretEquals(candidate, expected)).toBe(valid)
    expect(timingSafeEqual).toHaveBeenCalledTimes(comparisons)
    for (const [supplied, configured] of vi.mocked(timingSafeEqual).mock.calls) {
      expect(Buffer.isBuffer(supplied)).toBe(true)
      expect(Buffer.isBuffer(configured)).toBe(true)
      expect(supplied.byteLength).toBe(configured.byteLength)
    }
  })
})
