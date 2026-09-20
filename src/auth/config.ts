import { hash, secretEquals } from './crypto.js'

export const LEGACY_CUTOFF = Date.parse('2026-10-04T00:00:00Z') / 1000
export const APPROVAL_TTL = 600
export const CODE_TTL = 60
export const ACCESS_TTL = 3600
export const REFRESH_TTL = 7 * 86400
export const GRANT_TTL = 30 * 86400

export interface OAuthConfig {
  clientId: string
  clientSecret: string
  ownerKeyHash: string
  issuer: string
  resource: string
  redirects: Set<string>
  legacyBearer?: string
}

// Called before getDb(), migrations, token initialization, or opening a listener.
export function oauthConfig(
  env: Record<string, string | undefined>,
  now = Math.floor(Date.now() / 1000),
): OAuthConfig {
  const required = (name: string) => {
    const value = env[name]
    if (!value?.trim()) throw new Error(`${name} must be non-empty when TRANSPORT=http`)
    return value
  }
  const clientId = required('OAUTH_CLIENT_ID')
  const clientSecret = required('OAUTH_CLIENT_SECRET')
  const ownerKeyHash = required('OAUTH_OWNER_APPROVAL_KEY_SHA256')
  if (!/^[a-f0-9]{64}$/.test(ownerKeyHash)) {
    throw new Error('OAUTH_OWNER_APPROVAL_KEY_SHA256 must be a lowercase SHA-256 hex digest')
  }
  const legacyBearer = now < LEGACY_CUTOFF ? required('MCP_AUTH_TOKEN') : env.MCP_AUTH_TOKEN
  if (
    [clientId, clientSecret, legacyBearer].some(
      (value) => value && secretEquals(hash(value), ownerKeyHash),
    )
  ) {
    throw new Error(
      'The owner approval key must be independent of all client and legacy credentials',
    )
  }
  const issuer = required('OAUTH_ISSUER_URL')
  try {
    const parsed = new URL(issuer)
    if (parsed.protocol !== 'https:' || parsed.origin !== issuer) throw new Error()
  } catch {
    throw new Error('OAUTH_ISSUER_URL must be a canonical HTTPS origin without a trailing slash')
  }
  const redirects = new Set<string>()
  for (const entry of required('OAUTH_ALLOWED_REDIRECT_URIS').split(',')) {
    const uri = entry.trim()
    try {
      const parsed = new URL(uri)
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash)
        throw new Error()
    } catch {
      throw new Error(`Invalid OAUTH_ALLOWED_REDIRECT_URIS entry: ${JSON.stringify(uri)}`)
    }
    redirects.add(uri)
  }
  return {
    clientId,
    clientSecret,
    ownerKeyHash,
    issuer,
    resource: `${issuer}/mcp`,
    redirects,
    legacyBearer,
  }
}
