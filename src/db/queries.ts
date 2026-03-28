import { getDb } from './database.js';
import type { Value } from '@libsql/client';
import type {
  GlucoseReading,
  InsulinEvent,
  CarbEvent,
  ExerciseEvent,
  AdaptiveObservation,
} from '../types/index.js';

// ============================================================================
// Row helpers
// ============================================================================

function str(v: Value): string {
  return v != null ? String(v) : '';
}

function num(v: Value): number {
  return Number(v);
}

function optStr(v: Value): string | undefined {
  return v != null ? String(v) : undefined;
}

function optNum(v: Value): number | undefined {
  return v != null ? Number(v) : undefined;
}

// ============================================================================
// Glucose Reading Queries
// ============================================================================

/**
 * Insert or update a glucose reading (upsert on recorded_at + source)
 */
export async function insertGlucoseReading(reading: GlucoseReading): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `
      INSERT INTO glucose_readings (
        value, trend, trend_description, recorded_at, source, system_time, display_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(recorded_at, source) DO UPDATE SET
        value = excluded.value,
        trend = excluded.trend,
        trend_description = excluded.trend_description,
        system_time = excluded.system_time,
        display_time = excluded.display_time
    `,
    args: [
      reading.value,
      reading.trend,
      reading.trendDescription ?? null,
      reading.recordedAt,
      reading.source,
      reading.systemTime ?? reading.recordedAt,
      reading.displayTime ?? reading.recordedAt,
    ],
  });
}

/**
 * Get glucose readings within a date range
 */
export async function getReadingsInRange(startDate: string, endDate: string): Promise<GlucoseReading[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `
      SELECT
        value,
        trend,
        trend_description as trendDescription,
        recorded_at as recordedAt,
        source,
        system_time as systemTime,
        display_time as displayTime
      FROM glucose_readings
      WHERE recorded_at >= ? AND recorded_at <= ?
      ORDER BY recorded_at ASC
    `,
    args: [startDate, endDate],
  });

  return result.rows.map((row) => ({
    value: num(row['value']),
    trend: str(row['trend']),
    trendDescription: str(row['trendDescription']),
    recordedAt: str(row['recordedAt']),
    source: str(row['source']) as 'api' | 'share',
    systemTime: optStr(row['systemTime']),
    displayTime: optStr(row['displayTime']),
  }));
}

/**
 * Get the most recent glucose reading
 */
export async function getLatestReading(): Promise<GlucoseReading | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `
      SELECT
        value,
        trend,
        trend_description as trendDescription,
        recorded_at as recordedAt,
        source,
        system_time as systemTime,
        display_time as displayTime
      FROM glucose_readings
      ORDER BY recorded_at DESC
      LIMIT 1
    `,
    args: [],
  });

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    value: num(row['value']),
    trend: str(row['trend']),
    trendDescription: str(row['trendDescription']),
    recordedAt: str(row['recordedAt']),
    source: str(row['source']) as 'api' | 'share',
    systemTime: optStr(row['systemTime']),
    displayTime: optStr(row['displayTime']),
  };
}

/**
 * Get reading count in date range
 */
export async function getReadingCount(startDate: string, endDate: string): Promise<number> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT COUNT(*) as count FROM glucose_readings WHERE recorded_at >= ? AND recorded_at <= ?`,
    args: [startDate, endDate],
  });
  return num(result.rows[0]?.['count'] ?? 0);
}

// ============================================================================
// Insulin Event Queries
// ============================================================================

/**
 * Insert an insulin event
 */
export async function insertInsulinEvent(event: InsulinEvent): Promise<number> {
  const db = getDb();
  const result = await db.execute({
    sql: `INSERT INTO insulin_events (units, type, timestamp, notes) VALUES (?, ?, ?, ?)`,
    args: [event.units, event.type, event.timestamp, event.notes ?? null],
  });
  return Number(result.lastInsertRowid);
}

/**
 * Get insulin events within a date range
 */
export async function getInsulinEvents(startDate: string, endDate: string): Promise<InsulinEvent[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `
      SELECT id, units, type, timestamp, notes, created_at as createdAt
      FROM insulin_events
      WHERE timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `,
    args: [startDate, endDate],
  });

  return result.rows.map((row) => ({
    id: optNum(row['id']),
    units: num(row['units']),
    type: str(row['type']) as 'rapid' | 'long_acting' | 'correction',
    timestamp: str(row['timestamp']),
    notes: optStr(row['notes']),
    createdAt: optStr(row['createdAt']),
  }));
}

// ============================================================================
// Carb Event Queries
// ============================================================================

/**
 * Insert a carb event
 */
export async function insertCarbEvent(event: CarbEvent): Promise<number> {
  const db = getDb();
  const result = await db.execute({
    sql: `
      INSERT INTO carb_events (grams, food_description, estimated_gi, confidence, timestamp, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    args: [
      event.grams,
      event.foodDescription ?? null,
      event.estimatedGi ?? null,
      event.confidence ?? null,
      event.timestamp,
      event.notes ?? null,
    ],
  });
  return Number(result.lastInsertRowid);
}

/**
 * Get carb events within a date range
 */
export async function getCarbEvents(startDate: string, endDate: string): Promise<CarbEvent[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `
      SELECT
        id,
        grams,
        food_description as foodDescription,
        estimated_gi as estimatedGi,
        confidence,
        timestamp,
        notes,
        created_at as createdAt
      FROM carb_events
      WHERE timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `,
    args: [startDate, endDate],
  });

  return result.rows.map((row) => ({
    id: optNum(row['id']),
    grams: num(row['grams']),
    foodDescription: optStr(row['foodDescription']),
    estimatedGi: optStr(row['estimatedGi']) as 'low' | 'medium' | 'high' | undefined,
    confidence: optStr(row['confidence']) as 'low' | 'medium' | 'high' | undefined,
    timestamp: str(row['timestamp']),
    notes: optStr(row['notes']),
    createdAt: optStr(row['createdAt']),
  }));
}

// ============================================================================
// Exercise Event Queries
// ============================================================================

/**
 * Insert an exercise event
 */
export async function insertExerciseEvent(event: ExerciseEvent): Promise<number> {
  const db = getDb();
  const result = await db.execute({
    sql: `
      INSERT INTO exercise_events (activity_type, duration_minutes, intensity, timestamp, notes)
      VALUES (?, ?, ?, ?, ?)
    `,
    args: [
      event.activityType,
      event.durationMinutes ?? null,
      event.intensity ?? null,
      event.timestamp,
      event.notes ?? null,
    ],
  });
  return Number(result.lastInsertRowid);
}

/**
 * Get exercise events within a date range
 */
export async function getExerciseEvents(startDate: string, endDate: string): Promise<ExerciseEvent[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `
      SELECT
        id,
        activity_type as activityType,
        duration_minutes as durationMinutes,
        intensity,
        timestamp,
        notes,
        created_at as createdAt
      FROM exercise_events
      WHERE timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `,
    args: [startDate, endDate],
  });

  return result.rows.map((row) => ({
    id: optNum(row['id']),
    activityType: str(row['activityType']),
    durationMinutes: optNum(row['durationMinutes']),
    intensity: optStr(row['intensity']) as 'low' | 'moderate' | 'high' | undefined,
    timestamp: str(row['timestamp']),
    notes: optStr(row['notes']),
    createdAt: optStr(row['createdAt']),
  }));
}

// ============================================================================
// Adaptive Observation Queries
// ============================================================================

/**
 * Insert an adaptive observation
 */
export async function insertAdaptiveObservation(obs: AdaptiveObservation): Promise<number> {
  const db = getDb();
  const result = await db.execute({
    sql: `
      INSERT INTO adaptive_observations (
        observation_type, expected_value, actual_value, deviation_pct,
        context, hypothesis, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      obs.observationType,
      obs.expectedValue,
      obs.actualValue,
      obs.deviationPct,
      JSON.stringify(obs.context),
      obs.hypothesis,
      obs.timestamp,
    ],
  });
  return Number(result.lastInsertRowid);
}

/**
 * Get recent adaptive observations
 */
export async function getRecentObservations(days: number): Promise<AdaptiveObservation[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `
      SELECT
        id,
        observation_type as observationType,
        expected_value as expectedValue,
        actual_value as actualValue,
        deviation_pct as deviationPct,
        context,
        hypothesis,
        timestamp,
        created_at as createdAt
      FROM adaptive_observations
      WHERE timestamp >= datetime('now', '-' || ? || ' days')
      ORDER BY timestamp DESC
    `,
    args: [days],
  });

  return result.rows.map((row) => ({
    id: optNum(row['id']),
    observationType: str(row['observationType']),
    expectedValue: num(row['expectedValue']),
    actualValue: num(row['actualValue']),
    deviationPct: num(row['deviationPct']),
    context: JSON.parse(str(row['context']) || '{}') as Record<string, unknown>,
    hypothesis: str(row['hypothesis']),
    timestamp: str(row['timestamp']),
    createdAt: optStr(row['createdAt']),
  }));
}

/**
 * Get observations by type
 */
export async function getObservationsByType(type: string, days: number): Promise<AdaptiveObservation[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `
      SELECT
        id,
        observation_type as observationType,
        expected_value as expectedValue,
        actual_value as actualValue,
        deviation_pct as deviationPct,
        context,
        hypothesis,
        timestamp,
        created_at as createdAt
      FROM adaptive_observations
      WHERE observation_type = ?
        AND timestamp >= datetime('now', '-' || ? || ' days')
      ORDER BY timestamp DESC
    `,
    args: [type, days],
  });

  return result.rows.map((row) => ({
    id: optNum(row['id']),
    observationType: str(row['observationType']),
    expectedValue: num(row['expectedValue']),
    actualValue: num(row['actualValue']),
    deviationPct: num(row['deviationPct']),
    context: JSON.parse(str(row['context']) || '{}') as Record<string, unknown>,
    hypothesis: str(row['hypothesis']),
    timestamp: str(row['timestamp']),
    createdAt: optStr(row['createdAt']),
  }));
}
