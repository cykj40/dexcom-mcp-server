import type { InsulinEvent, CarbEvent, ExerciseEvent } from '../../src/types/index.js';

/**
 * Realistic event fixtures for testing
 */

export const mockInsulinEvents: InsulinEvent[] = [
  {
    id: 1,
    units: 6.5,
    type: 'rapid',
    timestamp: '2024-01-15T07:30:00Z',
    notes: 'Breakfast bolus',
    createdAt: '2024-01-15T07:30:00Z',
  },
  {
    id: 2,
    units: 4.0,
    type: 'rapid',
    timestamp: '2024-01-15T12:15:00Z',
    notes: 'Lunch bolus',
    createdAt: '2024-01-15T12:15:00Z',
  },
  {
    id: 3,
    units: 2.5,
    type: 'correction',
    timestamp: '2024-01-15T14:30:00Z',
    notes: 'Correction for high reading',
    createdAt: '2024-01-15T14:30:00Z',
  },
  {
    id: 4,
    units: 30,
    type: 'long_acting',
    timestamp: '2024-01-15T06:00:00Z',
    notes: 'Morning basal',
    createdAt: '2024-01-15T06:00:00Z',
  },
];

export const mockCarbEvents: CarbEvent[] = [
  {
    id: 1,
    grams: 45,
    foodDescription: 'Oatmeal with berries',
    estimatedGi: 'low',
    timestamp: '2024-01-15T07:30:00Z',
    notes: 'Breakfast',
    createdAt: '2024-01-15T07:30:00Z',
  },
  {
    id: 2,
    grams: 60,
    foodDescription: 'Turkey sandwich with apple',
    estimatedGi: 'medium',
    timestamp: '2024-01-15T12:15:00Z',
    notes: 'Lunch',
    createdAt: '2024-01-15T12:15:00Z',
  },
  {
    id: 3,
    grams: 15,
    foodDescription: 'Glucose tablets',
    estimatedGi: 'high',
    timestamp: '2024-01-15T15:35:00Z',
    notes: 'Treating low',
    createdAt: '2024-01-15T15:35:00Z',
  },
];

export const mockExerciseEvents: ExerciseEvent[] = [
  {
    id: 1,
    activityType: 'walking',
    durationMinutes: 30,
    intensity: 'moderate',
    timestamp: '2024-01-15T10:00:00Z',
    notes: 'Morning walk',
    createdAt: '2024-01-15T10:00:00Z',
  },
  {
    id: 2,
    activityType: 'running',
    durationMinutes: 45,
    intensity: 'high',
    timestamp: '2024-01-15T17:00:00Z',
    notes: 'Evening run',
    createdAt: '2024-01-15T17:00:00Z',
  },
];

export const createInsulinEvent = (overrides?: Partial<InsulinEvent>): InsulinEvent => ({
  units: 5.0,
  type: 'rapid',
  timestamp: new Date().toISOString(),
  ...overrides,
});

export const createCarbEvent = (overrides?: Partial<CarbEvent>): CarbEvent => ({
  grams: 30,
  timestamp: new Date().toISOString(),
  ...overrides,
});

export const createExerciseEvent = (overrides?: Partial<ExerciseEvent>): ExerciseEvent => ({
  activityType: 'walking',
  timestamp: new Date().toISOString(),
  ...overrides,
});
