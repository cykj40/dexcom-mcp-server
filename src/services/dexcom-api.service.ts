import { env, getDexcomApiBaseUrl } from '../config/env.js';
import type { DexcomEGV, DexcomDataRange, DexcomDevice, GlucoseReading } from '../types/index.js';
import { TREND_DESCRIPTIONS } from '../types/index.js';
import { insertGlucoseReading } from '../db/queries.js';

/**
 * Dexcom Developer API Service (Primary Data Source)
 * Official documented API with OAuth 2.0 authentication
 */

let accessToken = env.DEXCOM_ACCESS_TOKEN;
let refreshToken = env.DEXCOM_REFRESH_TOKEN;

const BASE_URL = getDexcomApiBaseUrl();

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
 * Refresh the OAuth access token
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

  console.error('✅ Access token refreshed successfully');
  console.error('⚠️  Note: Tokens are updated in memory. Update your .env for persistence:');
  console.error(`DEXCOM_ACCESS_TOKEN=${accessToken}`);
  console.error(`DEXCOM_REFRESH_TOKEN=${refreshToken}`);
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

    // Store in database
    for (const reading of readings) {
      insertGlucoseReading(reading);
    }

    console.error(`✅ Fetched ${readings.length} EGVs from Dexcom API`);
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
