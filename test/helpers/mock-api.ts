import { vi } from 'vitest';
import type { GlucoseReading } from '../../src/types/index.js';

/**
 * Mock API helpers
 * Provides mocked versions of external API services for testing
 */

/**
 * Mock Dexcom API service
 */
export function mockDexcomApiService() {
  return {
    fetchEGVs: vi.fn().mockResolvedValue([]),
    refreshAccessToken: vi.fn().mockResolvedValue('mock-token'),
  };
}

/**
 * Mock Dexcom Share API service
 */
export function mockDexcomShareService() {
  return {
    getLatestShareReading: vi.fn().mockResolvedValue(null),
    authenticate: vi.fn().mockResolvedValue('mock-session-id'),
  };
}

/**
 * Create a mock glucose service that returns predefined readings
 */
export function createMockGlucoseService(mockReadings: GlucoseReading[]) {
  return {
    getLatestReading: vi.fn().mockResolvedValue(mockReadings[0] || null),
    getReadings: vi.fn().mockResolvedValue(mockReadings),
    getDailySummary: vi.fn().mockResolvedValue({
      date: '2024-01-15',
      statistics: {
        average: 120,
        standardDeviation: 30,
        min: 70,
        max: 180,
        timeInRange: 85,
        timeBelowRange: 5,
        timeAboveRange: 10,
        readingCount: mockReadings.length,
        coefficientOfVariation: 25,
      },
      readings: mockReadings,
    }),
    calculateStatistics: vi.fn().mockReturnValue({
      average: 120,
      standardDeviation: 30,
      min: 70,
      max: 180,
      timeInRange: 85,
      timeBelowRange: 5,
      timeAboveRange: 10,
      readingCount: mockReadings.length,
      coefficientOfVariation: 25,
    }),
  };
}

/**
 * Mock environment variables for testing
 */
export function setupMockEnv() {
  process.env.DEXCOM_CLIENT_ID = 'test-client-id';
  process.env.DEXCOM_CLIENT_SECRET = 'test-client-secret';
  process.env.DEXCOM_REDIRECT_URI = 'http://localhost:3000/callback';
  process.env.DEXCOM_ACCESS_TOKEN = 'test-access-token';
  process.env.DEXCOM_REFRESH_TOKEN = 'test-refresh-token';
  process.env.DEXCOM_API_ENV = 'sandbox';
  process.env.DB_PATH = ':memory:';
}

/**
 * Clean up mock environment
 */
export function cleanupMockEnv() {
  delete process.env.DEXCOM_CLIENT_ID;
  delete process.env.DEXCOM_CLIENT_SECRET;
  delete process.env.DEXCOM_REDIRECT_URI;
  delete process.env.DEXCOM_ACCESS_TOKEN;
  delete process.env.DEXCOM_REFRESH_TOKEN;
  delete process.env.DEXCOM_API_ENV;
  delete process.env.DB_PATH;
}
