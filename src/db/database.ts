import Database from 'better-sqlite3';
import { env } from '../config/env.js';

let db: Database.Database | null = null;

/**
 * Get or create SQLite database connection
 * Singleton pattern - returns the same instance on subsequent calls
 */
export function getDb(): Database.Database {
  if (!db) {
    db = new Database(env.DB_PATH);

    // Enable WAL mode for better concurrent read performance
    db.pragma('journal_mode = WAL');

    // Enable foreign key constraints
    db.pragma('foreign_keys = ON');

    console.error(`✅ Database connected: ${env.DB_PATH}`);
  }

  return db;
}

/**
 * Close the database connection
 * Should be called on application shutdown
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    console.error('Database connection closed');
  }
}
