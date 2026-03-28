import { z } from 'zod';
import {
  logInsulin,
  logCarbs,
  logExercise,
  getEventTimeline,
  getEventsSummary,
  getInsulinEvents,
  getCarbEvents,
  getExerciseEvents,
} from '../services/events.service.js';

/**
 * Event MCP Tools
 * Tools for logging and querying insulin, carb, and exercise events
 */

// ============================================================================
// Tool: log_insulin
// ============================================================================

export const logInsulinTool = {
  name: 'log_insulin',
  description: 'Log an insulin dose',
  inputSchema: z.object({
    units: z.number().positive().describe('Number of insulin units'),
    type: z
      .enum(['rapid', 'long_acting', 'correction'])
      .describe('Type of insulin dose'),
    timestamp: z
      .string()
      .optional()
      .describe('Timestamp in ISO 8601 format (defaults to now)'),
    notes: z.string().optional().describe('Optional notes'),
  }).strict(),
};

export async function logInsulinHandler(args: {
  units: number;
  type: 'rapid' | 'long_acting' | 'correction';
  timestamp?: string;
  notes?: string;
}) {
  try {
    const timestamp = args.timestamp || new Date().toISOString();

    const eventId = await logInsulin({
      units: args.units,
      type: args.type,
      timestamp,
      notes: args.notes,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              eventId,
              message: `Logged ${args.units}u of ${args.type} insulin at ${timestamp}`,
              disclaimer:
                'This is an assistive recommendation based on your personal data. You are the final authority on any action taken.',
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error logging insulin: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// Tool: log_carbs
// ============================================================================

export const logCarbsTool = {
  name: 'log_carbs',
  description: 'Log a carbohydrate intake event',
  inputSchema: z.object({
    grams: z.number().positive().describe('Grams of carbohydrates'),
    food_description: z.string().optional().describe('Description of food eaten'),
    estimated_gi: z
      .enum(['low', 'medium', 'high'])
      .optional()
      .describe('Estimated glycemic index'),
    timestamp: z
      .string()
      .optional()
      .describe('Timestamp in ISO 8601 format (defaults to now)'),
    notes: z.string().optional().describe('Optional notes'),
  }).strict(),
};

export async function logCarbsHandler(args: {
  grams: number;
  food_description?: string;
  estimated_gi?: 'low' | 'medium' | 'high';
  timestamp?: string;
  notes?: string;
}) {
  try {
    const timestamp = args.timestamp || new Date().toISOString();

    const eventId = await logCarbs({
      grams: args.grams,
      foodDescription: args.food_description,
      estimatedGi: args.estimated_gi,
      timestamp,
      notes: args.notes,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              eventId,
              message: `Logged ${args.grams}g carbs${args.food_description ? ` (${args.food_description})` : ''} at ${timestamp}`,
              disclaimer:
                'These are assistive options based on your personal glucose history. You decide what, when, and how to eat.',
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error logging carbs: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// Tool: log_exercise
// ============================================================================

export const logExerciseTool = {
  name: 'log_exercise',
  description: 'Log an exercise or physical activity event',
  inputSchema: z.object({
    activity_type: z.string().describe('Type of activity (e.g., "running", "walking")'),
    duration_minutes: z.number().positive().optional().describe('Duration in minutes'),
    intensity: z
      .enum(['low', 'moderate', 'high'])
      .optional()
      .describe('Exercise intensity'),
    timestamp: z
      .string()
      .optional()
      .describe('Timestamp in ISO 8601 format (defaults to now)'),
    notes: z.string().optional().describe('Optional notes'),
  }).strict(),
};

export async function logExerciseHandler(args: {
  activity_type: string;
  duration_minutes?: number;
  intensity?: 'low' | 'moderate' | 'high';
  timestamp?: string;
  notes?: string;
}) {
  try {
    const timestamp = args.timestamp || new Date().toISOString();

    const eventId = await logExercise({
      activityType: args.activity_type,
      durationMinutes: args.duration_minutes,
      intensity: args.intensity,
      timestamp,
      notes: args.notes,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              eventId,
              message: `Logged ${args.activity_type} exercise at ${timestamp}`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error logging exercise: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// Tool: get_event_timeline
// ============================================================================

export const getEventTimelineTool = {
  name: 'get_event_timeline',
  description: 'Get a chronological timeline of all logged events (insulin, carbs, exercise) with glucose context',
  inputSchema: z.object({
    start_time: z.string().describe('Start time in ISO 8601 format'),
    end_time: z.string().describe('End time in ISO 8601 format'),
  }).strict(),
};

export async function getEventTimelineHandler(args: {
  start_time: string;
  end_time: string;
}) {
  try {
    const timeline = await getEventTimeline(args.start_time, args.end_time, true);
    const summary = await getEventsSummary(args.start_time, args.end_time);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              period: {
                start: args.start_time,
                end: args.end_time,
              },
              summary: {
                totalEvents: timeline.length,
                totalInsulin: `${summary.totalInsulin.toFixed(1)}u`,
                totalCarbs: `${summary.totalCarbs}g`,
                exerciseSessions: summary.totalExercise,
              },
              timeline: timeline.map((event) => ({
                timestamp: event.timestamp,
                type: event.eventType,
                data: event.data,
                glucoseContext: event.glucoseContext
                  ? {
                      value: event.glucoseContext.value,
                      trend: event.glucoseContext.trend,
                    }
                  : null,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error fetching event timeline: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// Tool: get_insulin_events
// ============================================================================

export const getInsulinEventsTool = {
  name: 'get_insulin_events',
  description: 'Get all insulin events within a date range',
  inputSchema: z.object({
    start_time: z.string().describe('Start time in ISO 8601 format'),
    end_time: z.string().describe('End time in ISO 8601 format'),
  }).strict(),
};

export async function getInsulinEventsHandler(args: {
  start_time: string;
  end_time: string;
}) {
  try {
    const events = await getInsulinEvents(args.start_time, args.end_time);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              period: {
                start: args.start_time,
                end: args.end_time,
              },
              count: events.length,
              totalUnits: events.reduce((sum, e) => sum + e.units, 0).toFixed(1),
              events: events.map((event) => ({
                id: event.id,
                units: event.units,
                type: event.type,
                timestamp: event.timestamp,
                notes: event.notes,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error fetching insulin events: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// Tool: get_carb_events
// ============================================================================

export const getCarbEventsTool = {
  name: 'get_carb_events',
  description: 'Get all carbohydrate intake events within a date range',
  inputSchema: z.object({
    start_time: z.string().describe('Start time in ISO 8601 format'),
    end_time: z.string().describe('End time in ISO 8601 format'),
  }).strict(),
};

export async function getCarbEventsHandler(args: {
  start_time: string;
  end_time: string;
}) {
  try {
    const events = await getCarbEvents(args.start_time, args.end_time);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              period: {
                start: args.start_time,
                end: args.end_time,
              },
              count: events.length,
              totalGrams: events.reduce((sum, e) => sum + e.grams, 0),
              events: events.map((event) => ({
                id: event.id,
                grams: event.grams,
                foodDescription: event.foodDescription,
                estimatedGi: event.estimatedGi,
                timestamp: event.timestamp,
                notes: event.notes,
              })),
              disclaimer:
                'These are assistive options based on your personal glucose history. You decide what, when, and how to eat.',
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error fetching carb events: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// Tool: get_exercise_events
// ============================================================================

export const getExerciseEventsTool = {
  name: 'get_exercise_events',
  description: 'Get all exercise/physical activity events within a date range',
  inputSchema: z.object({
    start_time: z.string().describe('Start time in ISO 8601 format'),
    end_time: z.string().describe('End time in ISO 8601 format'),
  }).strict(),
};

export async function getExerciseEventsHandler(args: {
  start_time: string;
  end_time: string;
}) {
  try {
    const events = await getExerciseEvents(args.start_time, args.end_time);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              period: {
                start: args.start_time,
                end: args.end_time,
              },
              count: events.length,
              events: events.map((event) => ({
                id: event.id,
                activityType: event.activityType,
                durationMinutes: event.durationMinutes,
                intensity: event.intensity,
                timestamp: event.timestamp,
                notes: event.notes,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error fetching exercise events: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
