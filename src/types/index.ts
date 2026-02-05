/**
 * Core type definitions for the Dexcom MCP Server
 */

// ============================================================================
// Glucose Types
// ============================================================================

export interface GlucoseReading {
  value: number; // mg/dL
  trend: string; // Dexcom trend arrow
  trendDescription: string;
  recordedAt: string; // ISO 8601
  source: 'api' | 'share';
  systemTime?: string; // Dexcom systemTime
  displayTime?: string; // Dexcom displayTime
}

export interface GlucoseStatistics {
  average: number;
  standardDeviation: number;
  min: number;
  max: number;
  timeInRange: number; // percentage 70-180
  timeBelowRange: number; // percentage <70
  timeAboveRange: number; // percentage >180
  readingCount: number;
  coefficientOfVariation: number;
}

// ============================================================================
// Baseline Parameters (from spec §3)
// ============================================================================

export interface BaselineParameters {
  correctionFactor: number; // ISF: 1u lowers by N mg/dL
  insulinToCarbRatio: number; // ICR: 1u per N g carbs
  basalDose: number; // Long-acting insulin dose
}

/**
 * Hardcoded baseline parameters (never auto-modified)
 * From specification §3
 */
export const BASELINE: BaselineParameters = {
  correctionFactor: 30, // 1u lowers by 30 mg/dL
  insulinToCarbRatio: 4, // 1u per 4g carbs
  basalDose: 30, // 30u long-acting, morning
};

// ============================================================================
// Event Types
// ============================================================================

export interface InsulinEvent {
  id?: number;
  units: number;
  type: 'rapid' | 'long_acting' | 'correction';
  timestamp: string; // ISO 8601
  notes?: string;
  createdAt?: string;
}

export interface CarbEvent {
  id?: number;
  grams: number;
  foodDescription?: string;
  estimatedGi?: 'low' | 'medium' | 'high';
  confidence?: 'low' | 'medium' | 'high';
  timestamp: string; // ISO 8601
  notes?: string;
  createdAt?: string;
}

export interface ExerciseEvent {
  id?: number;
  activityType: string;
  durationMinutes?: number;
  intensity?: 'low' | 'moderate' | 'high';
  timestamp: string; // ISO 8601
  notes?: string;
  createdAt?: string;
}

export interface EventTimeline {
  timestamp: string;
  eventType: 'insulin' | 'carbs' | 'exercise';
  data: InsulinEvent | CarbEvent | ExerciseEvent;
  glucoseContext?: GlucoseReading;
}

// ============================================================================
// Adaptive Modeling Types
// ============================================================================

export interface AdaptiveObservation {
  id?: number;
  observationType: string; // 'isf_deviation', 'icr_deviation', etc.
  expectedValue: number;
  actualValue: number;
  deviationPct: number;
  context: Record<string, unknown>;
  hypothesis: string;
  timestamp: string; // ISO 8601
  createdAt?: string;
}

export interface GlucosePrediction {
  currentGlucose: number;
  predictedChange: number;
  predictedGlucose: number;
  confidenceRange: {
    low: number;
    high: number;
  };
  timeHorizonMinutes: number;
  factors: string[];
  disclaimer: string;
}

// ============================================================================
// Chart Types
// ============================================================================

export interface ChartData {
  spec: VegaLiteSpec;
  description: string;
}

// Simplified Vega-Lite spec type (can be extended as needed)
export type VegaLiteSpec = Record<string, unknown> & {
  $schema?: string;
  description?: string;
  data: unknown;
  mark: unknown;
  encoding?: unknown;
};

// ============================================================================
// Dexcom API Response Types
// ============================================================================

export interface DexcomEGV {
  recordId: string;
  systemTime: string;
  displayTime: string;
  value: number;
  trend: string;
  trendRate?: number;
  unit: string;
  rateUnit?: string;
  status: string | null;
}

export interface DexcomEvent {
  recordId: string;
  systemTime: string;
  displayTime: string;
  eventType: string;
  eventSubType?: string;
  value?: number;
  unit?: string;
  status?: string;
}

export interface DexcomDataRange {
  start: {
    systemTime: string;
    displayTime: string;
  };
  end: {
    systemTime: string;
    displayTime: string;
  };
}

export interface DexcomDevice {
  transmitterGeneration: string;
  displayDevice: string;
  transmitterId?: string;
  transmitterTicks?: number;
  displayApp?: string;
  alertSchedules?: unknown[];
}

// ============================================================================
// Dexcom Share API Types
// ============================================================================

export interface DexcomShareReading {
  WT: string; // /Date(timestamp)/ format
  ST: string; // /Date(timestamp)/ format
  DT: string; // /Date(timestamp)/ format
  Value: number;
  Trend: number; // 0-9
}

// ============================================================================
// Trend Mappings
// ============================================================================

export const TREND_DESCRIPTIONS: Record<string, string> = {
  none: 'No trend data available',
  doubleUp: 'Rising rapidly (>3 mg/dL per minute)',
  singleUp: 'Rising (2-3 mg/dL per minute)',
  fortyFiveUp: 'Rising slightly (1-2 mg/dL per minute)',
  flat: 'Stable',
  fortyFiveDown: 'Falling slightly (1-2 mg/dL per minute)',
  singleDown: 'Falling (2-3 mg/dL per minute)',
  doubleDown: 'Falling rapidly (>3 mg/dL per minute)',
  notComputable: 'Trend not computable',
  rateOutOfRange: 'Rate of change out of range',
};

// Share API trend numbers map to arrow names
export const SHARE_TREND_MAP: Record<number, string> = {
  0: 'none',
  1: 'doubleUp',
  2: 'singleUp',
  3: 'fortyFiveUp',
  4: 'flat',
  5: 'fortyFiveDown',
  6: 'singleDown',
  7: 'doubleDown',
  8: 'notComputable',
  9: 'rateOutOfRange',
};

// ============================================================================
// Target Ranges
// ============================================================================

export const TARGET_RANGE = {
  LOW: 70,
  HIGH: 180,
  CRITICAL_LOW: 55,
  CRITICAL_HIGH: 250,
} as const;
