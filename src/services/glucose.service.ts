import type { GlucoseReading, GlucoseStatistics } from '../types/index.js';
import { TARGET_RANGE } from '../types/index.js';
import { getReadingsInRange, getLatestReading as getLatestFromDb } from '../db/queries.js';
import { fetchEGVs } from './dexcom-api.service.js';
import { getLatestShareReading } from './dexcom-share.service.js';

/**
 * Glucose Service
 * Aggregation and statistics layer that works with data from SQLite
 */

/**
 * Get the latest glucose reading
 * Try both Dexcom API and Share, return the freshest data
 *
 * NOTE: The Dexcom V3 API has a data delay (~1 hour US, ~3 hours international).
 * Share API typically has more recent data, so we try both and compare timestamps.
 */
export async function getLatestReading(): Promise<GlucoseReading | null> {
  let apiReading: GlucoseReading | null = null;
  let shareReading: GlucoseReading | null = null;

  // Try getting from API first (last 4 hours to account for Dexcom data delay)
  try {
    const now = new Date();
    const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);

    console.error(`[API] Fetching EGVs from ${fourHoursAgo.toISOString()} to ${now.toISOString()}`);
    const apiReadings = await fetchEGVs(fourHoursAgo.toISOString(), now.toISOString());

    if (apiReadings.length > 0) {
      // Sort by timestamp to ensure we get the most recent
      apiReadings.sort((a, b) =>
        new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime()
      );
      apiReading = apiReadings[0];

      const ageMinutes = Math.floor((Date.now() - new Date(apiReading.recordedAt).getTime()) / 1000 / 60);
      console.error(`[API] Latest reading is ${ageMinutes} minutes old (${apiReading.recordedAt})`);
    } else {
      console.error('[API] Returned 0 readings in the last 4 hours');
    }
  } catch (error) {
    console.error('[API] Failed to fetch:', error);
  }

  // Always try Share API for comparison (it's often more current)
  try {
    shareReading = await getLatestShareReading();
    if (shareReading) {
      const ageMinutes = Math.floor((Date.now() - new Date(shareReading.recordedAt).getTime()) / 1000 / 60);
      console.error(`[Share] Latest reading is ${ageMinutes} minutes old (${shareReading.recordedAt})`);
    }
  } catch (error) {
    console.error('[Share] Failed to fetch:', error);
  }

  // Return whichever is more recent
  if (apiReading && shareReading) {
    const apiTime = new Date(apiReading.recordedAt).getTime();
    const shareTime = new Date(shareReading.recordedAt).getTime();

    if (shareTime > apiTime) {
      console.error(`✅ Using Share reading (${Math.floor((shareTime - apiTime) / 1000 / 60)} minutes newer)`);
      return shareReading;
    } else {
      console.error(`✅ Using API reading (${Math.floor((apiTime - shareTime) / 1000 / 60)} minutes newer)`);
      return apiReading;
    }
  }

  // Return whichever one we got
  if (shareReading) {
    console.error('✅ Using Share reading (API had no data)');
    return shareReading;
  }

  if (apiReading) {
    console.error('✅ Using API reading (Share had no data)');
    return apiReading;
  }

  // Fall back to database
  console.error('[DB] Falling back to database');
  return getLatestFromDb();
}

/**
 * Get readings within a date range
 * Fetch from DB, backfill from API if gaps detected
 */
export async function getReadings(startDate: string, endDate: string): Promise<GlucoseReading[]> {
  // First, get what's in the database
  const dbReadings = getReadingsInRange(startDate, endDate);

  // If we have recent data, return it
  const start = new Date(startDate);
  const end = new Date(endDate);
  const rangeDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);

  // If range is more than 90 days, split into chunks and fetch
  if (rangeDays > 90) {
    console.warn('Date range exceeds 90 days, fetching in chunks...');
    const chunks: Array<{ start: Date; end: Date }> = [];
    let currentStart = start;

    while (currentStart < end) {
      const currentEnd = new Date(Math.min(currentStart.getTime() + 90 * 24 * 60 * 60 * 1000, end.getTime()));
      chunks.push({ start: currentStart, end: currentEnd });
      currentStart = new Date(currentEnd.getTime() + 1);
    }

    // Fetch each chunk
    for (const chunk of chunks) {
      try {
        await fetchEGVs(chunk.start.toISOString(), chunk.end.toISOString());
      } catch (error) {
        console.warn(`Failed to fetch chunk ${chunk.start} - ${chunk.end}:`, error);
      }
    }

    // Re-fetch from database after backfilling
    return getReadingsInRange(startDate, endDate);
  }

  // If we have a reasonable number of readings, return them
  // Expected: ~288 readings per day (every 5 minutes)
  const expectedReadings = rangeDays * 288;
  const hasEnoughData = dbReadings.length >= expectedReadings * 0.8; // 80% threshold

  if (!hasEnoughData) {
    // Try to backfill from API
    try {
      console.error('Backfilling data from API...');
      await fetchEGVs(startDate, endDate);
      return getReadingsInRange(startDate, endDate);
    } catch (error) {
      console.warn('Failed to backfill from API:', error);
    }
  }

  return dbReadings;
}

/**
 * Calculate comprehensive glucose statistics
 */
export function calculateStatistics(readings: GlucoseReading[]): GlucoseStatistics {
  if (readings.length === 0) {
    return {
      average: 0,
      standardDeviation: 0,
      min: 0,
      max: 0,
      timeInRange: 0,
      timeBelowRange: 0,
      timeAboveRange: 0,
      readingCount: 0,
      coefficientOfVariation: 0,
    };
  }

  const values = readings.map((r) => r.value);
  const count = values.length;

  // Basic stats
  const sum = values.reduce((acc, val) => acc + val, 0);
  const average = sum / count;

  const min = Math.min(...values);
  const max = Math.max(...values);

  // Standard deviation
  const squaredDiffs = values.map((val) => Math.pow(val - average, 2));
  const variance = squaredDiffs.reduce((acc, val) => acc + val, 0) / count;
  const standardDeviation = Math.sqrt(variance);

  // Coefficient of variation (CV%)
  const coefficientOfVariation = (standardDeviation / average) * 100;

  // Time in ranges
  const inRange = values.filter((v) => v >= TARGET_RANGE.LOW && v <= TARGET_RANGE.HIGH).length;
  const belowRange = values.filter((v) => v < TARGET_RANGE.LOW).length;
  const aboveRange = values.filter((v) => v > TARGET_RANGE.HIGH).length;

  const timeInRange = (inRange / count) * 100;
  const timeBelowRange = (belowRange / count) * 100;
  const timeAboveRange = (aboveRange / count) * 100;

  return {
    average: Math.round(average),
    standardDeviation: Math.round(standardDeviation),
    min,
    max,
    timeInRange: Math.round(timeInRange),
    timeBelowRange: Math.round(timeBelowRange),
    timeAboveRange: Math.round(timeAboveRange),
    readingCount: count,
    coefficientOfVariation: Math.round(coefficientOfVariation),
  };
}

/**
 * Calculate time in range with custom thresholds
 */
export function getTimeInRange(
  readings: GlucoseReading[],
  low: number = TARGET_RANGE.LOW,
  high: number = TARGET_RANGE.HIGH
): number {
  if (readings.length === 0) return 0;

  const inRange = readings.filter((r) => r.value >= low && r.value <= high).length;
  return (inRange / readings.length) * 100;
}

/**
 * Get daily summary for a specific date
 */
export async function getDailySummary(date: string): Promise<{
  date: string;
  statistics: GlucoseStatistics;
  readings: GlucoseReading[];
}> {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const readings = await getReadings(startOfDay.toISOString(), endOfDay.toISOString());
  const statistics = calculateStatistics(readings);

  return {
    date,
    statistics,
    readings,
  };
}

/**
 * Classify trend arrow into human-readable description
 * (Already handled in types, but provided for convenience)
 */
export function classifyTrend(trend: string): string {
  const descriptions: Record<string, string> = {
    doubleUp: 'Rising rapidly (>3 mg/dL per minute)',
    singleUp: 'Rising (2-3 mg/dL per minute)',
    fortyFiveUp: 'Rising slightly (1-2 mg/dL per minute)',
    flat: 'Stable',
    fortyFiveDown: 'Falling slightly (1-2 mg/dL per minute)',
    singleDown: 'Falling (2-3 mg/dL per minute)',
    doubleDown: 'Falling rapidly (>3 mg/dL per minute)',
    none: 'No trend data available',
    notComputable: 'Trend not computable',
    rateOutOfRange: 'Rate of change out of range',
  };

  return descriptions[trend] || 'Unknown trend';
}
