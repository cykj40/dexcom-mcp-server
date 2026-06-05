import { z } from 'zod'
import {
  calculateStatistics,
  getDailySummary,
  getLatestReading,
  getReadings,
} from '../services/glucose.service.js'

/**
 * Glucose MCP Tools
 * Thin wrappers that validate input and call glucose service
 */

// ============================================================================
// Tool: get_latest_glucose
// ============================================================================

export const getLatestGlucoseTool = {
  name: 'get_latest_glucose',
  description: 'Get the current glucose reading with trend information',
  inputSchema: z.object({}).strict(),
}

export async function getLatestGlucoseHandler() {
  const reading = await getLatestReading()

  if (!reading) {
    return {
      content: [
        {
          type: 'text',
          text: 'No glucose readings available. Please ensure your Dexcom device is connected and transmitting data.',
        },
      ],
    }
  }

  const ageMinutes = Math.floor((Date.now() - new Date(reading.recordedAt).getTime()) / 1000 / 60)

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            value: reading.value,
            unit: 'mg/dL',
            trend: reading.trend,
            trendDescription: reading.trendDescription,
            timestamp: reading.recordedAt,
            ageMinutes,
            source: reading.source,
          },
          null,
          2,
        ),
      },
    ],
  }
}

// ============================================================================
// Tool: get_glucose_range
// ============================================================================

export const getGlucoseRangeTool = {
  name: 'get_glucose_range',
  description: 'Get glucose readings within a time range',
  inputSchema: z
    .object({
      start_time: z.string().describe('Start time in ISO 8601 format'),
      end_time: z.string().describe('End time in ISO 8601 format'),
    })
    .strict(),
}

export async function getGlucoseRangeHandler(args: { start_time: string; end_time: string }) {
  try {
    const readings = await getReadings(args.start_time, args.end_time)

    if (readings.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No glucose readings found between ${args.start_time} and ${args.end_time}`,
          },
        ],
      }
    }

    const stats = calculateStatistics(readings)

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              timeRange: {
                start: args.start_time,
                end: args.end_time,
              },
              readingCount: readings.length,
              statistics: stats,
              readings: readings.map((r) => ({
                value: r.value,
                trend: r.trend,
                timestamp: r.recordedAt,
              })),
            },
            null,
            2,
          ),
        },
      ],
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error fetching glucose range: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    }
  }
}

// ============================================================================
// Tool: get_daily_summary
// ============================================================================

export const getDailySummaryTool = {
  name: 'get_daily_summary',
  description: 'Get glucose summary for a specific day',
  inputSchema: z
    .object({
      date: z.string().optional().describe('Date in YYYY-MM-DD format (defaults to today)'),
    })
    .strict(),
}

export async function getDailySummaryHandler(args: { date?: string }) {
  try {
    const date = args.date ?? new Date().toISOString().split('T')[0]
    const summary = await getDailySummary(date)

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              date: summary.date,
              statistics: summary.statistics,
              readingCount: summary.readings.length,
            },
            null,
            2,
          ),
        },
      ],
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error fetching daily summary: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    }
  }
}

// ============================================================================
// Tool: get_glucose_statistics
// ============================================================================

export const getGlucoseStatisticsTool = {
  name: 'get_glucose_statistics',
  description: 'Get comprehensive glucose statistics for a time period',
  inputSchema: z
    .object({
      hours: z.number().positive().default(24).describe('Number of hours to analyze (default: 24)'),
    })
    .strict(),
}

export async function getGlucoseStatisticsHandler(args: { hours?: number }) {
  try {
    const hours = args.hours ?? 24
    const endTime = new Date()
    const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000)

    const readings = await getReadings(startTime.toISOString(), endTime.toISOString())
    const stats = calculateStatistics(readings)

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              timeRange: {
                start: startTime.toISOString(),
                end: endTime.toISOString(),
                hours,
              },
              statistics: stats,
            },
            null,
            2,
          ),
        },
      ],
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error calculating statistics: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    }
  }
}
