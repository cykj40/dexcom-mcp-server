import { z } from 'zod';
import { getReadings, calculateStatistics } from '../services/glucose.service.js';
import { getEventTimeline, getInsulinEvents, getCarbEvents } from '../services/events.service.js';
import { detectParameterDrift, analyzeEventOutcome, predictGlucoseImpact, predictCarbImpact } from '../services/modeling.service.js';
import { getReadingsInRange } from '../db/queries.js';

/**
 * Analysis MCP Tools
 * Intelligence layer for trend analysis and pattern detection
 */

// ============================================================================
// Tool: analyze_trends
// ============================================================================

export const analyzeTrendsTool = {
  name: 'analyze_trends',
  description: 'Analyze glucose trends and patterns over time, including post-meal spikes, overnight patterns, and insulin effectiveness',
  inputSchema: z.object({
    days: z
      .number()
      .positive()
      .default(7)
      .describe('Number of days to analyze (default: 7)'),
  }).strict(),
};

export async function analyzeTrendsHandler(args: { days?: number }) {
  try {
    const days = args.days || 7;
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);

    // Get glucose readings and events
    const readings = await getReadings(startTime.toISOString(), endTime.toISOString());
    const timeline = await getEventTimeline(startTime.toISOString(), endTime.toISOString(), true);

    // Calculate overall statistics
    const stats = calculateStatistics(readings);

    // Analyze overnight patterns (midnight to 6am)
    const overnightReadings = readings.filter((r) => {
      const hour = new Date(r.recordedAt).getHours();
      return hour >= 0 && hour < 6;
    });
    const overnightStats = calculateStatistics(overnightReadings);

    // Analyze post-meal patterns (look for carb events followed by glucose rises)
    const carbEvents = timeline.filter((e) => e.eventType === 'carbs');
    const postMealAnalysis = [];

    for (const carbEvent of carbEvents.slice(0, 10)) {
      // Analyze last 10 meals
      const eventTime = new Date(carbEvent.timestamp);
      const twoHoursLater = new Date(eventTime.getTime() + 2 * 60 * 60 * 1000);

      const postMealReadings = readings.filter((r) => {
        const readingTime = new Date(r.recordedAt);
        return readingTime >= eventTime && readingTime <= twoHoursLater;
      });

      if (postMealReadings.length > 0) {
        const preGlucose = carbEvent.glucoseContext?.value || postMealReadings[0].value;
        const maxGlucose = Math.max(...postMealReadings.map((r) => r.value));
        const spike = maxGlucose - preGlucose;

        postMealAnalysis.push({
          timestamp: carbEvent.timestamp,
          preGlucose,
          maxGlucose,
          spike,
          carbData: carbEvent.data,
        });
      }
    }

    const avgSpike =
      postMealAnalysis.length > 0
        ? postMealAnalysis.reduce((sum, a) => sum + a.spike, 0) / postMealAnalysis.length
        : 0;

    // Analyze exercise impact
    const exerciseEvents = timeline.filter((e) => e.eventType === 'exercise');
    const exerciseAnalysis = [];

    for (const exerciseEvent of exerciseEvents.slice(0, 5)) {
      const eventTime = new Date(exerciseEvent.timestamp);
      const twoHoursLater = new Date(eventTime.getTime() + 2 * 60 * 60 * 1000);

      const postExerciseReadings = readings.filter((r) => {
        const readingTime = new Date(r.recordedAt);
        return readingTime >= eventTime && readingTime <= twoHoursLater;
      });

      if (postExerciseReadings.length > 0) {
        const preGlucose = exerciseEvent.glucoseContext?.value || postExerciseReadings[0].value;
        const minGlucose = Math.min(...postExerciseReadings.map((r) => r.value));
        const drop = preGlucose - minGlucose;

        exerciseAnalysis.push({
          timestamp: exerciseEvent.timestamp,
          preGlucose,
          minGlucose,
          drop,
          exerciseData: exerciseEvent.data,
        });
      }
    }

    const analysis = {
      period: {
        start: startTime.toISOString(),
        end: endTime.toISOString(),
        days,
      },
      overallStatistics: stats,
      overnightPattern: {
        statistics: overnightStats,
        readingCount: overnightReadings.length,
        note:
          overnightStats.average > 140
            ? 'Overnight glucose tends to run high. Consider discussing basal insulin timing with your healthcare provider.'
            : overnightStats.average < 80
              ? 'Overnight glucose runs low. Consider discussing basal insulin reduction with your healthcare provider.'
              : 'Overnight glucose appears well-controlled.',
      },
      postMealPatterns: {
        mealsAnalyzed: postMealAnalysis.length,
        averageSpike: Math.round(avgSpike),
        recentMeals: postMealAnalysis.slice(0, 5),
        note:
          avgSpike > 80
            ? 'Post-meal spikes are significant. Consider bolusing earlier before meals or adjusting insulin-to-carb ratio.'
            : 'Post-meal glucose responses appear reasonable.',
      },
      exerciseImpact: {
        sessionsAnalyzed: exerciseAnalysis.length,
        recentSessions: exerciseAnalysis,
        note:
          exerciseAnalysis.length > 0
            ? 'Exercise sessions recorded. Monitor for delayed hypoglycemia up to 12 hours post-exercise.'
            : 'No exercise events recorded in this period.',
      },
      disclaimer:
        'This is an assistive analysis based on your personal data. You are the final authority on any action taken.',
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(analysis, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error analyzing trends: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// Tool: compare_expected_vs_actual
// ============================================================================

export const compareExpectedVsActualTool = {
  name: 'compare_expected_vs_actual',
  description: 'Compare predicted glucose outcome vs actual outcome for an insulin or carb event',
  inputSchema: z.object({
    event_type: z.enum(['insulin', 'carbs']).describe('Type of event to analyze'),
    event_timestamp: z.string().describe('Event timestamp in ISO 8601 format'),
    event_value: z.number().describe('Insulin units or carb grams'),
    current_glucose: z.number().describe('Glucose at time of event (mg/dL)'),
    window_hours: z.number().default(4).describe('Hours to analyze after event (default: 4)'),
  }).strict(),
};

export async function compareExpectedVsActualHandler(args: {
  event_type: 'insulin' | 'carbs';
  event_timestamp: string;
  event_value: number;
  current_glucose: number;
  window_hours?: number;
}) {
  try {
    const windowHours = args.window_hours || 4;
    const eventTime = new Date(args.event_timestamp);
    const endTime = new Date(eventTime.getTime() + windowHours * 60 * 60 * 1000);

    // Get actual readings
    const actualReadings = await getReadingsInRange(args.event_timestamp, endTime.toISOString());

    // Generate prediction
    let prediction;
    if (args.event_type === 'insulin') {
      const insulinEvent = {
        units: args.event_value,
        type: 'rapid' as const,
        timestamp: args.event_timestamp,
      };
      prediction = await predictGlucoseImpact(insulinEvent, args.current_glucose);
    } else {
      const carbEvent = {
        grams: args.event_value,
        timestamp: args.event_timestamp,
      };
      prediction = await predictCarbImpact(carbEvent, args.current_glucose);
    }

    // Analyze outcome
    const outcome = await analyzeEventOutcome(
      args.event_type,
      args.event_timestamp,
      prediction,
      actualReadings
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              event: {
                type: args.event_type,
                value: args.event_value,
                timestamp: args.event_timestamp,
                startingGlucose: args.current_glucose,
              },
              prediction: {
                predictedGlucose: prediction.predictedGlucose,
                predictedChange: prediction.predictedChange,
                confidenceRange: prediction.confidenceRange,
              },
              actual: {
                readingsAnalyzed: actualReadings.length,
                finalGlucose: actualReadings.length > 0 ? actualReadings[actualReadings.length - 1].value : null,
              },
              observation: outcome,
              disclaimer:
                'This comparison uses your baseline parameters. Actual results may vary based on many factors.',
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
          text: `Error comparing expected vs actual: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// Tool: detect_parameter_drift
// ============================================================================

export const detectParameterDriftTool = {
  name: 'detect_parameter_drift',
  description: 'Detect if your insulin sensitivity or carb ratio parameters appear to have changed over time',
  inputSchema: z.object({
    days: z.number().default(14).describe('Number of days to analyze (default: 14)'),
  }).strict(),
};

export async function detectParameterDriftHandler(args: { days?: number }) {
  try {
    const days = args.days || 14;
    const driftAnalysis = await detectParameterDrift(days);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              analysisWindow: `${days} days`,
              observationCount: driftAnalysis.observations.length,
              driftDetected: driftAnalysis.driftSummary.patterns.length > 0,
              findings: {
                isfDrift: driftAnalysis.driftSummary.isfDrift,
                icrDrift: driftAnalysis.driftSummary.icrDrift,
                patterns: driftAnalysis.driftSummary.patterns,
              },
              recentObservations: driftAnalysis.observations.slice(0, 5).map((o) => ({
                type: o.observationType,
                deviation: `${o.deviationPct > 0 ? '+' : ''}${o.deviationPct}%`,
                hypothesis: o.hypothesis,
                timestamp: o.timestamp,
              })),
              recommendation: driftAnalysis.recommendation,
              disclaimer:
                'These are observations about apparent changes. Would you like to discuss whether your baseline parameters should be updated?',
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
          text: `Error detecting parameter drift: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
