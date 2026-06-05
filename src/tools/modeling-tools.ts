import { z } from 'zod'
import { getBaselineParameters, updateBaselineParameters } from '../db/queries.js'
import { getLatestReading } from '../services/glucose.service.js'
import {
  detectParameterDrift,
  getRecentDrift,
  predictCarbImpact,
  predictGlucoseImpact,
} from '../services/modeling.service.js'
import type { GlucosePrediction } from '../types/index.js'

interface GlucoseImpactPredictions {
  currentGlucose: number
  baselineParameters: { isf: number; icr: number }
  insulin?: GlucosePrediction
  carbs?: GlucosePrediction
  combined?: {
    insulinEffect: number
    carbEffect: number
    netChange: number
    predictedGlucose: number
    confidenceRange: { low: number; high: number }
    timeHorizonMinutes: number
  }
  disclaimer?: string
}

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
}

export async function getBaselineParametersHandler() {
  const baseline = await getBaselineParameters()

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            baselineParameters: {
              insulinSensitivityFactor: {
                value: baseline.correctionFactor,
                description: `1 unit of insulin lowers glucose by ${baseline.correctionFactor} mg/dL`,
              },
              insulinToCarbRatio: {
                value: baseline.insulinToCarbRatio,
                description: `1 unit of insulin covers ${baseline.insulinToCarbRatio}g of carbohydrates`,
              },
              basalDose: {
                value: baseline.basalDose,
                description: `${baseline.basalDose} units of long-acting insulin, taken ${baseline.basalTiming ?? 'as configured'}`,
              },
              basalTiming: baseline.basalTiming,
              updatedAt: baseline.updatedAt,
              notes: baseline.notes,
            },
            note: 'These baseline parameters are user-configurable. The system can observe deviations and suggest updates, but you decide whether to change them.',
          },
          null,
          2,
        ),
      },
    ],
  }
}

// ============================================================================
// Tool: update_baseline_parameters
// ============================================================================

export const updateBaselineParametersTool = {
  name: 'update_baseline_parameters',
  description:
    'Update your personal baseline diabetes parameters (ISF, ICR, basal dose). This requires your explicit confirmation as it affects all future predictions. HUMAN APPROVAL REQUIRED.',
  inputSchema: z
    .object({
      correction_factor: z
        .number()
        .positive()
        .optional()
        .describe('New ISF value (mg/dL drop per 1 unit)'),
      insulin_to_carb_ratio: z
        .number()
        .positive()
        .optional()
        .describe('New ICR value (grams of carbs per 1 unit)'),
      basal_dose: z.number().positive().optional().describe('New long-acting dose in units'),
      basal_timing: z.string().optional().describe('When long-acting is taken'),
      notes: z.string().optional().describe('Reason for the change'),
      confirmed: z.boolean().optional(),
    })
    .strict()
    .refine(
      (args) =>
        args.correction_factor !== undefined ||
        args.insulin_to_carb_ratio !== undefined ||
        args.basal_dose !== undefined ||
        args.basal_timing !== undefined ||
        args.notes !== undefined,
      'At least one baseline parameter or notes field is required',
    ),
}

type UpdateBaselineParametersArgs = {
  correction_factor?: number
  insulin_to_carb_ratio?: number
  basal_dose?: number
  basal_timing?: string
  notes?: string
  confirmed?: boolean
}

function baselineDisplay(params: {
  correctionFactor: number
  insulinToCarbRatio: number
  basalDose: number
  basalTiming?: string
  notes?: string
}): string {
  return [
    `correctionFactor: ${params.correctionFactor}`,
    `insulinToCarbRatio: ${params.insulinToCarbRatio}`,
    `basalDose: ${params.basalDose}`,
    `basalTiming: ${params.basalTiming ?? 'not set'}`,
    `notes: ${params.notes ?? 'none'}`,
  ].join(', ')
}

export async function updateBaselineParametersHandler(args: UpdateBaselineParametersArgs = {}) {
  try {
    const hasUpdate =
      args.correction_factor !== undefined ||
      args.insulin_to_carb_ratio !== undefined ||
      args.basal_dose !== undefined ||
      args.basal_timing !== undefined ||
      args.notes !== undefined

    if (!hasUpdate) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: At least one baseline parameter or notes field is required',
          },
        ],
        isError: true,
      }
    }

    const current = await getBaselineParameters()
    const proposed = {
      correctionFactor: args.correction_factor ?? current.correctionFactor,
      insulinToCarbRatio: args.insulin_to_carb_ratio ?? current.insulinToCarbRatio,
      basalDose: args.basal_dose ?? current.basalDose,
      basalTiming: args.basal_timing ?? current.basalTiming,
      notes: args.notes ?? current.notes,
    }

    const changes: string[] = []
    if (
      args.correction_factor !== undefined &&
      args.correction_factor !== current.correctionFactor
    ) {
      changes.push(
        `Changing correctionFactor from ${current.correctionFactor} to ${args.correction_factor}`,
      )
    }
    if (
      args.insulin_to_carb_ratio !== undefined &&
      args.insulin_to_carb_ratio !== current.insulinToCarbRatio
    ) {
      changes.push(
        `Changing insulinToCarbRatio from ${current.insulinToCarbRatio} to ${args.insulin_to_carb_ratio}`,
      )
    }
    if (args.basal_dose !== undefined && args.basal_dose !== current.basalDose) {
      changes.push(`Changing basalDose from ${current.basalDose} to ${args.basal_dose}`)
    }
    if (args.basal_timing !== undefined && args.basal_timing !== current.basalTiming) {
      changes.push(
        `Changing basalTiming from ${current.basalTiming ?? 'not set'} to ${args.basal_timing}`,
      )
    }
    if (args.notes !== undefined && args.notes !== current.notes) {
      changes.push(`Changing notes from ${current.notes ?? 'none'} to ${args.notes}`)
    }

    if (args.confirmed !== true) {
      return {
        content: [
          {
            type: 'text',
            text:
              '⚠️ PARAMETER UPDATE — HUMAN APPROVAL REQUIRED\n\n' +
              'These parameters directly affect all glucose predictions. You must confirm this change.\n\n' +
              'To confirm, call this tool again with confirmed: true added to your request.\n\n' +
              `Current values: ${baselineDisplay(current)}\n` +
              `Proposed values: ${baselineDisplay(proposed)}\n\n` +
              'Consult your healthcare provider before changing insulin parameters.\n\n' +
              `Changes: ${changes.length > 0 ? changes.join('; ') : 'No value changes detected'}`,
          },
        ],
      }
    }

    await updateBaselineParameters({
      correctionFactor: args.correction_factor,
      insulinToCarbRatio: args.insulin_to_carb_ratio,
      basalDose: args.basal_dose,
      basalTiming: args.basal_timing,
      notes: args.notes,
    })

    const updated = await getBaselineParameters()
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              message: 'Baseline parameters updated.',
              changes,
              baselineParameters: updated,
              disclaimer: 'Consult your healthcare provider before changing insulin parameters.',
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
          text: `Error updating baseline parameters: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    }
  }
}

// ============================================================================
// Tool: predict_glucose_impact
// ============================================================================

export const predictGlucoseImpactTool = {
  name: 'predict_glucose_impact',
  description: 'Predict how insulin or carbs will affect glucose levels',
  inputSchema: z
    .object({
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
    })
    .strict(),
}

export async function predictGlucoseImpactHandler(args: {
  action_type: 'insulin' | 'carbs' | 'both'
  insulin_units?: number
  carb_grams?: number
  current_glucose?: number
}) {
  try {
    // Get current glucose if not provided
    let currentGlucose = args.current_glucose
    if (!currentGlucose) {
      const latestReading = await getLatestReading()
      if (!latestReading) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: No current glucose reading available and none provided',
            },
          ],
          isError: true,
        }
      }
      currentGlucose = latestReading.value
    }

    // Validate inputs based on action type
    if ((args.action_type === 'insulin' || args.action_type === 'both') && !args.insulin_units) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: insulin_units is required when action_type is "insulin" or "both"',
          },
        ],
        isError: true,
      }
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
      }
    }

    const baseline = await getBaselineParameters()
    const predictions: GlucoseImpactPredictions = {
      currentGlucose,
      baselineParameters: {
        isf: baseline.correctionFactor,
        icr: baseline.insulinToCarbRatio,
      },
    }

    // Predict insulin impact
    if (args.action_type === 'insulin' && args.insulin_units) {
      const insulinPrediction = await predictGlucoseImpact(
        {
          units: args.insulin_units,
          type: 'rapid',
          timestamp: new Date().toISOString(),
        },
        currentGlucose,
      )
      predictions.insulin = insulinPrediction
    }

    // Predict carb impact
    if (args.action_type === 'carbs' && args.carb_grams) {
      const carbPrediction = await predictCarbImpact(
        {
          grams: args.carb_grams,
          timestamp: new Date().toISOString(),
        },
        currentGlucose,
      )
      predictions.carbs = carbPrediction
    }

    // Predict combined impact
    if (args.action_type === 'both' && args.insulin_units && args.carb_grams) {
      const insulinPrediction = await predictGlucoseImpact(
        {
          units: args.insulin_units,
          type: 'rapid',
          timestamp: new Date().toISOString(),
        },
        currentGlucose,
      )

      const carbPrediction = await predictCarbImpact(
        {
          grams: args.carb_grams,
          timestamp: new Date().toISOString(),
        },
        currentGlucose,
      )

      // Combined prediction (insulin lowers, carbs raise)
      const netChange = insulinPrediction.predictedChange + carbPrediction.predictedChange
      const predictedGlucose = Math.max(40, Math.min(400, currentGlucose + netChange))

      predictions.combined = {
        insulinEffect: insulinPrediction.predictedChange,
        carbEffect: carbPrediction.predictedChange,
        netChange,
        predictedGlucose,
        confidenceRange: {
          low: Math.max(40, predictedGlucose - Math.abs(netChange * 0.3)),
          high: Math.min(400, predictedGlucose + Math.abs(netChange * 0.3)),
        },
        timeHorizonMinutes: 180,
      }

      predictions.insulin = insulinPrediction
      predictions.carbs = carbPrediction
    }

    predictions.disclaimer =
      'This prediction uses your baseline parameters. Actual results may vary based on many factors including exercise, stress, illness, and time of day.'

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(predictions, null, 2),
        },
      ],
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error predicting glucose impact: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    }
  }
}

// ============================================================================
// Tool: get_adaptive_insights
// ============================================================================

export const getAdaptiveInsightsTool = {
  name: 'get_adaptive_insights',
  description: 'Get insights about how observed glucose outcomes compare to baseline predictions',
  inputSchema: z
    .object({
      days: z.number().positive().default(14).describe('Number of days to analyze (default: 14)'),
    })
    .strict(),
}

export async function getAdaptiveInsightsHandler(args: { days?: number }) {
  try {
    const days = args.days ?? 14
    const baseline = await getBaselineParameters()
    const drift = await getRecentDrift(days)
    const driftAnalysis = await detectParameterDrift(days)

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              analysisWindow: `${days} days`,
              baselineParameters: {
                isf: baseline.correctionFactor,
                icr: baseline.insulinToCarbRatio,
                basalDose: baseline.basalDose,
                basalTiming: baseline.basalTiming,
                updatedAt: baseline.updatedAt,
                notes: baseline.notes,
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
          text: `Error getting adaptive insights: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    }
  }
}
