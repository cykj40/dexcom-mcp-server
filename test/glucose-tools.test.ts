import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mockGlucoseReadings,
  mockStableGlucose,
  mockHighGlucose,
  mockLowGlucose,
} from './fixtures/glucose-fixtures.js';
import { createTestDb, closeTestDb, insertGlucoseReadings } from './helpers/test-db.js';

// Mock the config/env module to prevent validation errors
vi.mock('../src/config/env.js', () => ({
  env: {
    DEXCOM_CLIENT_ID: 'test-client-id',
    DEXCOM_CLIENT_SECRET: 'test-client-secret',
    DEXCOM_REDIRECT_URI: 'http://localhost:3000/callback',
    DEXCOM_ACCESS_TOKEN: 'test-access-token',
    DEXCOM_REFRESH_TOKEN: 'test-refresh-token',
    DEXCOM_API_ENV: 'sandbox',
    SERVER_TIMEZONE: 'UTC',
    DB_PATH: ':memory:',
  },
}));

// Mock the services
vi.mock('../src/services/glucose.service.js', () => ({
  getLatestReading: vi.fn(),
  getReadings: vi.fn(),
  getDailySummary: vi.fn(),
  calculateStatistics: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  getLatestReading: vi.fn(),
  getReadingsInRange: vi.fn(),
}));

vi.mock('../src/services/dexcom-api.service.js', () => ({
  fetchEGVs: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/services/dexcom-share.service.js', () => ({
  getLatestShareReading: vi.fn().mockResolvedValue(null),
}));

import {
  getLatestGlucoseHandler,
  getGlucoseRangeHandler,
  getDailySummaryHandler,
  getGlucoseStatisticsHandler,
} from '../src/tools/glucose-tools.js';

import * as glucoseService from '../src/services/glucose.service.js';

describe('Glucose Tools', () => {
  let db: any;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeTestDb();
  });

  describe('get_latest_glucose', () => {
    it('should return the latest glucose reading with all expected fields', async () => {
      vi.mocked(glucoseService.getLatestReading).mockResolvedValue(mockStableGlucose);

      const result = await getLatestGlucoseHandler();

      console.log('\n=== get_latest_glucose TEST ===');
      console.log('Input: None (gets latest reading)');
      console.log('Response:', result.content[0].text);

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        value: expect.any(Number),
        unit: 'mg/dL',
        trend: expect.any(String),
        trendDescription: expect.any(String),
        timestamp: expect.any(String),
        ageMinutes: expect.any(Number),
        source: expect.stringMatching(/^(api|share)$/),
      });

      expect(data.value).toBeGreaterThan(0);
      expect(data.value).toBeLessThan(500);
    });

    it('should handle high glucose reading', async () => {
      vi.mocked(glucoseService.getLatestReading).mockResolvedValue(mockHighGlucose);

      const result = await getLatestGlucoseHandler();
      const data = JSON.parse(result.content[0].text);

      console.log('\nHigh Glucose Sample:', JSON.stringify(data, null, 2));

      expect(data.value).toBeGreaterThan(180);
      expect(data.trend).toBeTruthy();
    });

    it('should handle low glucose reading', async () => {
      vi.mocked(glucoseService.getLatestReading).mockResolvedValue(mockLowGlucose);

      const result = await getLatestGlucoseHandler();
      const data = JSON.parse(result.content[0].text);

      console.log('\nLow Glucose Sample:', JSON.stringify(data, null, 2));

      expect(data.value).toBeLessThan(70);
      expect(data.trend).toBeTruthy();
    });

    it('should handle no glucose readings available', async () => {
      vi.mocked(glucoseService.getLatestReading).mockResolvedValue(null);

      const result = await getLatestGlucoseHandler();

      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('No glucose readings available');
    });
  });

  describe('get_glucose_range', () => {
    it('should return glucose readings within a time range', async () => {
      vi.mocked(glucoseService.getReadings).mockResolvedValue(mockGlucoseReadings);
      vi.mocked(glucoseService.calculateStatistics).mockReturnValue({
        average: 118,
        standardDeviation: 28,
        min: 68,
        max: 165,
        timeInRange: 75,
        timeBelowRange: 8,
        timeAboveRange: 17,
        readingCount: 12,
        coefficientOfVariation: 24,
      });

      const args = {
        start_time: '2024-01-15T00:00:00Z',
        end_time: '2024-01-15T23:59:59Z',
      };

      const result = await getGlucoseRangeHandler(args);

      console.log('\n=== get_glucose_range TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));
      console.log('Response:', result.content[0].text);

      expect(result.content[0].type).toBe('text');

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        timeRange: {
          start: args.start_time,
          end: args.end_time,
        },
        readingCount: expect.any(Number),
        statistics: expect.objectContaining({
          average: expect.any(Number),
          standardDeviation: expect.any(Number),
          min: expect.any(Number),
          max: expect.any(Number),
          timeInRange: expect.any(Number),
          timeBelowRange: expect.any(Number),
          timeAboveRange: expect.any(Number),
        }),
        readings: expect.any(Array),
      });

      expect(data.readings.length).toBeGreaterThan(0);
      expect(data.readings[0]).toMatchObject({
        value: expect.any(Number),
        trend: expect.any(String),
        timestamp: expect.any(String),
      });

      console.log('\nFirst Reading Sample:', JSON.stringify(data.readings[0], null, 2));
      console.log('Statistics Sample:', JSON.stringify(data.statistics, null, 2));
    });

    it('should handle empty date range', async () => {
      vi.mocked(glucoseService.getReadings).mockResolvedValue([]);

      const args = {
        start_time: '2024-01-01T00:00:00Z',
        end_time: '2024-01-01T01:00:00Z',
      };

      const result = await getGlucoseRangeHandler(args);
      const data = result.content[0].text;

      expect(data).toContain('No glucose readings found');
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(glucoseService.getReadings).mockRejectedValue(new Error('API failure'));

      const args = {
        start_time: '2024-01-15T00:00:00Z',
        end_time: '2024-01-15T23:59:59Z',
      };

      const result = await getGlucoseRangeHandler(args);

      expect(result.content[0].text).toContain('Error fetching glucose range');
      expect(result.isError).toBe(true);
    });
  });

  describe('get_daily_summary', () => {
    it('should return daily summary with statistics', async () => {
      const mockSummary = {
        date: '2024-01-15',
        statistics: {
          average: 118,
          standardDeviation: 28,
          min: 68,
          max: 165,
          timeInRange: 75,
          timeBelowRange: 8,
          timeAboveRange: 17,
          readingCount: 288,
          coefficientOfVariation: 24,
        },
        readings: mockGlucoseReadings,
      };

      vi.mocked(glucoseService.getDailySummary).mockResolvedValue(mockSummary);

      const args = { date: '2024-01-15' };
      const result = await getDailySummaryHandler(args);

      console.log('\n=== get_daily_summary TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));
      console.log('Response:', result.content[0].text);

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        date: '2024-01-15',
        statistics: expect.objectContaining({
          average: expect.any(Number),
          timeInRange: expect.any(Number),
          readingCount: expect.any(Number),
        }),
        readingCount: expect.any(Number),
      });

      console.log('\nDaily Statistics Sample:', JSON.stringify(data.statistics, null, 2));
    });

    it('should default to today when no date provided', async () => {
      const today = new Date().toISOString().split('T')[0];
      const mockSummary = {
        date: today,
        statistics: {
          average: 120,
          standardDeviation: 25,
          min: 80,
          max: 160,
          timeInRange: 90,
          timeBelowRange: 5,
          timeAboveRange: 5,
          readingCount: 288,
          coefficientOfVariation: 21,
        },
        readings: mockGlucoseReadings,
      };

      vi.mocked(glucoseService.getDailySummary).mockResolvedValue(mockSummary);

      const result = await getDailySummaryHandler({});
      const data = JSON.parse(result.content[0].text);

      expect(data.date).toBe(today);
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(glucoseService.getDailySummary).mockRejectedValue(new Error('Database error'));

      const result = await getDailySummaryHandler({ date: '2024-01-15' });

      expect(result.content[0].text).toContain('Error fetching daily summary');
      expect(result.isError).toBe(true);
    });
  });

  describe('get_glucose_statistics', () => {
    it('should return statistics for specified hours', async () => {
      vi.mocked(glucoseService.getReadings).mockResolvedValue(mockGlucoseReadings);
      vi.mocked(glucoseService.calculateStatistics).mockReturnValue({
        average: 118,
        standardDeviation: 28,
        min: 68,
        max: 165,
        timeInRange: 75,
        timeBelowRange: 8,
        timeAboveRange: 17,
        readingCount: 12,
        coefficientOfVariation: 24,
      });

      const args = { hours: 24 };
      const result = await getGlucoseStatisticsHandler(args);

      console.log('\n=== get_glucose_statistics TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));
      console.log('Response:', result.content[0].text);

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        timeRange: {
          start: expect.any(String),
          end: expect.any(String),
          hours: 24,
        },
        statistics: expect.objectContaining({
          average: expect.any(Number),
          standardDeviation: expect.any(Number),
          timeInRange: expect.any(Number),
          coefficientOfVariation: expect.any(Number),
        }),
      });

      console.log('\nStatistics Sample:', JSON.stringify(data.statistics, null, 2));

      // Validate time ranges add up to 100%
      const { timeInRange, timeBelowRange, timeAboveRange } = data.statistics;
      expect(timeInRange + timeBelowRange + timeAboveRange).toBe(100);
    });

    it('should default to 24 hours when not specified', async () => {
      vi.mocked(glucoseService.getReadings).mockResolvedValue(mockGlucoseReadings);
      vi.mocked(glucoseService.calculateStatistics).mockReturnValue({
        average: 120,
        standardDeviation: 25,
        min: 70,
        max: 180,
        timeInRange: 85,
        timeBelowRange: 5,
        timeAboveRange: 10,
        readingCount: 12,
        coefficientOfVariation: 21,
      });

      const result = await getGlucoseStatisticsHandler({});
      const data = JSON.parse(result.content[0].text);

      expect(data.timeRange.hours).toBe(24);
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(glucoseService.getReadings).mockRejectedValue(new Error('Service error'));

      const result = await getGlucoseStatisticsHandler({ hours: 12 });

      expect(result.content[0].text).toContain('Error calculating statistics');
      expect(result.isError).toBe(true);
    });
  });
});
