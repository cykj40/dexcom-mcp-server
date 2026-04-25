import type {
  InsulinEvent,
  CarbEvent,
  GlucoseReading,
  GlucosePrediction,
  AdaptiveObservation,
} from '../types/index.js';
import {
  insertAdaptiveObservation,
  getRecentObservations,
  getObservationsByType,
  getBaselineParameters,
} from '../db/queries.js';
import { getReadingsInRange } from '../db/queries.js';

/**
 * Modeling Service
 * Adaptive modeling per spec §4
 * This is the intelligence layer
 */

/**
 * Predict glucose impact from insulin dose
 * Based on Insulin Sensitivity Factor (ISF) from baseline
 */
export async function predictGlucoseImpact(insulin: InsulinEvent, currentGlucose: number): Promise<GlucosePrediction> {
  const { correctionFactor } = await getBaselineParameters();

  // Expected glucose drop = units * correction factor
  const predictedChange = -(insulin.units * correctionFactor);
  const predictedGlucose = Math.max(40, currentGlucose + predictedChange); // Floor at 40 mg/dL

  // Confidence range: ±20% of predicted change
  const confidenceMargin = Math.abs(predictedChange * 0.2);

  return {
    currentGlucose,
    predictedChange,
    predictedGlucose,
    confidenceRange: {
      low: Math.max(40, predictedGlucose - confidenceMargin),
      high: Math.min(400, predictedGlucose + confidenceMargin),
    },
    timeHorizonMinutes: insulin.type === 'rapid' ? 180 : 240, // 3-4 hours
    factors: [`${insulin.type} insulin`, `ISF: 1u → -${correctionFactor} mg/dL`],
    disclaimer: 'This prediction uses your baseline parameters. Actual results may vary.',
  };
}

/**
 * Predict glucose impact from carbohydrate intake
 * Based on Insulin-to-Carb Ratio (ICR) from baseline
 */
export async function predictCarbImpact(carbs: CarbEvent, currentGlucose: number): Promise<GlucosePrediction> {
  const { insulinToCarbRatio, correctionFactor } = await getBaselineParameters();

  // Equivalent insulin units needed to cover these carbs
  const equivalentInsulin = carbs.grams / insulinToCarbRatio;

  // Expected glucose rise (inverse of insulin impact)
  const predictedChange = equivalentInsulin * correctionFactor;
  const predictedGlucose = Math.min(400, currentGlucose + predictedChange); // Cap at 400 mg/dL

  // Adjust confidence based on GI estimate
  let confidenceMargin = predictedChange * 0.25; // Base ±25%
  if (carbs.estimatedGi === 'high') {
    confidenceMargin *= 1.5; // Higher uncertainty for high-GI foods
  }

  return {
    currentGlucose,
    predictedChange,
    predictedGlucose,
    confidenceRange: {
      low: Math.max(40, predictedGlucose - confidenceMargin),
      high: Math.min(400, predictedGlucose + confidenceMargin),
    },
    timeHorizonMinutes: carbs.estimatedGi === 'high' ? 90 : 180, // 1.5-3 hours
    factors: [
      `${carbs.grams}g carbs`,
      `ICR: 1u per ${insulinToCarbRatio}g`,
      carbs.estimatedGi ? `GI: ${carbs.estimatedGi}` : 'GI unknown',
    ],
    disclaimer: 'This prediction uses your baseline parameters. Actual results may vary.',
  };
}

/**
 * Compare expected vs actual glucose outcomes
 * Returns deviation percentage and analysis
 */
export function compareExpectedVsActual(
  prediction: GlucosePrediction,
  actualReadings: GlucoseReading[]
): {
  prediction: GlucosePrediction;
  actualGlucose: number;
  deviation: number;
  deviationPct: number;
  analysis: string;
} {
  if (actualReadings.length === 0) {
    return {
      prediction,
      actualGlucose: 0,
      deviation: 0,
      deviationPct: 0,
      analysis: 'No actual readings available for comparison',
    };
  }

  // Use the last reading in the window
  const actualGlucose = actualReadings[actualReadings.length - 1].value;
  const deviation = actualGlucose - prediction.predictedGlucose;
  const deviationPct = (deviation / prediction.predictedGlucose) * 100;

  let analysis = '';

  if (Math.abs(deviationPct) <= 10) {
    analysis = 'Prediction was accurate (within 10%)';
  } else if (deviationPct > 10) {
    analysis = `Glucose was ${Math.abs(deviationPct).toFixed(1)}% higher than predicted. Possible factors: insulin less effective than expected, carbs absorbed faster, stress/illness, or other factors.`;
  } else {
    analysis = `Glucose was ${Math.abs(deviationPct).toFixed(1)}% lower than predicted. Possible factors: insulin more effective than expected, increased physical activity, or other factors.`;
  }

  return {
    prediction,
    actualGlucose,
    deviation: Math.round(deviation),
    deviationPct: Math.round(deviationPct),
    analysis,
  };
}

/**
 * Detect parameter drift over time
 * Analyzes recent observations for systematic deviations
 */
export async function detectParameterDrift(days: number = 14): Promise<{
  observations: AdaptiveObservation[];
  driftSummary: {
    isfDrift: number | null;
    icrDrift: number | null;
    patterns: string[];
  };
  recommendation: string;
}> {
  const baselineParameters = await getBaselineParameters();
  const observations = await getRecentObservations(days);

  // Group observations by type
  const isfObservations = observations.filter((o) => o.observationType === 'isf_deviation');
  const icrObservations = observations.filter((o) => o.observationType === 'icr_deviation');

  // Calculate average drift for ISF
  let isfDrift: number | null = null;
  if (isfObservations.length >= 3) {
    const avgDeviation =
      isfObservations.reduce((sum, o) => sum + o.deviationPct, 0) / isfObservations.length;
    isfDrift = Math.round(avgDeviation);
  }

  // Calculate average drift for ICR
  let icrDrift: number | null = null;
  if (icrObservations.length >= 3) {
    const avgDeviation =
      icrObservations.reduce((sum, o) => sum + o.deviationPct, 0) / icrObservations.length;
    icrDrift = Math.round(avgDeviation);
  }

  // Identify patterns
  const patterns: string[] = [];

  if (isfDrift !== null && Math.abs(isfDrift) > 15) {
    patterns.push(
      `ISF appears ${isfDrift > 0 ? 'weaker' : 'stronger'} than baseline by ~${Math.abs(isfDrift)}%`
    );
  }

  if (icrDrift !== null && Math.abs(icrDrift) > 15) {
    patterns.push(
      `ICR appears ${icrDrift > 0 ? 'less effective' : 'more effective'} than baseline by ~${Math.abs(icrDrift)}%`
    );
  }

  // Check for time-of-day patterns
  const morningObs = observations.filter((o) => {
    const hour = new Date(o.timestamp).getHours();
    return hour >= 5 && hour < 10;
  });

  const afternoonObs = observations.filter((o) => {
    const hour = new Date(o.timestamp).getHours();
    return hour >= 14 && hour < 18;
  });

  if (morningObs.length >= 3) {
    const avgMorningDeviation =
      morningObs.reduce((sum, o) => sum + o.deviationPct, 0) / morningObs.length;
    if (Math.abs(avgMorningDeviation) > 20) {
      patterns.push(`Morning insulin sensitivity appears ${avgMorningDeviation > 0 ? 'reduced' : 'increased'}`);
    }
  }

  if (afternoonObs.length >= 3) {
    const avgAfternoonDeviation =
      afternoonObs.reduce((sum, o) => sum + o.deviationPct, 0) / afternoonObs.length;
    if (Math.abs(avgAfternoonDeviation) > 20) {
      patterns.push(
        `Afternoon insulin sensitivity appears ${avgAfternoonDeviation > 0 ? 'reduced' : 'increased'}`
      );
    }
  }

  const recommendation =
    patterns.length > 0
      ? `These are observations about apparent changes against current baseline parameters (ISF ${baselineParameters.correctionFactor}, ICR ${baselineParameters.insulinToCarbRatio}). Would you like to discuss whether your baseline parameters should be updated?`
      : `No significant parameter drift detected. Your current baseline parameters (ISF ${baselineParameters.correctionFactor}, ICR ${baselineParameters.insulinToCarbRatio}) appear to be working well.`;

  return {
    observations,
    driftSummary: {
      isfDrift,
      icrDrift,
      patterns,
    },
    recommendation,
  };
}

/**
 * Record an adaptive observation
 */
export async function recordObservation(obs: AdaptiveObservation): Promise<number> {
  return insertAdaptiveObservation(obs);
}

/**
 * Get recent drift summary
 */
export async function getRecentDrift(days: number = 7): Promise<{
  isfObservations: AdaptiveObservation[];
  icrObservations: AdaptiveObservation[];
  summary: string;
}> {
  const [isfObservations, icrObservations] = await Promise.all([
    getObservationsByType('isf_deviation', days),
    getObservationsByType('icr_deviation', days),
  ]);

  let summary = `Analyzed ${isfObservations.length + icrObservations.length} observations from the last ${days} days.\n\n`;

  if (isfObservations.length > 0) {
    const avgIsf =
      isfObservations.reduce((sum, o) => sum + o.deviationPct, 0) / isfObservations.length;
    summary += `ISF observations: Average deviation ${avgIsf > 0 ? '+' : ''}${avgIsf.toFixed(1)}%\n`;
  }

  if (icrObservations.length > 0) {
    const avgIcr =
      icrObservations.reduce((sum, o) => sum + o.deviationPct, 0) / icrObservations.length;
    summary += `ICR observations: Average deviation ${avgIcr > 0 ? '+' : ''}${avgIcr.toFixed(1)}%\n`;
  }

  if (isfObservations.length === 0 && icrObservations.length === 0) {
    summary += 'No observations recorded in this period.';
  }

  return {
    isfObservations,
    icrObservations,
    summary,
  };
}

/**
 * Analyze glucose outcome after an event
 * Helper function to create observations automatically
 */
export async function analyzeEventOutcome(
  eventType: 'insulin' | 'carbs',
  eventTimestamp: string,
  prediction: GlucosePrediction,
  actualReadings: GlucoseReading[]
): Promise<AdaptiveObservation | null> {
  const comparison = compareExpectedVsActual(prediction, actualReadings);

  // Only record if deviation is significant (>15%)
  if (Math.abs(comparison.deviationPct) < 15) {
    return null;
  }

  const observationType = eventType === 'insulin' ? 'isf_deviation' : 'icr_deviation';
  const hour = new Date(eventTimestamp).getHours();
  const timeOfDay =
    hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';

  const observation: AdaptiveObservation = {
    observationType,
    expectedValue: prediction.predictedGlucose,
    actualValue: comparison.actualGlucose,
    deviationPct: comparison.deviationPct,
    context: {
      timeOfDay,
      hour,
      eventType,
    },
    hypothesis: comparison.analysis,
    timestamp: eventTimestamp,
  };

  const id = await recordObservation(observation);
  return { ...observation, id };
}

/**
 * Get readings in range (convenience re-export for tools)
 */
export async function getReadingsForRange(startDate: string, endDate: string): Promise<GlucoseReading[]> {
  return getReadingsInRange(startDate, endDate);
}
