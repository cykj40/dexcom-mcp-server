import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  getLatestGlucoseTool,
  getLatestGlucoseHandler,
  getGlucoseRangeTool,
  getGlucoseRangeHandler,
  getDailySummaryTool,
  getDailySummaryHandler,
  getGlucoseStatisticsTool,
  getGlucoseStatisticsHandler,
} from './glucose-tools.js';
import {
  analyzeTrendsTool,
  analyzeTrendsHandler,
  compareExpectedVsActualTool,
  compareExpectedVsActualHandler,
  detectParameterDriftTool,
  detectParameterDriftHandler,
} from './analysis-tools.js';
import {
  logInsulinTool,
  logInsulinHandler,
  logCarbsTool,
  logCarbsHandler,
  logExerciseTool,
  logExerciseHandler,
  getEventTimelineTool,
  getEventTimelineHandler,
} from './event-tools.js';
import {
  generateChartTool,
  generateChartHandler,
} from './chart-tools.js';
import {
  getBaselineParametersTool,
  getBaselineParametersHandler,
  predictGlucoseImpactTool,
  predictGlucoseImpactHandler,
  getAdaptiveInsightsTool,
  getAdaptiveInsightsHandler,
} from './modeling-tools.js';

/**
 * Tool Registry
 * Registers all MCP tools with the server
 */

export function registerAllTools(server: Server): void {
  // ============================================================================
  // Glucose Tools
  // ============================================================================

  server.setRequestHandler('tools/list' as any, async () => ({
    tools: [
      {
        name: getLatestGlucoseTool.name,
        description: getLatestGlucoseTool.description,
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: getGlucoseRangeTool.name,
        description: getGlucoseRangeTool.description,
        inputSchema: {
          type: 'object',
          properties: {
            start_time: {
              type: 'string',
              description: 'Start time in ISO 8601 format',
            },
            end_time: {
              type: 'string',
              description: 'End time in ISO 8601 format',
            },
          },
          required: ['start_time', 'end_time'],
        },
      },
      {
        name: getDailySummaryTool.name,
        description: getDailySummaryTool.description,
        inputSchema: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'Date in YYYY-MM-DD format (defaults to today)',
            },
          },
        },
      },
      {
        name: getGlucoseStatisticsTool.name,
        description: getGlucoseStatisticsTool.description,
        inputSchema: {
          type: 'object',
          properties: {
            hours: {
              type: 'number',
              description: 'Number of hours to analyze (default: 24)',
              default: 24,
            },
          },
        },
      },
      // ============================================================================
      // Analysis Tools
      // ============================================================================
      {
        name: analyzeTrendsTool.name,
        description: analyzeTrendsTool.description,
        inputSchema: {
          type: 'object',
          properties: {
            days: {
              type: 'number',
              description: 'Number of days to analyze (default: 7)',
              default: 7,
            },
          },
        },
      },
      {
        name: compareExpectedVsActualTool.name,
        description: compareExpectedVsActualTool.description,
        inputSchema: {
          type: 'object',
          properties: {
            event_type: {
              type: 'string',
              enum: ['insulin', 'carbs'],
              description: 'Type of event to analyze',
            },
            event_timestamp: {
              type: 'string',
              description: 'Event timestamp in ISO 8601 format',
            },
            event_value: {
              type: 'number',
              description: 'Insulin units or carb grams',
            },
            current_glucose: {
              type: 'number',
              description: 'Glucose at time of event (mg/dL)',
            },
            window_hours: {
              type: 'number',
              description: 'Hours to analyze after event (default: 4)',
              default: 4,
            },
          },
          required: ['event_type', 'event_timestamp', 'event_value', 'current_glucose'],
        },
      },
      {
        name: detectParameterDriftTool.name,
        description: detectParameterDriftTool.description,
        inputSchema: {
          type: 'object',
          properties: {
            days: {
              type: 'number',
              description: 'Number of days to analyze (default: 14)',
              default: 14,
            },
          },
        },
      },
      // ============================================================================
      // Event Tools
      // ============================================================================
      {
        name: logInsulinTool.name,
        description: logInsulinTool.description,
        inputSchema: {
          type: 'object',
          properties: {
            units: {
              type: 'number',
              description: 'Number of insulin units',
            },
            type: {
              type: 'string',
              enum: ['rapid', 'long_acting', 'correction'],
              description: 'Type of insulin dose',
            },
            timestamp: {
              type: 'string',
              description: 'Timestamp in ISO 8601 format (defaults to now)',
            },
            notes: {
              type: 'string',
              description: 'Optional notes',
            },
          },
          required: ['units', 'type'],
        },
      },
      {
        name: logCarbsTool.name,
        description: logCarbsTool.description,
        inputSchema: {
          type: 'object',
          properties: {
            grams: {
              type: 'number',
              description: 'Grams of carbohydrates',
            },
            food_description: {
              type: 'string',
              description: 'Description of food eaten',
            },
            estimated_gi: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'Estimated glycemic index',
            },
            timestamp: {
              type: 'string',
              description: 'Timestamp in ISO 8601 format (defaults to now)',
            },
            notes: {
              type: 'string',
              description: 'Optional notes',
            },
          },
          required: ['grams'],
        },
      },
      {
        name: logExerciseTool.name,
        description: logExerciseTool.description,
        inputSchema: {
          type: 'object',
          properties: {
            activity_type: {
              type: 'string',
              description: 'Type of activity (e.g., "running", "walking")',
            },
            duration_minutes: {
              type: 'number',
              description: 'Duration in minutes',
            },
            intensity: {
              type: 'string',
              enum: ['low', 'moderate', 'high'],
              description: 'Exercise intensity',
            },
            timestamp: {
              type: 'string',
              description: 'Timestamp in ISO 8601 format (defaults to now)',
            },
            notes: {
              type: 'string',
              description: 'Optional notes',
            },
          },
          required: ['activity_type'],
        },
      },
      {
        name: getEventTimelineTool.name,
        description: getEventTimelineTool.description,
        inputSchema: {
          type: 'object',
          properties: {
            start_time: {
              type: 'string',
              description: 'Start time in ISO 8601 format',
            },
            end_time: {
              type: 'string',
              description: 'End time in ISO 8601 format',
            },
          },
          required: ['start_time', 'end_time'],
        },
      },
      // ============================================================================
      // Chart Tools
      // ============================================================================
      {
        name: generateChartTool.name,
        description: generateChartTool.description,
        inputSchema: {
          type: 'object',
          properties: {
            chart_type: {
              type: 'string',
              enum: ['timeline', 'daily', 'weekly', 'agp'],
              description: 'Type of chart to generate',
            },
            start_date: {
              type: 'string',
              description: 'Start date in ISO 8601 format (required for timeline and weekly)',
            },
            end_date: {
              type: 'string',
              description: 'End date in ISO 8601 format (required for timeline and weekly)',
            },
            date: {
              type: 'string',
              description: 'Specific date for daily chart (YYYY-MM-DD format)',
            },
            include_events: {
              type: 'boolean',
              description: 'Include insulin/carb/exercise event markers',
              default: true,
            },
            days: {
              type: 'number',
              description: 'Number of days for AGP chart (default: 14)',
            },
          },
          required: ['chart_type'],
        },
      },
      // ============================================================================
      // Modeling Tools
      // ============================================================================
      {
        name: getBaselineParametersTool.name,
        description: getBaselineParametersTool.description,
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: predictGlucoseImpactTool.name,
        description: predictGlucoseImpactTool.description,
        inputSchema: {
          type: 'object',
          properties: {
            action_type: {
              type: 'string',
              enum: ['insulin', 'carbs', 'both'],
              description: 'Type of action to predict',
            },
            insulin_units: {
              type: 'number',
              description: 'Insulin units (required if action_type is "insulin" or "both")',
            },
            carb_grams: {
              type: 'number',
              description: 'Carb grams (required if action_type is "carbs" or "both")',
            },
            current_glucose: {
              type: 'number',
              description: 'Current glucose in mg/dL (fetches live if not provided)',
            },
          },
          required: ['action_type'],
        },
      },
      {
        name: getAdaptiveInsightsTool.name,
        description: getAdaptiveInsightsTool.description,
        inputSchema: {
          type: 'object',
          properties: {
            days: {
              type: 'number',
              description: 'Number of days to analyze (default: 14)',
              default: 14,
            },
          },
        },
      },
    ],
  }));

  // ============================================================================
  // Tool Call Handlers
  // ============================================================================

  server.setRequestHandler('tools/call' as any, async (request: any) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      // Glucose Tools
      case getLatestGlucoseTool.name:
        return await getLatestGlucoseHandler();
      case getGlucoseRangeTool.name:
        return await getGlucoseRangeHandler(args as any);
      case getDailySummaryTool.name:
        return await getDailySummaryHandler(args as any);
      case getGlucoseStatisticsTool.name:
        return await getGlucoseStatisticsHandler(args as any);

      // Analysis Tools
      case analyzeTrendsTool.name:
        return await analyzeTrendsHandler(args as any);
      case compareExpectedVsActualTool.name:
        return await compareExpectedVsActualHandler(args as any);
      case detectParameterDriftTool.name:
        return await detectParameterDriftHandler(args as any);

      // Event Tools
      case logInsulinTool.name:
        return await logInsulinHandler(args as any);
      case logCarbsTool.name:
        return await logCarbsHandler(args as any);
      case logExerciseTool.name:
        return await logExerciseHandler(args as any);
      case getEventTimelineTool.name:
        return await getEventTimelineHandler(args as any);

      // Chart Tools
      case generateChartTool.name:
        return await generateChartHandler(args as any);

      // Modeling Tools
      case getBaselineParametersTool.name:
        return await getBaselineParametersHandler();
      case predictGlucoseImpactTool.name:
        return await predictGlucoseImpactHandler(args as any);
      case getAdaptiveInsightsTool.name:
        return await getAdaptiveInsightsHandler(args as any);

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  console.log('✅ All tools registered');
}
