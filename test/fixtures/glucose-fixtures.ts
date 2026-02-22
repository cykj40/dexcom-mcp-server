import type { GlucoseReading } from '../../src/types/index.js';

/**
 * Realistic glucose reading fixtures
 * Values based on typical CGM data for Type 1 diabetics
 */

export const createGlucoseReading = (overrides?: Partial<GlucoseReading>): GlucoseReading => {
  const now = new Date();
  return {
    value: 120,
    trend: 'flat',
    trendDescription: 'Stable',
    recordedAt: now.toISOString(),
    source: 'api',
    systemTime: now.toISOString(),
    displayTime: now.toISOString(),
    ...overrides,
  };
};

export const mockGlucoseReadings: GlucoseReading[] = [
  // Morning readings - stable in range
  createGlucoseReading({
    value: 95,
    trend: 'flat',
    trendDescription: 'Stable',
    recordedAt: '2024-01-15T06:00:00Z',
  }),
  createGlucoseReading({
    value: 98,
    trend: 'fortyFiveUp',
    trendDescription: 'Rising slightly (1-2 mg/dL per minute)',
    recordedAt: '2024-01-15T06:05:00Z',
  }),
  createGlucoseReading({
    value: 105,
    trend: 'singleUp',
    trendDescription: 'Rising (2-3 mg/dL per minute)',
    recordedAt: '2024-01-15T06:10:00Z',
  }),

  // Post-breakfast spike
  createGlucoseReading({
    value: 145,
    trend: 'singleUp',
    trendDescription: 'Rising (2-3 mg/dL per minute)',
    recordedAt: '2024-01-15T08:00:00Z',
  }),
  createGlucoseReading({
    value: 165,
    trend: 'flat',
    trendDescription: 'Stable',
    recordedAt: '2024-01-15T09:00:00Z',
  }),
  createGlucoseReading({
    value: 155,
    trend: 'fortyFiveDown',
    trendDescription: 'Falling slightly (1-2 mg/dL per minute)',
    recordedAt: '2024-01-15T10:00:00Z',
  }),

  // Lunch time - good control
  createGlucoseReading({
    value: 120,
    trend: 'flat',
    trendDescription: 'Stable',
    recordedAt: '2024-01-15T12:00:00Z',
  }),
  createGlucoseReading({
    value: 135,
    trend: 'singleUp',
    trendDescription: 'Rising (2-3 mg/dL per minute)',
    recordedAt: '2024-01-15T13:00:00Z',
  }),

  // Afternoon - low trending
  createGlucoseReading({
    value: 75,
    trend: 'fortyFiveDown',
    trendDescription: 'Falling slightly (1-2 mg/dL per minute)',
    recordedAt: '2024-01-15T15:00:00Z',
  }),
  createGlucoseReading({
    value: 68,
    trend: 'singleDown',
    trendDescription: 'Falling (2-3 mg/dL per minute)',
    recordedAt: '2024-01-15T15:30:00Z',
  }),

  // Evening - recovery and stable
  createGlucoseReading({
    value: 110,
    trend: 'flat',
    trendDescription: 'Stable',
    recordedAt: '2024-01-15T18:00:00Z',
  }),
  createGlucoseReading({
    value: 115,
    trend: 'flat',
    trendDescription: 'Stable',
    recordedAt: '2024-01-15T20:00:00Z',
  }),
];

export const mockHighGlucose = createGlucoseReading({
  value: 245,
  trend: 'singleUp',
  trendDescription: 'Rising (2-3 mg/dL per minute)',
});

export const mockLowGlucose = createGlucoseReading({
  value: 55,
  trend: 'singleDown',
  trendDescription: 'Falling (2-3 mg/dL per minute)',
});

export const mockStableGlucose = createGlucoseReading({
  value: 120,
  trend: 'flat',
  trendDescription: 'Stable',
});

export const mockRapidRiseGlucose = createGlucoseReading({
  value: 180,
  trend: 'doubleUp',
  trendDescription: 'Rising rapidly (>3 mg/dL per minute)',
});

export const mockRapidFallGlucose = createGlucoseReading({
  value: 70,
  trend: 'doubleDown',
  trendDescription: 'Falling rapidly (>3 mg/dL per minute)',
});
