import { env, DEXCOM_SHARE_BASE_URL } from '../config/env.js';
import type { DexcomShareReading, GlucoseReading } from '../types/index.js';
import { SHARE_TREND_MAP, TREND_DESCRIPTIONS } from '../types/index.js';
import { insertGlucoseReading } from '../db/queries.js';

/**
 * Dexcom Share API Service (Best-Effort Fallback)
 * Undocumented, unreliable API - use only when Developer API fails
 * Never throw on errors, just log warnings and return empty results
 */

const APPLICATION_ID = 'd8665ade-9673-4e27-9ff6-92db4ce13d13';

let sessionId: string | null = null;

/**
 * Parse Share API date format: /Date(1234567890000)/
 */
function parseShareDate(dateStr: string): string {
  try {
    const match = dateStr.match(/\/Date\((\d+)\)\//);
    if (match) {
      const timestamp = parseInt(match[1], 10);
      return new Date(timestamp).toISOString();
    }
    return new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Authenticate with Share API
 */
async function authenticate(): Promise<boolean> {
  if (!env.DEXCOM_SHARE_USERNAME || !env.DEXCOM_SHARE_PASSWORD) {
    console.warn('Share API credentials not configured, skipping authentication');
    return false;
  }

  try {
    const response = await fetch(`${DEXCOM_SHARE_BASE_URL}/General/LoginPublisherAccountByName`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accountName: env.DEXCOM_SHARE_USERNAME,
        password: env.DEXCOM_SHARE_PASSWORD,
        applicationId: APPLICATION_ID,
      }),
    });

    if (!response.ok) {
      console.warn(`Share API auth failed: ${response.status} ${response.statusText}`);
      return false;
    }

    const data = await response.text();
    // Remove surrounding quotes if present
    sessionId = data.replace(/^"(.*)"$/, '$1');
    console.log('✅ Share API authenticated');
    return true;
  } catch (error) {
    console.warn('Share API authentication error:', error);
    return false;
  }
}

/**
 * Fetch latest glucose readings from Share API
 * @param minutes Number of minutes of data to fetch (max 1440 = 24 hours)
 * @param maxCount Maximum number of readings to fetch (max 288)
 */
export async function fetchShareReadings(
  minutes: number = 1440,
  maxCount: number = 288
): Promise<GlucoseReading[]> {
  try {
    // Ensure we're authenticated
    if (!sessionId) {
      const authenticated = await authenticate();
      if (!authenticated) {
        return [];
      }
    }

    const params = new URLSearchParams({
      sessionId: sessionId!,
      minutes: Math.min(minutes, 1440).toString(),
      maxCount: Math.min(maxCount, 288).toString(),
    });

    const response = await fetch(
      `${DEXCOM_SHARE_BASE_URL}/Publisher/ReadPublisherLatestGlucoseValues?${params}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      // Session might have expired, try re-authenticating once
      console.warn(`Share API request failed: ${response.status}, re-authenticating...`);
      sessionId = null;
      const authenticated = await authenticate();
      if (!authenticated) {
        return [];
      }

      // Retry with new session
      const retryParams = new URLSearchParams({
        sessionId: sessionId!,
        minutes: Math.min(minutes, 1440).toString(),
        maxCount: Math.min(maxCount, 288).toString(),
      });

      const retryResponse = await fetch(
        `${DEXCOM_SHARE_BASE_URL}/Publisher/ReadPublisherLatestGlucoseValues?${retryParams}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      if (!retryResponse.ok) {
        console.warn('Share API retry failed, giving up');
        return [];
      }

      const retryData = await retryResponse.json();
      return processShareReadings(retryData);
    }

    const data = await response.json();
    return processShareReadings(data);
  } catch (error) {
    console.warn('Share API fetch error (non-fatal):', error);
    return [];
  }
}

/**
 * Process Share API readings into standard format
 */
function processShareReadings(data: DexcomShareReading[]): GlucoseReading[] {
  if (!Array.isArray(data)) {
    console.warn('Share API returned unexpected data format');
    return [];
  }

  const readings: GlucoseReading[] = data.map((reading) => {
    const recordedAt = parseShareDate(reading.WT);
    const trend = SHARE_TREND_MAP[reading.Trend] || 'none';

    return {
      value: reading.Value,
      trend,
      trendDescription: TREND_DESCRIPTIONS[trend] || 'Unknown',
      recordedAt,
      source: 'share' as const,
      systemTime: recordedAt,
      displayTime: recordedAt,
    };
  });

  // Store in database
  for (const reading of readings) {
    try {
      insertGlucoseReading(reading);
    } catch (error) {
      // Ignore duplicate errors
      if (!String(error).includes('UNIQUE')) {
        console.warn('Error storing Share reading:', error);
      }
    }
  }

  console.log(`✅ Fetched ${readings.length} readings from Share API`);
  return readings;
}

/**
 * Get the latest reading from Share API
 */
export async function getLatestShareReading(): Promise<GlucoseReading | null> {
  const readings = await fetchShareReadings(10, 1); // Last 10 minutes, 1 reading
  return readings.length > 0 ? readings[0] : null;
}
