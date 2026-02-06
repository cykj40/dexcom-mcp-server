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
 * Try Dexcom API first, fall back to Share, then fall back to DB
 *
 * NOTE: The Dexcom V3 API has a data delay (~1 hour US, ~3 hours international).
 * We look back 4 hours to account for this delay.
 */
export async function getLatestReading(): Promise<GlucoseReading | null> {
  // Try getting from API first (last 4 hours to account for Dexcom data delay)
  try {
    const now = new Date();
    const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);

    console.error(`Fetching EGVs from ${fourHoursAgo.toISOString()} to ${now.toISOString()}`);
    const apiReadings = await fetchEGVs(fourHoursAgo.toISOString(), now.toISOString());
    if (apiReadings.length > 0) {
      // Return the most recent reading
      return apiReadings[apiReadings.length - 1];
    }
    console.error('API returned 0 readings in the last 4 hours');
  } catch (error) {
    console.error('Failed to fetch latest from API, trying Share...', error);
  }

  // Try Share API
  try {
    const shareReading = await getLatestShareReading();
    if (shareReading) {
      return shareReading;
    }
  } catch (error) {
    console.warn('Failed to fetch from Share API, using DB...', error);
  }

  // Fall back to database
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
