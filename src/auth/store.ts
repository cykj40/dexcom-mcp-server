import { randomUUID } from 'node:crypto'
import type { Client, Transaction, Value } from '@libsql/client'
import { ACCESS_TTL, APPROVAL_TTL, CODE_TTL, GRANT_TTL, REFRESH_TTL } from './config.js'
import { challengeFor, hash, randomCredential, secretEquals } from './crypto.js'

export interface Authorization {
  clientId: string
  redirectUri: string
  state: string | null
  scope: string
  challenge: string
}

export interface TokenPair {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

export type ExchangeResult =
  | { kind: 'issued'; grantId: string; pair: TokenPair; generation: number }
  | { kind: 'invalid' }
  | { kind: 'scope' }
  | { kind: 'code_reuse'; grantId: string }
  | { kind: 'refresh_reuse'; grantId: string; generation: number; interval: number }

export class OAuthStore {
  constructor(
    private readonly database: () => Client,
    readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  private async write<T>(operation: (tx: Transaction, now: number) => Promise<T>): Promise<T> {
    // Retry only BEGIN on contention, never an operation/commit with an ambiguous outcome.
    let tx: Transaction | undefined
    for (let attempt = 0; ; attempt++) {
      try {
        tx = await this.database().transaction('write')
        break
      } catch (error) {
        const code = (error as { code?: string }).code
        if (attempt >= 4 || (code !== 'SQLITE_BUSY' && code !== 'SQLITE_BUSY_SNAPSHOT')) throw error
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
      }
    }
    try {
      const result = await operation(tx, this.now())
      await tx.commit()
      return result
    } finally {
      // close rolls back an uncommitted transaction, including failed writes.
      tx.close()
    }
  }

  async createApproval(auth: Authorization) {
    const requestId = randomCredential()
    const browserNonce = randomCredential()
    const csrfToken = randomCredential()
    const now = this.now()
    await this.database().execute({
      sql: `INSERT INTO mcp_oauth_approval_requests
        (request_id, client_id, redirect_uri, state, scope, code_challenge, code_challenge_method,
         browser_nonce_hash, csrf_token_hash, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, 'S256', ?, ?, ?, ?)`,
      args: [
        requestId,
        auth.clientId,
        auth.redirectUri,
        auth.state,
        auth.scope,
        auth.challenge,
        hash(browserNonce),
        hash(csrfToken),
        now,
        now + APPROVAL_TTL,
      ],
    })
    return { requestId, browserNonce, csrfToken }
  }

  async decideApproval(
    requestId: string,
    browserNonce: string,
    csrfToken: string,
    approve: boolean,
  ) {
    return this.write(async (tx, now) => {
      const result = await tx.execute({
        sql: 'SELECT * FROM mcp_oauth_approval_requests WHERE request_id = ? AND expires_at > ?',
        args: [requestId, now],
      })
      const row = result.rows[0]
      if (!row) return null
      const browserMatches = secretEquals(hash(browserNonce), String(row.browser_nonce_hash))
      const csrfMatches = secretEquals(hash(csrfToken), String(row.csrf_token_hash))
      if (!browserMatches || !csrfMatches) return null
      const deleted = await tx.execute({
        sql: 'DELETE FROM mcp_oauth_approval_requests WHERE request_id = ? AND expires_at > ?',
        args: [requestId, now],
      })
      if (deleted.rowsAffected !== 1) return null
      const code = approve ? randomCredential() : null
      if (code) {
        await tx.execute({
          sql: `INSERT INTO mcp_oauth_codes
            (code_hash, client_id, redirect_uri, scope, code_challenge, code_challenge_method, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, 'S256', ?, ?)`,
          args: [
            hash(code),
            row.client_id,
            row.redirect_uri,
            row.scope,
            row.code_challenge,
            now,
            now + CODE_TTL,
          ],
        })
      }
      return {
        code,
        redirectUri: String(row.redirect_uri),
        state: row.state == null ? null : String(row.state),
      }
    })
  }

  private async issue(
    tx: Transaction,
    grant: { grant_id: Value; client_id: Value; scope: Value; expires_at: Value },
    generation: number,
    now: number,
  ): Promise<TokenPair> {
    const accessToken = randomCredential()
    const refreshToken = randomCredential()
    const accessExpiry = Math.min(now + ACCESS_TTL, Number(grant.expires_at))
    const refreshExpiry = Math.min(now + REFRESH_TTL, Number(grant.expires_at))
    await tx.execute({
      sql: `INSERT INTO mcp_oauth_access_tokens
        (token_hash, grant_id, client_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      args: [hash(accessToken), grant.grant_id, grant.client_id, now, accessExpiry],
    })
    await tx.execute({
      sql: `INSERT INTO mcp_oauth_refresh_tokens
        (token_hash, grant_id, generation, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      args: [hash(refreshToken), grant.grant_id, generation, now, refreshExpiry],
    })
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: accessExpiry - now,
      refresh_token: refreshToken,
      scope: String(grant.scope),
    }
  }

  async exchangeCode(
    code: string,
    clientId: string,
    redirectUri: string,
    verifier: string,
    resource: string,
  ): Promise<ExchangeResult> {
    return this.write(async (tx, now) => {
      const codeHash = hash(code)
      const result = await tx.execute({
        sql: 'SELECT * FROM mcp_oauth_codes WHERE code_hash = ?',
        args: [codeHash],
      })
      const row = result.rows[0]
      if (
        !row ||
        row.client_id !== clientId ||
        row.redirect_uri !== redirectUri ||
        row.code_challenge_method !== 'S256' ||
        !secretEquals(challengeFor(verifier), String(row.code_challenge))
      ) {
        return { kind: 'invalid' }
      }
      // Detect proven replay even after the code's 60-second lifetime has elapsed.
      if (row.consumed_at != null) {
        const revoked = await tx.execute({
          sql: `UPDATE mcp_oauth_grants SET revoked_at = COALESCE(revoked_at, ?),
            revocation_reason = COALESCE(revocation_reason, 'authorization_code_reuse')
            WHERE code_hash = ? RETURNING grant_id`,
          args: [now, codeHash],
        })
        return revoked.rows[0]
          ? { kind: 'code_reuse', grantId: String(revoked.rows[0].grant_id) }
          : { kind: 'invalid' }
      }
      if (Number(row.expires_at) <= now) return { kind: 'invalid' }
      const consumed = await tx.execute({
        sql: `UPDATE mcp_oauth_codes SET consumed_at = ?
          WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
        args: [now, codeHash, now],
      })
      if (consumed.rowsAffected !== 1) return { kind: 'invalid' }
      const grantId = randomUUID()
      const expiresAt = Number(row.created_at) + GRANT_TTL
      await tx.execute({
        sql: `INSERT INTO mcp_oauth_grants
          (grant_id, code_hash, client_id, resource, scope, approved_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [grantId, codeHash, clientId, resource, row.scope, row.created_at, expiresAt],
      })
      const pair = await this.issue(
        tx,
        { grant_id: grantId, client_id: clientId, scope: row.scope, expires_at: expiresAt },
        0,
        now,
      )
      return { kind: 'issued', grantId, pair, generation: 0 }
    })
  }

  async refresh(
    token: string,
    clientId: string,
    resource: string,
    scope?: string,
  ): Promise<ExchangeResult> {
    return this.write(async (tx, now) => {
      const tokenHash = hash(token)
      const result = await tx.execute({
        sql: `SELECT r.*, g.client_id, g.resource, g.scope, g.revoked_at,
          g.expires_at AS grant_expires_at FROM mcp_oauth_refresh_tokens r
          JOIN mcp_oauth_grants g ON g.grant_id = r.grant_id WHERE r.token_hash = ?`,
        args: [tokenHash],
      })
      const row = result.rows[0]
      if (
        !row ||
        row.client_id !== clientId ||
        row.resource !== resource ||
        row.revoked_at != null ||
        Number(row.grant_expires_at) <= now
      )
        return { kind: 'invalid' }
      if (row.consumed_at != null) {
        await tx.execute({
          sql: `UPDATE mcp_oauth_grants SET revoked_at = ?, revocation_reason = 'refresh_token_reuse'
            WHERE grant_id = ? AND revoked_at IS NULL`,
          args: [now, row.grant_id],
        })
        return {
          kind: 'refresh_reuse',
          grantId: String(row.grant_id),
          generation: Number(row.generation),
          interval: now - Number(row.consumed_at),
        }
      }
      if (Number(row.expires_at) <= now) return { kind: 'invalid' }
      if (scope !== undefined && scope !== row.scope) return { kind: 'scope' }
      const consumed = await tx.execute({
        sql: `UPDATE mcp_oauth_refresh_tokens SET consumed_at = ?
          WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
        args: [now, tokenHash, now],
      })
      if (consumed.rowsAffected !== 1) return { kind: 'invalid' }
      const generation = Number(row.generation) + 1
      const pair = await this.issue(
        tx,
        {
          grant_id: row.grant_id,
          client_id: row.client_id,
          scope: row.scope,
          expires_at: row.grant_expires_at,
        },
        generation,
        now,
      )
      return { kind: 'issued', grantId: String(row.grant_id), pair, generation }
    })
  }

  async accepts(token: string, clientId: string, resource: string): Promise<boolean> {
    const now = this.now()
    const result = await this.database().execute({
      sql: `SELECT 1 FROM mcp_oauth_access_tokens a JOIN mcp_oauth_grants g ON g.grant_id = a.grant_id
        WHERE a.token_hash = ? AND a.client_id = ? AND g.client_id = ? AND g.resource = ?
          AND a.revoked_at IS NULL AND g.revoked_at IS NULL AND a.expires_at > ? AND g.expires_at > ?`,
      args: [hash(token), clientId, clientId, resource, now, now],
    })
    return result.rows.length === 1
  }

  async listGrants() {
    return (
      await this.database().execute(`SELECT grant_id, approved_at, expires_at, revoked_at, revocation_reason
      FROM mcp_oauth_grants ORDER BY approved_at DESC`)
    ).rows
  }

  async revokeGrant(grantId: string): Promise<boolean> {
    return this.write(async (tx, now) => {
      const result = await tx.execute({
        sql: `UPDATE mcp_oauth_grants SET revoked_at = COALESCE(revoked_at, ?),
          revocation_reason = COALESCE(revocation_reason, 'owner_revoked') WHERE grant_id = ?`,
        args: [now, grantId],
      })
      return result.rowsAffected === 1
    })
  }

  async cleanup(): Promise<void> {
    await this.write(async (tx, now) => {
      await tx.execute({
        sql: 'DELETE FROM mcp_oauth_approval_requests WHERE expires_at <= ?',
        args: [now],
      })
      await tx.execute({
        sql: 'DELETE FROM mcp_oauth_access_tokens WHERE expires_at <= ?',
        args: [now],
      })
      // Keep consumed refresh hashes and codes for the entire grant lifetime.
      await tx.execute({
        sql: `DELETE FROM mcp_oauth_refresh_tokens WHERE grant_id IN
        (SELECT grant_id FROM mcp_oauth_grants WHERE expires_at <= ?)`,
        args: [now],
      })
      await tx.execute({ sql: 'DELETE FROM mcp_oauth_grants WHERE expires_at <= ?', args: [now] })
      await tx.execute({
        sql: `DELETE FROM mcp_oauth_codes WHERE expires_at <= ? AND NOT EXISTS
        (SELECT 1 FROM mcp_oauth_grants g WHERE g.code_hash = mcp_oauth_codes.code_hash)`,
        args: [now],
      })
    })
  }
}
