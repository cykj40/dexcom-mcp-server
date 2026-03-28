import { z } from 'zod';
import { BASELINE } from '../types/index.js';
import {
  predictGlucoseImpact,
  predictCarbImpact,
  getRecentDrift,
  detectParameterDrift,
} from '../services/modeling.service.js';
import { getLatestReading } from '../services/glucose.service.js';

/**
 * Modeling MCP Tools
 * Adaptive modeling and predictive tools
 */

// ============================================================================
// Tool: get_baseline_parameters
// ============================================================================

export const getBaselineParametersTool = {
  name: 'get_baseline_parameters',
  description: 'Get your current baseline diabetes parameters (ISF, ICR, basal dose)',
  inputSchema: z.object({}).strict(),
};

export async function getBaselineParametersHandler() {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            baselineParameters: {
              insulinSensitivityFactor: {
                value: BASELINE.correctionFactor,
                description: `1 unit of insulin lowers glucose by ${BASELINE.correctionFactor} mg/dL`,
              },
              insulinToCarbRatio: {
                value: BASELINE.insulinToCarbRatio,
                description: `1 unit of insulin covers ${BASELINE.insulinToCarbRatio}g of carbohydrates`,
              },
              basalDose: {
                value: BASELINE.basalDose,
                description: `${BASELINE.basalDose} units of long-acting insulin, taken in the morning`,
              },
            },
            note: 'These baseline parameters are never auto-modified. The system can observe deviations and suggest updates, but you decide whether to change them.',
          },
          null,
          2
        ),
      },
    ],
  };
}

// ============================================================================
// Tool: predict_glucose_impact
// ============================================================================

export const predictGlucoseImpactTool = {
  name: 'predict_glucose_impact',
  description: 'Predict how insulin or carbs will affect glucose levels',
  inputSchema: z.object({
    action_type: z.enum(['insulin', 'carbs', 'both']).describe('Type of action to predict'),
    insulin_units: z
      .number()
      .positive()
      .optional()
      .describe('Insulin units (required if action_type is "insulin" or "both")'),
    carb_grams: z
      .number()
      .positive()
      .optional()
      .describe('Carb grams (required if action_type is "carbs" or "both")'),
    current_glucose: z
      .number()
      .optional()
      .describe('Current glucose in mg/dL (fetches live if not provided)'),
  }).strict(),
};

export async function predictGlucoseImpactHandler(args: {
  action_type: 'insulin' | 'carbs' | 'both';
  insulin_units?: number;
  carb_grams?: number;
  current_glucose?: number;
}) {
  try {
    // Get current glucose if not provided
    let currentGlucose = args.current_glucose;
    if (!currentGlucose) {
      const latestReading = await getLatestReading();
      if (!latestReading) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: No current glucose reading available and none provided',
            },
          ],
          isError: true,
        };
      }
      currentGlucose = latestReading.value;
    }

    // Validate inputs based on action type
    if (
      (args.action_type === 'insulin' || args.action_type === 'both') &&
      !args.insulin_units
    ) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: insulin_units is required when action_type is "insulin" or "both"',
          },
        ],
        isError: true,
      };
    }

    if ((args.action_type === 'carbs' || args.action_type === 'both') && !args.carb_grams) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: carb_grams is required when action_type is "carbs" or "both"',
          },
        ],
        isError: true,
      };
    }

    const predictions: any = {
      currentGlucose,
      baselineParameters: {
        isf: BASELINE.correctionFactor,
        icr: BASELINE.insulinToCarbRatio,
      },
    };

    // Predict insulin impact
    if (args.action_type === 'insulin' && args.insulin_units) {
      const insulinPrediction = predictGlucoseImpact(
        {
          units: args.insulin_units,
          type: 'rapid',
          timestamp: new Date().toISOString(),
        },
        currentGlucose
      );
      predictions.insulin = insulinPrediction;
    }

    // Predict carb impact
    if (args.action_type === 'carbs' && args.carb_grams) {
      const carbPrediction = predictCarbImpact(
        {
          grams: args.carb_grams,
          timestamp: new Date().toISOString(),
        },
        currentGlucose
      );
      predictions.carbs = carbPrediction;
    }

    // Predict combined impact
    if (args.action_type === 'both' && args.insulin_units && args.carb_grams) {
      const insulinPrediction = predictGlucoseImpact(
        {
          units: args.insulin_units,
          type: 'rapid',
          timestamp: new Date().toISOString(),
        },
        currentGlucose
      );

      const carbPrediction = predictCarbImpact(
        {
          grams: args.carb_grams,
          timestamp: new Date().toISOString(),
        },
        currentGlucose
      );

      // Combined prediction (insulin lowers, carbs raise)
      const netChange = insulinPrediction.predictedChange + carbPrediction.predictedChange;
      const predictedGlucose = Math.max(40, Math.min(400, currentGlucose + netChange));

      predictions.combined = {
        insulinEffect: insulinPrediction.predictedChange,
        carbEffect: carbPrediction.predictedChange,
        netChange,
        predictedGlucose,
        confidenceRange: {
          low: Math.max(
            40,
            predictedGlucose - Math.abs(netChange * 0.3)
          ),
          high: Math.min(
            400,
            predictedGlucose + Math.abs(netChange * 0.3)
          ),
        },
        timeHorizonMinutes: 180,
      };

      predictions.insulin = insulinPrediction;
      predictions.carbs = carbPrediction;
    }

    predictions.disclaimer =
      'This prediction uses your baseline parameters. Actual results may vary based on many factors including exercise, stress, illness, and time of day.';

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(predictions, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error predicting glucose impact: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// Tool: get_adaptive_insights
// ============================================================================

export const getAdaptiveInsightsTool = {
  name: 'get_adaptive_insights',
  description: 'Get insights about how observed glucose outcomes compare to baseline predictions',
  inputSchema: z.object({
    days: z
      .number()
      .positive()
      .default(14)
      .describe('Number of days to analyze (default: 14)'),
  }).strict(),
};

export async function getAdaptiveInsightsHandler(args: { days?: number }) {
  try {
    const days = args.days || 14;
    const drift = await getRecentDrift(days);
    const driftAnalysis = await detectParameterDrift(days);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              analysisWindow: `${days} days`,
              baselineParameters: {
                isf: BASELINE.correctionFactor,
                icr: BASELINE.insulinToCarbRatio,
                basalDose: BASELINE.basalDose,
              },
              observationsSummary: drift.summary,
              detectedDrift: {
                isfDrift: driftAnalysis.driftSummary.isfDrift,
                icrDrift: driftAnalysis.driftSummary.icrDrift,
                patterns: driftAnalysis.driftSummary.patterns,
              },
              recentObservations: [
                ...drift.isfObservations.slice(0, 3),
                ...drift.icrObservations.slice(0, 3),
              ].map((o) => ({
                type: o.observationType,
                deviation: `${o.deviationPct > 0 ? '+' : ''}${o.deviationPct}%`,
                hypothesis: o.hypothesis,
                timestamp: o.timestamp,
              })),
              recommendation: driftAnalysis.recommendation,
              disclaimer:
                'These are assistive observations. You are the final authority on any parameter changes.',
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
          text: `Error getting adaptive insights: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
