import { z } from 'zod';
import { getReadings, getDailySummary, calculateStatistics } from '../services/glucose.service.js';
import { getEventTimeline } from '../services/events.service.js';
import { glucoseTimeSeries, dailySummaryChart, weeklyOverview, agpChart } from '../services/chart.service.js';

/**
 * Chart MCP Tools
 * Tools for generating Vega-Lite visualizations
 */

// ============================================================================
// Tool: generate_chart
// ============================================================================

export const generateChartTool = {
  name: 'generate_chart',
  description: 'Generate a glucose visualization chart (timeline, daily, weekly, or AGP)',
  inputSchema: z.object({
    chart_type: z
      .enum(['timeline', 'daily', 'weekly', 'agp'])
      .describe('Type of chart to generate'),
    start_date: z
      .string()
      .optional()
      .describe('Start date in ISO 8601 format (required for timeline and weekly)'),
    end_date: z
      .string()
      .optional()
      .describe('End date in ISO 8601 format (required for timeline and weekly)'),
    date: z
      .string()
      .optional()
      .describe('Specific date for daily chart (YYYY-MM-DD format)'),
    include_events: z
      .boolean()
      .default(true)
      .describe('Include insulin/carb/exercise event markers'),
    days: z
      .number()
      .optional()
      .describe('Number of days for AGP chart (default: 14)'),
  }).strict(),
};

export async function generateChartHandler(args: {
  chart_type: 'timeline' | 'daily' | 'weekly' | 'agp';
  start_date?: string;
  end_date?: string;
  date?: string;
  include_events?: boolean;
  days?: number;
}) {
  try {
    const includeEvents = args.include_events !== false;

    switch (args.chart_type) {
      case 'timeline': {
        if (!args.start_date || !args.end_date) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: start_date and end_date are required for timeline chart',
              },
            ],
            isError: true,
          };
        }

        const readings = await getReadings(args.start_date, args.end_date);
        const events = includeEvents
          ? await getEventTimeline(args.start_date, args.end_date, true)
          : undefined;

        const chart = glucoseTimeSeries(readings, events);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  chartType: 'timeline',
                  description: chart.description,
                  vegaLiteSpec: chart.spec,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'daily': {
        const date = args.date || new Date().toISOString().split('T')[0];
        const summary = await getDailySummary(date);
        const events = includeEvents
          ? await getEventTimeline(
              new Date(date + 'T00:00:00').toISOString(),
              new Date(date + 'T23:59:59').toISOString(),
              true
            )
          : undefined;

        const chart = dailySummaryChart(summary.readings, events);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  chartType: 'daily',
                  date,
                  statistics: summary.statistics,
                  description: chart.description,
                  vegaLiteSpec: chart.spec,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'weekly': {
        if (!args.start_date) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: start_date is required for weekly chart',
              },
            ],
            isError: true,
          };
        }

        const startDate = new Date(args.start_date);
        const dailyStats = [];

        for (let i = 0; i < 7; i++) {
          const currentDate = new Date(startDate);
          currentDate.setDate(currentDate.getDate() + i);
          const dateStr = currentDate.toISOString().split('T')[0];

          const summary = await getDailySummary(dateStr);
          dailyStats.push({
            date: dateStr,
            avgGlucose: summary.statistics.average,
            timeInRange: summary.statistics.timeInRange,
          });
        }

        const chart = weeklyOverview(dailyStats);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  chartType: 'weekly',
                  description: chart.description,
                  dailyStats,
                  vegaLiteSpec: chart.spec,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'agp': {
        const days = args.days || 14;
        const endTime = new Date();
        const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);

        const readings = await getReadings(startTime.toISOString(), endTime.toISOString());
        const chart = agpChart(readings);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  chartType: 'agp',
                  days,
                  readingCount: readings.length,
                  description: chart.description,
                  vegaLiteSpec: chart.spec,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: 'text',
              text: `Unknown chart type: ${args.chart_type}`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error generating chart: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
