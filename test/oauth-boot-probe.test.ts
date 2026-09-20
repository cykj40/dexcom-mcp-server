import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { hash } from '../src/auth/crypto.js'

it('proves real HTTP boot guards run before libSQL client construction using a loader trap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oauth-boot-probe-'))
  try {
    const loader = join(directory, 'loader.mjs')
    const setup = join(directory, 'setup.mjs')
    // This replacement exits at the construction boundary. No real libSQL client can exist.
    const replacement = `export function createClient() {
      process.stderr.write('PROBE_LIBSQL_CONSTRUCTION_BOUNDARY\\n'); process.exit(77)
    }`
    await writeFile(
      loader,
      `export async function resolve(specifier, context, next) {
      if (specifier === '@libsql/client') return {
        url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(replacement)}`)}, shortCircuit: true
      }; return next(specifier, context)
    }`,
    )
    await writeFile(
      setup,
      `import { register } from 'node:module';
      register(${JSON.stringify(pathToFileURL(loader).href)});
      Date.now = () => Date.parse('2026-09-20T00:00:00Z');`,
    )
    const synthetic = {
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      TRANSPORT: 'http',
      DEXCOM_CLIENT_ID: 'synthetic',
      DEXCOM_CLIENT_SECRET: 'synthetic',
      DEXCOM_REDIRECT_URI: 'https://dexcom.example.invalid/callback',
      TURSO_DATABASE_URL: 'file:/must-never-be-opened.db',
      MCP_AUTH_TOKEN: 'synthetic-legacy',
      OAUTH_CLIENT_ID: 'synthetic-client',
      OAUTH_CLIENT_SECRET: 'synthetic-client-secret',
      OAUTH_ISSUER_URL: 'https://mcp.example.invalid',
      OAUTH_OWNER_APPROVAL_KEY_SHA256: hash('O'.repeat(43)),
    }
    for (const uri of [undefined, '   ', 'not a url', 'https://client.example.invalid/callback']) {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--import', setup, 'src/index.ts'],
        {
          env: { ...synthetic, ...(uri === undefined ? {} : { OAUTH_ALLOWED_REDIRECT_URIS: uri }) },
          encoding: 'utf8',
          timeout: 15000,
        },
      )
      expect(result.error).toBeUndefined()
      if (uri === 'https://client.example.invalid/callback') {
        expect(result.status).toBe(77)
        expect(result.stderr).toContain('PROBE_LIBSQL_CONSTRUCTION_BOUNDARY')
      } else {
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('OAUTH_ALLOWED_REDIRECT_URIS')
        expect(result.stderr).not.toContain('PROBE_LIBSQL_CONSTRUCTION_BOUNDARY')
        expect(result.stderr).not.toContain('Running database migrations')
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
