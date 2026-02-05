import { getDb } from './database.js';
import type {
  GlucoseReading,
  InsulinEvent,
  CarbEvent,
  ExerciseEvent,
  AdaptiveObservation,
} from '../types/index.js';

// ============================================================================
// Glucose Reading Queries
// ============================================================================

/**
 * Insert or update a glucose reading (upsert on recorded_at + source)
 */
export function insertGlucoseReading(reading: GlucoseReading): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO glucose_readings (
      value, trend, trend_description, recorded_at, source, system_time, display_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(recorded_at, source) DO UPDATE SET
      value = excluded.value,
      trend = excluded.trend,
      trend_description = excluded.trend_description,
      system_time = excluded.system_time,
      display_time = excluded.display_time
  `);

  stmt.run(
    reading.value,
    reading.trend,
    reading.trendDescription,
    reading.recordedAt,
    reading.source,
    reading.systemTime || reading.recordedAt,
    reading.displayTime || reading.recordedAt
  );
}

/**
 * Get glucose readings within a date range
 */
export function getReadingsInRange(startDate: string, endDate: string): GlucoseReading[] {
  const db = getDb();
  const stmt = db.prepare(`
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
  `);

  return stmt.all(startDate, endDate) as GlucoseReading[];
}

/**
 * Get the most recent glucose reading
 */
export function getLatestReading(): GlucoseReading | null {
  const db = getDb();
  const stmt = db.prepare(`
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
  `);

  const result = stmt.get() as GlucoseReading | undefined;
  return result || null;
}

/**
 * Get reading count in date range
 */
export function getReadingCount(startDate: string, endDate: string): number {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM glucose_readings
    WHERE recorded_at >= ? AND recorded_at <= ?
  `);

  const result = stmt.get(startDate, endDate) as { count: number };
  return result.count;
}

// ============================================================================
// Insulin Event Queries
// ============================================================================

/**
 * Insert an insulin event
 */
export function insertInsulinEvent(event: InsulinEvent): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO insulin_events (units, type, timestamp, notes)
    VALUES (?, ?, ?, ?)
  `);

  const result = stmt.run(event.units, event.type, event.timestamp, event.notes || null);
  return Number(result.lastInsertRowid);
}

/**
 * Get insulin events within a date range
 */
export function getInsulinEvents(startDate: string, endDate: string): InsulinEvent[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT id, units, type, timestamp, notes, created_at as createdAt
    FROM insulin_events
    WHERE timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
  `);

  return stmt.all(startDate, endDate) as InsulinEvent[];
}

// ============================================================================
// Carb Event Queries
// ============================================================================

/**
 * Insert a carb event
 */
export function insertCarbEvent(event: CarbEvent): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO carb_events (grams, food_description, estimated_gi, confidence, timestamp, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    event.grams,
    event.foodDescription || null,
    event.estimatedGi || null,
    event.confidence || null,
    event.timestamp,
    event.notes || null
  );
  return Number(result.lastInsertRowid);
}

/**
 * Get carb events within a date range
 */
export function getCarbEvents(startDate: string, endDate: string): CarbEvent[] {
  const db = getDb();
  const stmt = db.prepare(`
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
  `);

  return stmt.all(startDate, endDate) as CarbEvent[];
}

// ============================================================================
// Exercise Event Queries
// ============================================================================

/**
 * Insert an exercise event
 */
export function insertExerciseEvent(event: ExerciseEvent): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO exercise_events (activity_type, duration_minutes, intensity, timestamp, notes)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    event.activityType,
    event.durationMinutes || null,
    event.intensity || null,
    event.timestamp,
    event.notes || null
  );
  return Number(result.lastInsertRowid);
}

/**
 * Get exercise events within a date range
 */
export function getExerciseEvents(startDate: string, endDate: string): ExerciseEvent[] {
  const db = getDb();
  const stmt = db.prepare(`
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
  `);

  return stmt.all(startDate, endDate) as ExerciseEvent[];
}

// ============================================================================
// Adaptive Observation Queries
// ============================================================================

/**
 * Insert an adaptive observation
 */
export function insertAdaptiveObservation(obs: AdaptiveObservation): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO adaptive_observations (
      observation_type, expected_value, actual_value, deviation_pct,
      context, hypothesis, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    obs.observationType,
    obs.expectedValue,
    obs.actualValue,
    obs.deviationPct,
    JSON.stringify(obs.context),
    obs.hypothesis,
    obs.timestamp
  );
  return Number(result.lastInsertRowid);
}

/**
 * Get recent adaptive observations
 */
export function getRecentObservations(days: number): AdaptiveObservation[] {
  const db = getDb();
  const stmt = db.prepare(`
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
  `);

  const results = stmt.all(days) as Array<Omit<AdaptiveObservation, 'context'> & { context: string }>;

  return results.map((row) => ({
    ...row,
    context: JSON.parse(row.context),
  }));
}

/**
 * Get observations by type
 */
export function getObservationsByType(type: string, days: number): AdaptiveObservation[] {
  const db = getDb();
  const stmt = db.prepare(`
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
  `);

  const results = stmt.all(type, days) as Array<Omit<AdaptiveObservation, 'context'> & { context: string }>;

  return results.map((row) => ({
    ...row,
    context: JSON.parse(row.context),
  }));
}
