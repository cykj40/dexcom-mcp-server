import { timingSafeEqual } from 'node:crypto'
import type { Request, RequestHandler, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('../src/db/database.js', () => ({ closeDb: vi.fn() }))
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

function invoke(route: string, request: Partial<Request>) {
  const handlers = harness.routes.get(route)
  if (!handlers) throw new Error(`Missing handler: ${route}`)
  const [method, path] = route.split(' ')
  const headers = request.headers ?? {}
  const normalizedRequest = {
    method,
    path,
    query: {},
    body: undefined,
    ...request,
    headers,
    get: (name: string) => {
      const value = headers[name.toLowerCase() as keyof typeof headers]
      return typeof value === 'string' ? value : undefined
    },
  } as unknown as Request
  const response = { statusCode: 200 } as {
    statusCode: number
    status: ReturnType<typeof vi.fn>
    json: ReturnType<typeof vi.fn>
    redirect: ReturnType<typeof vi.fn>
    setHeader: ReturnType<typeof vi.fn>
  }
  response.status = vi.fn((status: number) => {
    response.statusCode = status
    return response
  })
  response.json = vi.fn(() => response)
  response.redirect = vi.fn(() => {
    response.statusCode = 302
    return response
  })
  response.setHeader = vi.fn(() => response)

  let handlerIndex = 0
  const runNextHandler = () => {
    const handler = handlers[handlerIndex]
    handlerIndex += 1
    if (handler) handler(normalizedRequest, response as unknown as Response, next)
  }
  const next = vi.fn(runNextHandler)
  runNextHandler()
  return { response, next }
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
  for (const name of ['MCP_AUTH_TOKEN', 'OAUTH_CLIENT_SECRET', 'OAUTH_ALLOWED_REDIRECT_URIS']) {
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

describe('authorize redirect validation', () => {
  it.each(
    [
      undefined,
      '',
      '/relative',
      'https://attacker.example.invalid/callback',
      `${callback}&extra=1`,
      `${callback}#fragment`,
      `${otherCallback}/`,
      otherCallback.replace('/callback', '/callback-evil'),
      otherCallback.replace('other.example.invalid', 'other.example.invalid.attacker.invalid'),
      otherCallback.replace('other.example.invalid', 'OTHER.example.invalid'),
      ` ${otherCallback}`,
      [otherCallback],
      { uri: otherCallback },
    ].map((redirectUri) => ({ redirectUri })),
  )('rejects unlisted/non-string redirect $redirectUri with no redirect', async ({
    redirectUri,
  }) => {
    await boot()
    const { response } = invoke('GET /authorize', {
      query: {
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
      } as Request['query'],
    })
    expect(response.status).toHaveBeenCalledWith(400)
    expect(response.json).toHaveBeenCalledWith({
      error: 'invalid_request',
      error_description: 'redirect_uri missing or not allowed',
    })
    expect(response.redirect).not.toHaveBeenCalled()
    expect(response.setHeader).not.toHaveBeenCalled()
  })

  it.each([callback, otherCallback])('accepts the exact configured URI %s', async (redirectUri) => {
    await boot()
    const { response } = invoke('GET /authorize', {
      query: {
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        state: 'test-state',
      },
    })
    const expected = new URL(redirectUri)
    expected.searchParams.set('code', bearer)
    expected.searchParams.set('state', 'test-state')
    expect(response.redirect).toHaveBeenCalledExactlyOnceWith(expected.toString())
    expect(response.status).not.toHaveBeenCalled()
  })

  it.each([undefined, 'wrong-client'])('retains client-ID rejection for %s', async (id) => {
    await boot()
    const { response } = invoke('GET /authorize', {
      query: { client_id: id, response_type: 'code', redirect_uri: callback },
    })
    expect(response.status).toHaveBeenCalledWith(401)
    expect(response.json).toHaveBeenCalledWith({ error: 'invalid_client' })
    expect(response.redirect).not.toHaveBeenCalled()
  })

  it('checks redirect before the invalid client-ID branch', async () => {
    await boot()
    const { response } = invoke('GET /authorize', { query: { client_id: 'wrong-client' } })
    expect(response.status).toHaveBeenCalledWith(400)
    expect(response.redirect).not.toHaveBeenCalled()
  })

  it('retains response-type validation', async () => {
    await boot()
    const { response } = invoke('GET /authorize', {
      query: { client_id: clientId, response_type: 'token', redirect_uri: callback },
    })
    expect(response.status).toHaveBeenCalledWith(400)
    expect(response.json).toHaveBeenCalledWith({ error: 'unsupported_response_type' })
    expect(response.redirect).not.toHaveBeenCalled()
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
    expect(secretEquals(candidate, expected)).toBe(valid)
    expect(timingSafeEqual).toHaveBeenCalledTimes(comparisons)
    for (const [supplied, configured] of vi.mocked(timingSafeEqual).mock.calls) {
      expect(Buffer.isBuffer(supplied)).toBe(true)
      expect(Buffer.isBuffer(configured)).toBe(true)
      expect(supplied.byteLength).toBe(configured.byteLength)
    }
  })
})

describe('token endpoint comparisons', () => {
  const validBody = {
    grant_type: 'authorization_code',
    code: bearer,
    client_id: clientId,
    client_secret: clientSecret,
  }

  for (const field of ['client_secret', 'code'] as const) {
    const valid = validBody[field]
    it.each(
      [undefined, '', 'wrong', valid.slice(0, -1), `${valid}\0`, [valid], {}].map((value) => ({
        value,
      })),
    )(`rejects invalid ${field} $value using timingSafeEqual`, async ({ value }) => {
      await boot()
      const { response } = invoke('POST /token', { body: { ...validBody, [field]: value } })
      expect(response.status).toHaveBeenCalledWith(field === 'client_secret' ? 401 : 400)
      expect(response.json).toHaveBeenCalledWith({
        error: field === 'client_secret' ? 'invalid_client' : 'invalid_grant',
      })
      expect(timingSafeEqual).toHaveBeenCalledTimes(field === 'client_secret' ? 1 : 2)
    })
  }

  it('compares the secret even when the client ID is invalid', async () => {
    await boot()
    const { response } = invoke('POST /token', {
      body: { ...validBody, client_id: 'wrong-client' },
    })
    expect(response.status).toHaveBeenCalledWith(401)
    expect(timingSafeEqual).toHaveBeenCalledOnce()
  })

  it('preserves the successful token response including expires_in', async () => {
    await boot()
    const { response } = invoke('POST /token', { body: validBody })
    expect(response.status).not.toHaveBeenCalled()
    expect(response.json).toHaveBeenCalledExactlyOnceWith({
      access_token: bearer,
      token_type: 'bearer',
      expires_in: 3600,
    })
    expect(timingSafeEqual).toHaveBeenCalledTimes(2)
  })
})

describe('MCP bearer middleware', () => {
  for (const method of ['GET', 'POST', 'DELETE']) {
    it.each([
      undefined,
      '',
      'Bearer wrong',
      `Bearer ${bearer.slice(0, -1)}`,
      `Bearer ${bearer}\0`,
    ])(`rejects invalid authorization %j on ${method}`, async (authorization) => {
      await boot()
      const { response, next } = invoke(`${method} /mcp`, { headers: { authorization } })
      expect(response.status).toHaveBeenCalledWith(401)
      expect(next).not.toHaveBeenCalled()
      expect(timingSafeEqual).toHaveBeenCalledOnce()
    })

    it(`accepts the exact bearer on ${method}`, async () => {
      await boot()
      const { response, next } = invoke(`${method} /mcp`, {
        headers: { authorization: `Bearer ${bearer}` },
      })
      expect(response.status).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalledOnce()
      expect(timingSafeEqual).toHaveBeenCalledOnce()
    })
  }
})
