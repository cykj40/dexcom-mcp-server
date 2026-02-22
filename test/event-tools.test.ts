import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mockInsulinEvents,
  mockCarbEvents,
  mockExerciseEvents,
} from './fixtures/event-fixtures.js';
import {
  createTestDb,
  closeTestDb,
  insertInsulinEvents,
  insertCarbEvents,
  insertExerciseEvents,
  insertGlucoseReadings,
} from './helpers/test-db.js';
import { mockGlucoseReadings } from './fixtures/glucose-fixtures.js';

// Mock the config/env module to prevent validation errors
vi.mock('../src/config/env.js', () => ({
  env: {
    DEXCOM_CLIENT_ID: 'test-client-id',
    DEXCOM_CLIENT_SECRET: 'test-client-secret',
    DEXCOM_REDIRECT_URI: 'http://localhost:3000/callback',
    DEXCOM_ACCESS_TOKEN: 'test-access-token',
    DEXCOM_REFRESH_TOKEN: 'test-refresh-token',
    DEXCOM_API_ENV: 'sandbox',
    DB_PATH: ':memory:',
  },
}));

// Mock the services
vi.mock('../src/services/events.service.js', () => ({
  logInsulin: vi.fn(),
  logCarbs: vi.fn(),
  logExercise: vi.fn(),
  getEventTimeline: vi.fn(),
  getEventsSummary: vi.fn(),
  getInsulinEvents: vi.fn(),
  getCarbEvents: vi.fn(),
  getExerciseEvents: vi.fn(),
}));

import {
  logInsulinHandler,
  logCarbsHandler,
  logExerciseHandler,
  getEventTimelineHandler,
  getInsulinEventsHandler,
  getCarbEventsHandler,
  getExerciseEventsHandler,
} from '../src/tools/event-tools.js';

import * as eventsService from '../src/services/events.service.js';

describe('Event Tools', () => {
  let db: any;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeTestDb();
  });

  describe('log_insulin', () => {
    it('should log insulin dose with all fields', async () => {
      vi.mocked(eventsService.logInsulin).mockReturnValue(1);

      const args = {
        units: 6.5,
        type: 'rapid' as const,
        timestamp: '2024-01-15T07:30:00Z',
        notes: 'Breakfast bolus',
      };

      const result = await logInsulinHandler(args);

      console.log('\n=== log_insulin TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));
      console.log('Response:', result.content[0].text);

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        success: true,
        eventId: expect.any(Number),
        message: expect.stringContaining('6.5u'),
        disclaimer: expect.stringContaining('assistive recommendation'),
      });

      expect(eventsService.logInsulin).toHaveBeenCalledWith({
        units: 6.5,
        type: 'rapid',
        timestamp: '2024-01-15T07:30:00Z',
        notes: 'Breakfast bolus',
      });
    });

    it('should handle long-acting insulin', async () => {
      vi.mocked(eventsService.logInsulin).mockReturnValue(2);

      const args = {
        units: 30,
        type: 'long_acting' as const,
      };

      const result = await logInsulinHandler(args);
      const data = JSON.parse(result.content[0].text);

      console.log('\nLong-acting Insulin Sample:', JSON.stringify(data, null, 2));

      expect(data.success).toBe(true);
      expect(data.message).toContain('long_acting');
    });

    it('should handle correction dose', async () => {
      vi.mocked(eventsService.logInsulin).mockReturnValue(3);

      const args = {
        units: 2.5,
        type: 'correction' as const,
      };

      const result = await logInsulinHandler(args);
      const data = JSON.parse(result.content[0].text);

      expect(data.success).toBe(true);
      expect(data.message).toContain('correction');
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(eventsService.logInsulin).mockImplementation(() => {
        throw new Error('Database error');
      });

      const result = await logInsulinHandler({ units: 5, type: 'rapid' });

      expect(result.content[0].text).toContain('Error logging insulin');
      expect(result.isError).toBe(true);
    });
  });

  describe('log_carbs', () => {
    it('should log carb intake with all fields', async () => {
      vi.mocked(eventsService.logCarbs).mockReturnValue(1);

      const args = {
        grams: 45,
        food_description: 'Oatmeal with berries',
        estimated_gi: 'low' as const,
        timestamp: '2024-01-15T07:30:00Z',
        notes: 'Breakfast',
      };

      const result = await logCarbsHandler(args);

      console.log('\n=== log_carbs TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));
      console.log('Response:', result.content[0].text);

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        success: true,
        eventId: expect.any(Number),
        message: expect.stringContaining('45g'),
        disclaimer: expect.stringContaining('You decide what, when, and how to eat'),
      });

      expect(eventsService.logCarbs).toHaveBeenCalledWith({
        grams: 45,
        foodDescription: 'Oatmeal with berries',
        estimatedGi: 'low',
        timestamp: '2024-01-15T07:30:00Z',
        notes: 'Breakfast',
      });
    });

    it('should handle minimal carb input', async () => {
      vi.mocked(eventsService.logCarbs).mockReturnValue(2);

      const args = { grams: 15 };
      const result = await logCarbsHandler(args);
      const data = JSON.parse(result.content[0].text);

      console.log('\nMinimal Carb Input Sample:', JSON.stringify(data, null, 2));

      expect(data.success).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(eventsService.logCarbs).mockImplementation(() => {
        throw new Error('Database error');
      });

      const result = await logCarbsHandler({ grams: 30 });

      expect(result.content[0].text).toContain('Error logging carbs');
      expect(result.isError).toBe(true);
    });
  });

  describe('log_exercise', () => {
    it('should log exercise with all fields', async () => {
      vi.mocked(eventsService.logExercise).mockReturnValue(1);

      const args = {
        activity_type: 'running',
        duration_minutes: 45,
        intensity: 'high' as const,
        timestamp: '2024-01-15T17:00:00Z',
        notes: 'Evening run',
      };

      const result = await logExerciseHandler(args);

      console.log('\n=== log_exercise TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));
      console.log('Response:', result.content[0].text);

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        success: true,
        eventId: expect.any(Number),
        message: expect.stringContaining('running'),
      });

      expect(eventsService.logExercise).toHaveBeenCalledWith({
        activityType: 'running',
        durationMinutes: 45,
        intensity: 'high',
        timestamp: '2024-01-15T17:00:00Z',
        notes: 'Evening run',
      });
    });

    it('should handle minimal exercise input', async () => {
      vi.mocked(eventsService.logExercise).mockReturnValue(2);

      const args = { activity_type: 'walking' };
      const result = await logExerciseHandler(args);
      const data = JSON.parse(result.content[0].text);

      console.log('\nMinimal Exercise Input Sample:', JSON.stringify(data, null, 2));

      expect(data.success).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(eventsService.logExercise).mockImplementation(() => {
        throw new Error('Database error');
      });

      const result = await logExerciseHandler({ activity_type: 'swimming' });

      expect(result.content[0].text).toContain('Error logging exercise');
      expect(result.isError).toBe(true);
    });
  });

  describe('get_event_timeline', () => {
    it('should return timeline of all events with glucose context', async () => {
      const mockTimeline = [
        {
          timestamp: '2024-01-15T07:30:00Z',
          eventType: 'insulin' as const,
          data: mockInsulinEvents[0],
          glucoseContext: mockGlucoseReadings[0],
        },
        {
          timestamp: '2024-01-15T07:30:00Z',
          eventType: 'carbs' as const,
          data: mockCarbEvents[0],
          glucoseContext: mockGlucoseReadings[0],
        },
      ];

      const mockSummary = {
        totalInsulin: 13.0,
        totalCarbs: 120,
        totalExercise: 2,
      };

      vi.mocked(eventsService.getEventTimeline).mockReturnValue(mockTimeline);
      vi.mocked(eventsService.getEventsSummary).mockReturnValue(mockSummary);

      const args = {
        start_time: '2024-01-15T00:00:00Z',
        end_time: '2024-01-15T23:59:59Z',
      };

      const result = await getEventTimelineHandler(args);

      console.log('\n=== get_event_timeline TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));
      console.log('Response:', result.content[0].text);

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        period: {
          start: args.start_time,
          end: args.end_time,
        },
        summary: {
          totalEvents: expect.any(Number),
          totalInsulin: expect.any(String),
          totalCarbs: expect.any(String),
          exerciseSessions: expect.any(Number),
        },
        timeline: expect.any(Array),
      });

      expect(data.timeline[0]).toMatchObject({
        timestamp: expect.any(String),
        type: expect.stringMatching(/^(insulin|carbs|exercise)$/),
        data: expect.any(Object),
      });

      console.log('\nFirst Timeline Event:', JSON.stringify(data.timeline[0], null, 2));
      console.log('Summary:', JSON.stringify(data.summary, null, 2));
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(eventsService.getEventTimeline).mockImplementation(() => {
        throw new Error('Database error');
      });

      const args = {
        start_time: '2024-01-15T00:00:00Z',
        end_time: '2024-01-15T23:59:59Z',
      };

      const result = await getEventTimelineHandler(args);

      expect(result.content[0].text).toContain('Error fetching event timeline');
      expect(result.isError).toBe(true);
    });
  });

  describe('get_insulin_events', () => {
    it('should return all insulin events in range', async () => {
      vi.mocked(eventsService.getInsulinEvents).mockReturnValue(mockInsulinEvents);

      const args = {
        start_time: '2024-01-15T00:00:00Z',
        end_time: '2024-01-15T23:59:59Z',
      };

      const result = await getInsulinEventsHandler(args);

      console.log('\n=== get_insulin_events TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));
      console.log('Response:', result.content[0].text);

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        period: {
          start: args.start_time,
          end: args.end_time,
        },
        count: expect.any(Number),
        totalUnits: expect.any(String),
        events: expect.any(Array),
      });

      expect(data.events[0]).toMatchObject({
        id: expect.any(Number),
        units: expect.any(Number),
        type: expect.stringMatching(/^(rapid|long_acting|correction)$/),
        timestamp: expect.any(String),
      });

      console.log('\nFirst Insulin Event:', JSON.stringify(data.events[0], null, 2));
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(eventsService.getInsulinEvents).mockImplementation(() => {
        throw new Error('Database error');
      });

      const result = await getInsulinEventsHandler({
        start_time: '2024-01-15T00:00:00Z',
        end_time: '2024-01-15T23:59:59Z',
      });

      expect(result.content[0].text).toContain('Error fetching insulin events');
      expect(result.isError).toBe(true);
    });
  });

  describe('get_carb_events', () => {
    it('should return all carb events in range', async () => {
      vi.mocked(eventsService.getCarbEvents).mockReturnValue(mockCarbEvents);

      const args = {
        start_time: '2024-01-15T00:00:00Z',
        end_time: '2024-01-15T23:59:59Z',
      };

      const result = await getCarbEventsHandler(args);

      console.log('\n=== get_carb_events TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));
      console.log('Response:', result.content[0].text);

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        period: {
          start: args.start_time,
          end: args.end_time,
        },
        count: expect.any(Number),
        totalGrams: expect.any(Number),
        events: expect.any(Array),
        disclaimer: expect.stringContaining('You decide what, when, and how to eat'),
      });

      expect(data.events[0]).toMatchObject({
        id: expect.any(Number),
        grams: expect.any(Number),
        timestamp: expect.any(String),
      });

      console.log('\nFirst Carb Event:', JSON.stringify(data.events[0], null, 2));
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(eventsService.getCarbEvents).mockImplementation(() => {
        throw new Error('Database error');
      });

      const result = await getCarbEventsHandler({
        start_time: '2024-01-15T00:00:00Z',
        end_time: '2024-01-15T23:59:59Z',
      });

      expect(result.content[0].text).toContain('Error fetching carb events');
      expect(result.isError).toBe(true);
    });
  });

  describe('get_exercise_events', () => {
    it('should return all exercise events in range', async () => {
      vi.mocked(eventsService.getExerciseEvents).mockReturnValue(mockExerciseEvents);

      const args = {
        start_time: '2024-01-15T00:00:00Z',
        end_time: '2024-01-15T23:59:59Z',
      };

      const result = await getExerciseEventsHandler(args);

      console.log('\n=== get_exercise_events TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));
      console.log('Response:', result.content[0].text);

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        period: {
          start: args.start_time,
          end: args.end_time,
        },
        count: expect.any(Number),
        events: expect.any(Array),
      });

      expect(data.events[0]).toMatchObject({
        id: expect.any(Number),
        activityType: expect.any(String),
        timestamp: expect.any(String),
      });

      console.log('\nFirst Exercise Event:', JSON.stringify(data.events[0], null, 2));
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(eventsService.getExerciseEvents).mockImplementation(() => {
        throw new Error('Database error');
      });

      const result = await getExerciseEventsHandler({
        start_time: '2024-01-15T00:00:00Z',
        end_time: '2024-01-15T23:59:59Z',
      });

      expect(result.content[0].text).toContain('Error fetching exercise events');
      expect(result.isError).toBe(true);
    });
  });
});
