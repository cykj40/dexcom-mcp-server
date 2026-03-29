import { env, getDexcomApiBaseUrl } from '../config/env.js';
import type { DexcomEGV, DexcomDataRange, DexcomDevice, GlucoseReading } from '../types/index.js';
import { TREND_DESCRIPTIONS } from '../types/index.js';
import { insertGlucoseReading } from '../db/queries.js';
import { getToken, setToken } from '../db/token-store.js';

/**
 * Dexcom Developer API Service (Primary Data Source)
 * Official documented API with OAuth 2.0 authentication
 */

let accessToken = env.DEXCOM_ACCESS_TOKEN;
let refreshToken = env.DEXCOM_REFRESH_TOKEN;
let tokenExpiresAt: Date | null = null;

const BASE_URL = getDexcomApiBaseUrl();

/**
 * Load persisted tokens from the database, falling back to env vars.
 * Must be called after the database is initialized.
 */
export async function initializeTokens(): Promise<void> {
  try {
    const [dbAccess, dbRefresh] = await Promise.all([
      getToken('access_token'),
      getToken('refresh_token'),
    ]);

    if (dbAccess) {
      accessToken = dbAccess;
      console.error('[Dexcom API] Loaded access_token from database');
    }
    if (dbRefresh) {
      refreshToken = dbRefresh;
      console.error('[Dexcom API] Loaded refresh_token from database');
    }
  } catch (error) {
    console.error('[Dexcom API] Could not load tokens from DB, using env vars:', error);
  }

  tokenExpiresAt = getTokenExpiration(accessToken);
  console.error(`[Dexcom API] Token initialized, expires: ${tokenExpiresAt?.toISOString() ?? 'unknown'}`);

  // Refresh immediately if expired or expiring within 24 hours
  const twentyFourHoursFromNow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (!tokenExpiresAt || tokenExpiresAt <= twentyFourHoursFromNow) {
    console.error('[Dexcom API] Token expired or expiring within 24h, refreshing on startup...');
    try {
      await refreshAccessToken();
    } catch (error) {
      console.error('[Dexcom API] Startup token refresh failed:', error);
      // Non-fatal: server still starts, will retry on first API call
    }
  }
}

/**
 * Parse JWT token and extract expiration time
 */
function getTokenExpiration(token: string): Date | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()) as { exp?: number };
    if (payload.exp) {
      return new Date(payload.exp * 1000);
    }
  } catch (error) {
    console.error('[Dexcom API] Failed to parse token expiration:', error);
  }
  return null;
}

/**
 * Check if token is expired or will expire within the next 5 minutes
 */
function isTokenExpiringSoon(): boolean {
  if (!tokenExpiresAt) {
    tokenExpiresAt = getTokenExpiration(accessToken);
  }

  if (!tokenExpiresAt) {
    // If we can't determine expiration, assume it might be expired
    return true;
  }

  // Check if token expires within 5 minutes
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
  return tokenExpiresAt <= fiveMinutesFromNow;
}

/**
 * Format a date string for the Dexcom API.
 * Dexcom requires: YYYY-MM-DDThh:mm:ss (no milliseconds, no timezone suffix).
 * Accepts ISO 8601 strings or Date-compatible strings.
 */
function formatDexcomDate(dateStr: string): string {
  const d = new Date(dateStr);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Make an authenticated API request to Dexcom
 */
async function makeApiRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  // Proactively refresh token if it's expiring soon
  if (isTokenExpiringSoon()) {
    console.error('[Dexcom API] Token expiring soon, proactively refreshing...');
    try {
      await refreshAccessToken();
    } catch (error) {
      console.error('[Dexcom API] Proactive refresh failed, will retry on 401:', error);
    }
  }

  const url = `${BASE_URL}${endpoint}`;

  console.error(`[Dexcom API] ${options.method || 'GET'} ${url}`);

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  console.error(`[Dexcom API] Response: ${response.status} ${response.statusText}`);

  // Handle 401 - token expired, try to refresh
  if (response.status === 401) {
    console.error('[Dexcom API] Access token expired, attempting refresh...');
    await refreshAccessToken();

    // Retry once with new token
    const retryResponse = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!retryResponse.ok) {
      throw new Error(`Dexcom API error after refresh: ${retryResponse.status} ${retryResponse.statusText}`);
    }

    return retryResponse.json() as Promise<T>;
  }

  // Handle 429 - rate limit
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const waitSeconds = retryAfter ? parseInt(retryAfter, 10) : 60;
    console.warn(`Rate limited, waiting ${waitSeconds} seconds...`);
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));

    // Retry once after waiting
    const retryResponse = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!retryResponse.ok) {
      throw new Error(`Dexcom API error after rate limit: ${retryResponse.status} ${retryResponse.statusText}`);
    }

    return retryResponse.json() as Promise<T>;
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Dexcom API error: ${response.status} ${response.statusText} - ${errorBody}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Refresh the OAuth access token and persist to database
 */
async function refreshAccessToken(): Promise<void> {
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
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[Dexcom API] Token refresh failed: ${response.status} ${response.statusText}`);
    console.error(`[Dexcom API] Refresh error body: ${errorBody}`);
    throw new Error(`Failed to refresh token: ${response.status} ${response.statusText} - ${errorBody}`);
  }

  const data = await response.json() as { access_token: string; refresh_token: string };
  accessToken = data.access_token;
  refreshToken = data.refresh_token;

  // Update token expiration
  tokenExpiresAt = getTokenExpiration(accessToken);

  console.error('✅ Access token refreshed successfully');
  if (tokenExpiresAt) {
    console.error(`   New token expires at: ${tokenExpiresAt.toISOString()}`);
  }

  // Persist tokens to database so they survive VM restarts
  try {
    await Promise.all([
      setToken('access_token', accessToken),
      setToken('refresh_token', refreshToken),
    ]);
    console.error('✅ Tokens persisted to database');
  } catch (err) {
    console.error('[Dexcom API] Failed to persist tokens to DB:', err);
    // Non-fatal: tokens are still in memory for this session
    console.error('⚠️  Fallback: update your .env for persistence:');
    console.error(`DEXCOM_ACCESS_TOKEN=${accessToken}`);
    console.error(`DEXCOM_REFRESH_TOKEN=${refreshToken}`);
  }
}

/**
 * Get current access token (for external use if needed)
 */
export function getCurrentAccessToken(): string {
  return accessToken;
}

/**
 * Get current refresh token (for external use if needed)
 */
export function getCurrentRefreshToken(): string {
  return refreshToken;
}

/**
 * Fetch EGVs (Estimated Glucose Values) from Dexcom API
 * Date range limited to 90 days per API restriction
 */
export async function fetchEGVs(startDate: string, endDate: string): Promise<GlucoseReading[]> {
  try {
    const formattedStart = formatDexcomDate(startDate);
    const formattedEnd = formatDexcomDate(endDate);
    const endpoint = `/v3/users/self/egvs?startDate=${encodeURIComponent(formattedStart)}&endDate=${encodeURIComponent(formattedEnd)}`;
    const response = await makeApiRequest<{ records?: DexcomEGV[]; egvs?: DexcomEGV[] }>(endpoint);

    // API may return 'records' or 'egvs' depending on version
    const egvs = response.records || response.egvs || [];

    const readings: GlucoseReading[] = egvs.map((egv) => ({
      value: egv.value,
      trend: egv.trend,
      trendDescription: TREND_DESCRIPTIONS[egv.trend] || 'Unknown',
      recordedAt: egv.systemTime,
      source: 'api' as const,
      systemTime: egv.systemTime,
      displayTime: egv.displayTime,
    }));

    // Sort readings by timestamp (oldest to newest)
    readings.sort((a, b) =>
      new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime()
    );

    // Store in database
    for (const reading of readings) {
      await insertGlucoseReading(reading);
    }

    console.error(`✅ Fetched ${readings.length} EGVs from Dexcom API`);
    if (readings.length > 0) {
      const oldest = new Date(readings[0].recordedAt).toISOString();
      const newest = new Date(readings[readings.length - 1].recordedAt).toISOString();
      console.error(`   Range: ${oldest} to ${newest}`);
    }
    return readings;
  } catch (error) {
    console.error('Error fetching EGVs from Dexcom API:', error);
    throw error;
  }
}

/**
 * Get the available data range for the user
 */
export async function getDataRange(): Promise<DexcomDataRange> {
  return makeApiRequest<DexcomDataRange>('/v3/users/self/dataRange');
}

/**
 * Get device information
 */
export async function getDevices(): Promise<DexcomDevice[]> {
  const response = await makeApiRequest<{ records?: DexcomDevice[] }>('/v3/users/self/devices');
  return response.records || [];
}

/**
 * Get alerts within date range
 */
export async function getAlerts(startDate: string, endDate: string): Promise<unknown[]> {
  const formattedStart = formatDexcomDate(startDate);
  const formattedEnd = formatDexcomDate(endDate);
  const endpoint = `/v3/users/self/alerts?startDate=${encodeURIComponent(formattedStart)}&endDate=${encodeURIComponent(formattedEnd)}`;
  const response = await makeApiRequest<{ records?: unknown[] }>(endpoint);
  return response.records || [];
}

/**
 * Get calibrations within date range
 */
export async function getCalibrations(startDate: string, endDate: string): Promise<unknown[]> {
  const formattedStart = formatDexcomDate(startDate);
  const formattedEnd = formatDexcomDate(endDate);
  const endpoint = `/v3/users/self/calibrations?startDate=${encodeURIComponent(formattedStart)}&endDate=${encodeURIComponent(formattedEnd)}`;
  const response = await makeApiRequest<{ records?: unknown[] }>(endpoint);
  return response.records || [];
}
