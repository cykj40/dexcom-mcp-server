import { getDb } from './database.js'

export type StoredTokenSet = {
  accessToken: string
  refreshToken: string
  expiresAt: Date | null
}

/**
 * Retrieve a persisted token value by key.
 * Returns null if the key does not exist.
 */
export async function getToken(key: string): Promise<string | null> {
  const db = getDb()
  const result = await db.execute({
    sql: `SELECT value FROM tokens WHERE key = ?`,
    args: [key],
  })
  if (result.rows.length === 0) return null
  const raw = result.rows[0].value
  return raw != null ? String(raw) : null
}

/**
 * Retrieve the complete OAuth token set from Turso.
 * Returns null until both access and refresh tokens are present.
 */
export async function getTokenSet(): Promise<StoredTokenSet | null> {
  const db = getDb()
  const result = await db.execute({
    sql: `SELECT key, value, expires_at FROM tokens WHERE key IN ('access_token', 'refresh_token')`,
    args: [],
  })

  let accessToken: string | null = null
  let refreshToken: string | null = null
  let expiresAt: Date | null = null

  for (const row of result.rows) {
    const key = row.key != null ? String(row.key) : ''
    const value = row.value != null ? String(row.value) : null
    if (!value) continue

    if (key === 'access_token') {
      accessToken = value
      const rawExpiresAt = row.expires_at
      if (rawExpiresAt != null) {
        const parsedExpiresAt = new Date(String(rawExpiresAt))
        if (!Number.isNaN(parsedExpiresAt.getTime())) {
          expiresAt = parsedExpiresAt
        }
      }
    } else if (key === 'refresh_token') {
      refreshToken = value
    }
  }

  if (!accessToken || !refreshToken) {
    return null
  }

  return { accessToken, refreshToken, expiresAt }
}

/**
 * Persist a token value by key (upsert).
 */
export async function setToken(key: string, value: string, expiresAt?: Date | null): Promise<void> {
  const db = getDb()
  await db.execute({
    sql: `
      INSERT INTO tokens (key, value, expires_at, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `,
    args: [key, value, expiresAt ? expiresAt.toISOString() : null],
  })
}

/**
 * Persist the rotated OAuth token set together.
 */
export async function setTokenSet(tokens: StoredTokenSet): Promise<void> {
  const db = getDb()
  const expiresAt = tokens.expiresAt ? tokens.expiresAt.toISOString() : null

  await db.batch(
    [
      {
        sql: `
        INSERT INTO tokens (key, value, expires_at, updated_at)
        VALUES ('access_token', ?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `,
        args: [tokens.accessToken, expiresAt],
      },
      {
        sql: `
        INSERT INTO tokens (key, value, expires_at, updated_at)
        VALUES ('refresh_token', ?, NULL, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `,
        args: [tokens.refreshToken],
      },
    ],
    'write',
  )
}
