import { getDb } from './database.js';

/**
 * Run all database migrations
 * Creates tables and indexes on first run
 */
export function runMigrations(): void {
  const db = getDb();

  console.error('Running database migrations...');

  // Glucose readings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS glucose_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      value INTEGER NOT NULL,
      trend TEXT NOT NULL,
      trend_description TEXT,
      recorded_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'api',
      system_time TEXT NOT NULL,
      display_time TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(recorded_at, source)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_readings_recorded_at
    ON glucose_readings(recorded_at);
  `);

  // Insulin events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS insulin_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      units REAL NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('rapid', 'long_acting', 'correction')),
      timestamp TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_insulin_timestamp
    ON insulin_events(timestamp);
  `);

  // Carb events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS carb_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grams REAL NOT NULL,
      food_description TEXT,
      estimated_gi TEXT CHECK (estimated_gi IN ('low', 'medium', 'high')),
      confidence TEXT CHECK (confidence IN ('low', 'medium', 'high')),
      timestamp TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_carb_timestamp
    ON carb_events(timestamp);
  `);

  // Exercise events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS exercise_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_type TEXT NOT NULL,
      duration_minutes INTEGER,
      intensity TEXT CHECK (intensity IN ('low', 'moderate', 'high')),
      timestamp TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_exercise_timestamp
    ON exercise_events(timestamp);
  `);

  // Adaptive observations table
  db.exec(`
    CREATE TABLE IF NOT EXISTS adaptive_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_type TEXT NOT NULL,
      expected_value REAL,
      actual_value REAL,
      deviation_pct REAL,
      context TEXT,
      hypothesis TEXT,
      timestamp TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_observations_timestamp
    ON adaptive_observations(timestamp);
  `);

  console.error('✅ Migrations completed');
}
