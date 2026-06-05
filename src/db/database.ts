import { type Client, createClient } from '@libsql/client'
import { env } from '../config/env.js'

let client: Client | null = null

/**
 * Get or create libsql (Turso) database client
 * Singleton pattern — returns the same instance on subsequent calls
 */
export function getDb(): Client {
  if (!client) {
    client = createClient({
      url: env.TURSO_DATABASE_URL,
      authToken: env.TURSO_AUTH_TOKEN,
    })
    console.error(`✅ Database connected: ${env.TURSO_DATABASE_URL}`)
  }
  return client
}

/**
 * Close the database client
 * Should be called on application shutdown
 */
export function closeDb(): void {
  if (client) {
    client.close()
    client = null
    console.error('Database connection closed')
  }
}
