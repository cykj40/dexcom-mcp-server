import { getDb } from './database.js';

/**
 * Retrieve a persisted token value by key.
 * Returns null if the key does not exist.
 */
export async function getToken(key: string): Promise<string | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT value FROM tokens WHERE key = ?`,
    args: [key],
  });
  if (result.rows.length === 0) return null;
  const raw = result.rows[0]['value'];
  return raw != null ? String(raw) : null;
}

/**
 * Persist a token value by key (upsert).
 */
export async function setToken(key: string, value: string): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `
      INSERT INTO tokens (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `,
    args: [key, value],
  });
}
