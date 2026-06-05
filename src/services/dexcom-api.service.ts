import { z } from 'zod'
import { env, getDexcomApiBaseUrl } from '../config/env.js'
import { insertGlucoseReading } from '../db/queries.js'
import { getTokenSet, setTokenSet } from '../db/token-store.js'
import type { DexcomDataRange, DexcomDevice, DexcomEGV, GlucoseReading } from '../types/index.js'
import { TREND_DESCRIPTIONS } from '../types/index.js'

/**
 * Dexcom Developer API Service (Primary Data Source)
 * Official documented API with OAuth 2.0 authentication
 */

let accessToken: string | null = null
let refreshToken: string | null = null
let tokenExpiresAt: Date | null = null

const BASE_URL = getDexcomApiBaseUrl()
const PROACTIVE_REFRESH_WINDOW_MS = 120 * 1000

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
})

/**
 * Load persisted tokens from Turso, with env vars as one-time bootstrap only.
 * Must be called after the database is initialized.
 */
export async function initializeTokens(): Promise<void> {
  const dbTokens = await getTokenSet()

  if (dbTokens) {
    accessToken = dbTokens.accessToken
    refreshToken = dbTokens.refreshToken
    tokenExpiresAt = dbTokens.expiresAt
    console.error(
      `[Dexcom API] Loaded OAuth tokens from Turso, expires: ${tokenExpiresAt?.toISOString() ?? 'unknown'}`,
    )
  } else if (env.DEXCOM_ACCESS_TOKEN && env.DEXCOM_REFRESH_TOKEN) {
    accessToken = env.DEXCOM_ACCESS_TOKEN
    refreshToken = env.DEXCOM_REFRESH_TOKEN
    tokenExpiresAt = new Date(0)
    await setTokenSet({ accessToken, refreshToken, expiresAt: tokenExpiresAt })
    console.error(
      '[Dexcom API] Seeded Turso from optional env OAuth tokens. Remove env token values after this one-time bootstrap.',
    )
  } else {
    accessToken = null
    refreshToken = null
    tokenExpiresAt = null
    console.error(
      '[Dexcom API] No Dexcom OAuth tokens found in Turso. Start the one-time consent flow with `npm run oauth` and seed Turso before calling Dexcom API tools.',
    )
    return
  }

  if (isTokenExpiringSoon()) {
    console.error('[Dexcom API] Token expired or expiring soon, refreshing on startup...')
    await refreshAccessToken()
  }
}

/**
 * Check if token is expired or will expire within the next 120 seconds.
 */
function isTokenExpiringSoon(): boolean {
  if (!tokenExpiresAt) {
    return true
  }

  return Date.now() >= tokenExpiresAt.getTime() - PROACTIVE_REFRESH_WINDOW_MS
}

/**
 * Format a date string for the Dexcom API.
 * Dexcom requires: YYYY-MM-DDThh:mm:ss (no milliseconds, no timezone suffix).
 * Accepts ISO 8601 strings or Date-compatible strings.
 */
function formatDexcomDate(dateStr: string): string {
  const d = new Date(dateStr)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Make an authenticated API request to Dexcom
 */
async function makeApiRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  // Proactively refresh token if it's expiring soon
  if (isTokenExpiringSoon()) {
    console.error('[Dexcom API] Token expiring soon, proactively refreshing...')
    await refreshAccessToken()
  }

  const url = `${BASE_URL}${endpoint}`
  const method = options.method ?? 'GET'
  const canRetryAuth = method === 'GET' || method === 'HEAD'

  if (!accessToken) {
    throw new Error(
      'Dexcom OAuth tokens are not initialized. Complete the one-time OAuth consent flow before calling Dexcom API tools.',
    )
  }

  console.error(`[Dexcom API] ${method} ${url}`)

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  console.error(`[Dexcom API] Response: ${response.status} ${response.statusText}`)

  // Handle 401 - token expired, try to refresh
  if (response.status === 401 && canRetryAuth) {
    console.error('[Dexcom API] Access token expired, attempting refresh...')
    await refreshAccessToken()

    // Retry once with new token
    const retryResponse = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    if (!retryResponse.ok) {
      throw new Error(
        `Dexcom API error after refresh: ${retryResponse.status} ${retryResponse.statusText}`,
      )
    }

    return retryResponse.json() as Promise<T>
  }

  if (response.status === 401) {
    throw new Error(
      'Dexcom API authentication failed after request dispatch; not retrying non-read request',
    )
  }

  // Handle 429 - rate limit
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After')
    const waitSeconds = retryAfter ? parseInt(retryAfter, 10) : 60
    console.warn(`Rate limited, waiting ${waitSeconds} seconds...`)
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000))

    // Retry once after waiting
    const retryResponse = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    if (!retryResponse.ok) {
      throw new Error(
        `Dexcom API error after rate limit: ${retryResponse.status} ${retryResponse.statusText}`,
      )
    }

    return retryResponse.json() as Promise<T>
  }

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Dexcom API error: ${response.status} ${response.statusText} - ${errorBody}`)
  }

  return response.json() as Promise<T>
}

/**
 * Refresh the OAuth access token and persist to database
 */
async function refreshAccessToken(): Promise<void> {
  if (!refreshToken) {
    throw new Error(
      'Dexcom refresh token is not initialized. Complete the one-time OAuth consent flow before calling Dexcom API tools.',
    )
  }

  const response = await fetch(`${BASE_URL}/v3/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: env.DEXCOM_CLIENT_ID,
      client_secret: env.DEXCOM_CLIENT_SECRET,
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    console.error(`[Dexcom API] Token refresh failed: ${response.status} ${response.statusText}`)
    console.error(`[Dexcom API] Refresh error body: ${errorBody}`)
    throw new Error(
      `Failed to refresh token: ${response.status} ${response.statusText} - ${errorBody}`,
    )
  }

  const data = tokenResponseSchema.parse(await response.json())
  const nextExpiresAt = new Date(Date.now() + data.expires_in * 1000)

  console.error('✅ Access token refreshed successfully')
  console.error(`   New token expires at: ${nextExpiresAt.toISOString()}`)

  try {
    await setTokenSet({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: nextExpiresAt,
    })
    console.error('✅ Tokens persisted to database')
  } catch {
    console.error(
      '[Dexcom API] Failed to persist rotated OAuth tokens to Turso. Refusing to continue with in-memory tokens.',
    )
    throw new Error('Failed to persist rotated Dexcom OAuth tokens to Turso')
  }

  accessToken = data.access_token
  refreshToken = data.refresh_token
  tokenExpiresAt = nextExpiresAt
}

/**
 * Get current access token (for external use if needed)
 */
export function getCurrentAccessToken(): string {
  if (!accessToken) {
    throw new Error('Dexcom access token is not initialized')
  }
  return accessToken
}

/**
 * Get current refresh token (for external use if needed)
 */
export function getCurrentRefreshToken(): string {
  if (!refreshToken) {
    throw new Error('Dexcom refresh token is not initialized')
  }
  return refreshToken
}

/**
 * Fetch EGVs (Estimated Glucose Values) from Dexcom API
 * Date range limited to 90 days per API restriction
 */
export async function fetchEGVs(startDate: string, endDate: string): Promise<GlucoseReading[]> {
  try {
    const formattedStart = formatDexcomDate(startDate)
    const formattedEnd = formatDexcomDate(endDate)
    const endpoint = `/v3/users/self/egvs?startDate=${encodeURIComponent(formattedStart)}&endDate=${encodeURIComponent(formattedEnd)}`
    const response = await makeApiRequest<{ records?: DexcomEGV[]; egvs?: DexcomEGV[] }>(endpoint)

    // API may return 'records' or 'egvs' depending on version
    const egvs = response.records || response.egvs || []

    const readings: GlucoseReading[] = egvs.map((egv) => ({
      value: egv.value,
      trend: egv.trend,
      trendDescription: TREND_DESCRIPTIONS[egv.trend] || 'Unknown',
      recordedAt: egv.systemTime,
      source: 'api' as const,
      systemTime: egv.systemTime,
      displayTime: egv.displayTime,
    }))

    // Sort readings by timestamp (oldest to newest)
    readings.sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime())

    // Store in database
    for (const reading of readings) {
      await insertGlucoseReading(reading)
    }

    console.error(`✅ Fetched ${readings.length} EGVs from Dexcom API`)
    if (readings.length > 0) {
      const oldest = new Date(readings[0].recordedAt).toISOString()
      const newest = new Date(readings[readings.length - 1].recordedAt).toISOString()
      console.error(`   Range: ${oldest} to ${newest}`)
    }
    return readings
  } catch (error) {
    console.error('Error fetching EGVs from Dexcom API:', error)
    throw error
  }
}

/**
 * Get the available data range for the user
 */
export async function getDataRange(): Promise<DexcomDataRange> {
  return makeApiRequest<DexcomDataRange>('/v3/users/self/dataRange')
}

/**
 * Get device information
 */
export async function getDevices(): Promise<DexcomDevice[]> {
  const response = await makeApiRequest<{ records?: DexcomDevice[] }>('/v3/users/self/devices')
  return response.records || []
}

/**
 * Get alerts within date range
 */
export async function getAlerts(startDate: string, endDate: string): Promise<unknown[]> {
  const formattedStart = formatDexcomDate(startDate)
  const formattedEnd = formatDexcomDate(endDate)
  const endpoint = `/v3/users/self/alerts?startDate=${encodeURIComponent(formattedStart)}&endDate=${encodeURIComponent(formattedEnd)}`
  const response = await makeApiRequest<{ records?: unknown[] }>(endpoint)
  return response.records || []
}

/**
 * Get calibrations within date range
 */
export async function getCalibrations(startDate: string, endDate: string): Promise<unknown[]> {
  const formattedStart = formatDexcomDate(startDate)
  const formattedEnd = formatDexcomDate(endDate)
  const endpoint = `/v3/users/self/calibrations?startDate=${encodeURIComponent(formattedStart)}&endDate=${encodeURIComponent(formattedEnd)}`
  const response = await makeApiRequest<{ records?: unknown[] }>(endpoint)
  return response.records || []
}
