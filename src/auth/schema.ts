import type { Client } from '@libsql/client'

export async function migrateOAuth(db: Client): Promise<void> {
  await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS mcp_oauth_approval_requests (
      request_id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      state TEXT,
      scope TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
      browser_nonce_hash TEXT NOT NULL,
      csrf_token_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + 600)
    )`,
      `CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      scope TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + 60),
      consumed_at INTEGER
    )`,
      `CREATE TABLE IF NOT EXISTS mcp_oauth_grants (
      grant_id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE REFERENCES mcp_oauth_codes(code_hash),
      client_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      scope TEXT NOT NULL,
      approved_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK (expires_at > approved_at AND expires_at <= approved_at + 2592000),
      revoked_at INTEGER,
      revocation_reason TEXT CHECK (revocation_reason IN ('refresh_token_reuse', 'authorization_code_reuse', 'owner_revoked'))
    )`,
      `CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES mcp_oauth_grants(grant_id),
      generation INTEGER NOT NULL CHECK (generation >= 0),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + 604800),
      consumed_at INTEGER,
      UNIQUE(grant_id, generation)
    )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS mcp_oauth_one_active_refresh
      ON mcp_oauth_refresh_tokens(grant_id) WHERE consumed_at IS NULL`,
      `CREATE TABLE IF NOT EXISTS mcp_oauth_access_tokens (
      token_hash TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES mcp_oauth_grants(grant_id),
      client_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + 3600),
      revoked_at INTEGER
    )`,
      ...['approval_requests', 'codes', 'grants', 'refresh_tokens', 'access_tokens'].map(
        (table) =>
          `CREATE INDEX IF NOT EXISTS mcp_oauth_${table}_expiry ON mcp_oauth_${table}(expires_at)`,
      ),
      `CREATE INDEX IF NOT EXISTS mcp_oauth_access_grant ON mcp_oauth_access_tokens(grant_id)`,
    ],
    'write',
  )
}
