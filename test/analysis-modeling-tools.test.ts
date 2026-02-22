import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockGlucoseReadings } from './fixtures/glucose-fixtures.js';
import { createTestDb, closeTestDb } from './helpers/test-db.js';

// Mock the config/env module to prevent validation errors
vi.mock('../src/config/env.js', () => ({
  env: {
    DEXCOM_CLIENT_ID: 'test-client-id',
    DEXCOM_CLIENT_SECRET: 'test-client-secret',
    DEXCOM_REDIRECT_URI: 'http://localhost:3000/callback',
    DEXCOM_ACCESS_TOKEN: 'test-access-token',
    DEXCOM_REFRESH_TOKEN: 'test-refresh-token',
    DEXCOM_API_ENV: 'sandbox',
    DB_PATH: ':memory:',
  },
  getDexcomApiBaseUrl: vi.fn(() => 'https://sandbox-api.dexcom.com'),
  DEXCOM_SHARE_BASE_URL: 'https://share1.dexcom.com/ShareWebServices/Services',
}));

// Mock services
vi.mock('../src/services/glucose.service.js', () => ({
  getReadings: vi.fn(),
  getDailySummary: vi.fn(),
  getLatestReading: vi.fn(),
  calculateStatistics: vi.fn(),
}));

vi.mock('../src/services/events.service.js', () => ({
  getEventTimeline: vi.fn(),
  getInsulinEvents: vi.fn(),
  getCarbEvents: vi.fn(),
}));

vi.mock('../src/services/modeling.service.js', () => ({
  detectParameterDrift: vi.fn(),
  analyzeEventOutcome: vi.fn(),
  predictGlucoseImpact: vi.fn(),
  predictCarbImpact: vi.fn(),
  getRecentDrift: vi.fn(),
}));

vi.mock('../src/services/chart.service.js', () => ({
  glucoseTimeSeries: vi.fn(),
  dailySummaryChart: vi.fn(),
  weeklyOverview: vi.fn(),
  agpChart: vi.fn(),
}));

vi.mock('../src/db/queries.js', () => ({
  getReadingsInRange: vi.fn(),
}));

import {
  analyzeTrendsHandler,
  compareExpectedVsActualHandler,
  detectParameterDriftHandler,
} from '../src/tools/analysis-tools.js';
import {
  getBaselineParametersHandler,
  predictGlucoseImpactHandler,
  getAdaptiveInsightsHandler,
} from '../src/tools/modeling-tools.js';
import { generateChartHandler } from '../src/tools/chart-tools.js';

import * as glucoseService from '../src/services/glucose.service.js';
import * as eventsService from '../src/services/events.service.js';
import * as modelingService from '../src/services/modeling.service.js';
import * as chartService from '../src/services/chart.service.js';
import * as queries from '../src/db/queries.js';

describe('Analysis Tools', () => {
  let db: any;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeTestDb();
  });

  describe('analyze_trends', () => {
    it('should analyze glucose trends over specified days', async () => {
      vi.mocked(glucoseService.getReadings).mockResolvedValue(mockGlucoseReadings);
      vi.mocked(eventsService.getEventTimeline).mockReturnValue([]);
      vi.mocked(glucoseService.calculateStatistics).mockReturnValue({
        average: 118,
        standardDeviation: 28,
        min: 68,
        max: 165,
        timeInRange: 75,
        timeBelowRange: 8,
        timeAboveRange: 17,
        readingCount: 12,
        coefficientOfVariation: 24,
      });

      const args = { days: 7 };
      const result = await analyzeTrendsHandler(args);

      console.log('\n=== analyze_trends TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));
      console.log('Response:', result.content[0].text);

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        period: {
          start: expect.any(String),
          end: expect.any(String),
          days: 7,
        },
        overallStatistics: expect.objectContaining({
          average: expect.any(Number),
          timeInRange: expect.any(Number),
        }),
        overnightPattern: expect.objectContaining({
          statistics: expect.any(Object),
          note: expect.any(String),
        }),
        postMealPatterns: expect.objectContaining({
          mealsAnalyzed: expect.any(Number),
          note: expect.any(String),
        }),
        exerciseImpact: expect.objectContaining({
          sessionsAnalyzed: expect.any(Number),
          note: expect.any(String),
        }),
        disclaimer: expect.stringContaining('assistive analysis'),
      });

      console.log('\nOvernight Pattern:', JSON.stringify(data.overnightPattern, null, 2));
      console.log('Post-Meal Patterns:', JSON.stringify(data.postMealPatterns, null, 2));
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(glucoseService.getReadings).mockRejectedValue(new Error('Service error'));

      const result = await analyzeTrendsHandler({ days: 7 });

      expect(result.content[0].text).toContain('Error analyzing trends');
      expect(result.isError).toBe(true);
    });
  });

  describe('compare_expected_vs_actual', () => {
    it('should compare predicted vs actual glucose for insulin event', async () => {
      vi.mocked(queries.getReadingsInRange).mockReturnValue(mockGlucoseReadings);
      vi.mocked(modelingService.predictGlucoseImpact).mockReturnValue({
        currentGlucose: 150,
        predictedChange: -60,
        predictedGlucose: 90,
        confidenceRange: { low: 75, high: 105 },
        timeHorizonMinutes: 180,
        factors: ['ISF: 30 mg/dL per unit'],
        disclaimer: 'Test disclaimer',
      });
      vi.mocked(modelingService.analyzeEventOutcome).mockReturnValue({
        observationType: 'isf_deviation',
        expectedValue: 90,
        actualValue: 85,
        deviationPct: -6,
        context: {},
        hypothesis: 'ISF appears accurate',
        timestamp: '2024-01-15T12:00:00Z',
      });

      const args = {
        event_type: 'insulin' as const,
        event_timestamp: '2024-01-15T12:00:00Z',
        event_value: 2.0,
        current_glucose: 150,
        window_hours: 4,
      };

      const result = await compareExpectedVsActualHandler(args);

      console.log('\n=== compare_expected_vs_actual TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));
      console.log('Response:', result.content[0].text);

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        event: {
          type: 'insulin',
          value: 2.0,
          timestamp: expect.any(String),
          startingGlucose: 150,
        },
        prediction: expect.objectContaining({
          predictedGlucose: expect.any(Number),
          predictedChange: expect.any(Number),
        }),
        actual: {
          readingsAnalyzed: expect.any(Number),
          finalGlucose: expect.any(Number),
        },
        observation: expect.objectContaining({
          observationType: expect.any(String),
          deviationPct: expect.any(Number),
        }),
        disclaimer: expect.stringContaining('baseline parameters'),
      });

      console.log('\nPrediction vs Actual:', JSON.stringify({
        prediction: data.prediction,
        actual: data.actual,
      }, null, 2));
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(queries.getReadingsInRange).mockImplementation(() => {
        throw new Error('Database error');
      });

      const result = await compareExpectedVsActualHandler({
        event_type: 'insulin',
        event_timestamp: '2024-01-15T12:00:00Z',
        event_value: 2.0,
        current_glucose: 150,
      });

      expect(result.content[0].text).toContain('Error comparing expected vs actual');
      expect(result.isError).toBe(true);
    });
  });

  describe('detect_parameter_drift', () => {
    it('should detect parameter drift over specified days', async () => {
      vi.mocked(modelingService.detectParameterDrift).mockReturnValue({
        observations: [
          {
            observationType: 'isf_deviation',
            expectedValue: 90,
            actualValue: 100,
            deviationPct: 11,
            context: {},
            hypothesis: 'ISF may have decreased',
            timestamp: '2024-01-15T12:00:00Z',
          },
        ],
        driftSummary: {
          isfDrift: { detected: true, avgDeviation: 11 },
          icrDrift: { detected: false, avgDeviation: 2 },
          patterns: ['ISF appears to have decreased by ~10%'],
        },
        recommendation: 'Consider adjusting ISF from 30 to 27',
      });

      const args = { days: 14 };
      const result = await detectParameterDriftHandler(args);

      console.log('\n=== detect_parameter_drift TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));
      console.log('Response:', result.content[0].text);

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        analysisWindow: '14 days',
        observationCount: expect.any(Number),
        driftDetected: expect.any(Boolean),
        findings: expect.objectContaining({
          isfDrift: expect.any(Object),
          icrDrift: expect.any(Object),
          patterns: expect.any(Array),
        }),
        recentObservations: expect.any(Array),
        recommendation: expect.any(String),
        disclaimer: expect.stringContaining('observations'),
      });

      console.log('\nDrift Findings:', JSON.stringify(data.findings, null, 2));
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(modelingService.detectParameterDrift).mockImplementation(() => {
        throw new Error('Service error');
      });

      const result = await detectParameterDriftHandler({ days: 14 });

      expect(result.content[0].text).toContain('Error detecting parameter drift');
      expect(result.isError).toBe(true);
    });
  });
});

describe('Modeling Tools', () => {
  let db: any;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeTestDb();
  });

  describe('get_baseline_parameters', () => {
    it('should return baseline diabetes parameters', async () => {
      const result = await getBaselineParametersHandler();

      console.log('\n=== get_baseline_parameters TEST ===');
      console.log('Response:', result.content[0].text);

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        baselineParameters: {
          insulinSensitivityFactor: {
            value: expect.any(Number),
            description: expect.stringContaining('mg/dL'),
          },
          insulinToCarbRatio: {
            value: expect.any(Number),
            description: expect.stringContaining('carbohydrates'),
          },
          basalDose: {
            value: expect.any(Number),
            description: expect.stringContaining('long-acting'),
          },
        },
        note: expect.stringContaining('never auto-modified'),
      });

      console.log('\nBaseline Parameters:', JSON.stringify(data.baselineParameters, null, 2));
    });
  });

  describe('predict_glucose_impact', () => {
    it('should predict insulin impact on glucose', async () => {
      vi.mocked(modelingService.predictGlucoseImpact).mockReturnValue({
        currentGlucose: 180,
        predictedChange: -60,
        predictedGlucose: 120,
        confidenceRange: { low: 105, high: 135 },
        timeHorizonMinutes: 180,
        factors: ['ISF: 30 mg/dL per unit'],
        disclaimer: 'Test disclaimer',
      });

      const args = {
        action_type: 'insulin' as const,
        insulin_units: 2.0,
        current_glucose: 180,
      };

      const result = await predictGlucoseImpactHandler(args);

      console.log('\n=== predict_glucose_impact (insulin) TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));
      console.log('Response:', result.content[0].text);

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        currentGlucose: 180,
        baselineParameters: {
          isf: expect.any(Number),
          icr: expect.any(Number),
        },
        insulin: expect.objectContaining({
          predictedChange: expect.any(Number),
          predictedGlucose: expect.any(Number),
        }),
        disclaimer: expect.stringContaining('baseline parameters'),
      });

      console.log('\nInsulin Prediction:', JSON.stringify(data.insulin, null, 2));
    });

    it('should predict carb impact on glucose', async () => {
      vi.mocked(modelingService.predictCarbImpact).mockReturnValue({
        currentGlucose: 100,
        predictedChange: 75,
        predictedGlucose: 175,
        confidenceRange: { low: 160, high: 190 },
        timeHorizonMinutes: 120,
        factors: ['ICR: 4g per unit'],
        disclaimer: 'Test disclaimer',
      });

      const args = {
        action_type: 'carbs' as const,
        carb_grams: 60,
        current_glucose: 100,
      };

      const result = await predictGlucoseImpactHandler(args);

      console.log('\n=== predict_glucose_impact (carbs) TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));
      console.log('Response:', result.content[0].text);

      const data = JSON.parse(result.content[0].text);
      expect(data.carbs).toMatchObject({
        predictedChange: expect.any(Number),
        predictedGlucose: expect.any(Number),
      });

      console.log('\nCarb Prediction:', JSON.stringify(data.carbs, null, 2));
    });

    it('should predict combined insulin and carb impact', async () => {
      vi.mocked(modelingService.predictGlucoseImpact).mockReturnValue({
        currentGlucose: 150,
        predictedChange: -60,
        predictedGlucose: 90,
        confidenceRange: { low: 75, high: 105 },
        timeHorizonMinutes: 180,
        factors: [],
        disclaimer: '',
      });

      vi.mocked(modelingService.predictCarbImpact).mockReturnValue({
        currentGlucose: 150,
        predictedChange: 75,
        predictedGlucose: 225,
        confidenceRange: { low: 210, high: 240 },
        timeHorizonMinutes: 120,
        factors: [],
        disclaimer: '',
      });

      const args = {
        action_type: 'both' as const,
        insulin_units: 2.0,
        carb_grams: 60,
        current_glucose: 150,
      };

      const result = await predictGlucoseImpactHandler(args);

      console.log('\n=== predict_glucose_impact (both) TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));
      console.log('Response:', result.content[0].text);

      const data = JSON.parse(result.content[0].text);
      expect(data.combined).toMatchObject({
        insulinEffect: expect.any(Number),
        carbEffect: expect.any(Number),
        netChange: expect.any(Number),
        predictedGlucose: expect.any(Number),
      });

      console.log('\nCombined Prediction:', JSON.stringify(data.combined, null, 2));
    });

    it('should fetch current glucose if not provided', async () => {
      vi.mocked(glucoseService.getLatestReading).mockResolvedValue({
        value: 120,
        trend: 'flat',
        trendDescription: 'Stable',
        recordedAt: new Date().toISOString(),
        source: 'api',
      });

      vi.mocked(modelingService.predictGlucoseImpact).mockReturnValue({
        currentGlucose: 120,
        predictedChange: -30,
        predictedGlucose: 90,
        confidenceRange: { low: 80, high: 100 },
        timeHorizonMinutes: 180,
        factors: [],
        disclaimer: '',
      });

      const result = await predictGlucoseImpactHandler({
        action_type: 'insulin',
        insulin_units: 1.0,
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.currentGlucose).toBe(120);
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(glucoseService.getLatestReading).mockRejectedValue(new Error('API error'));

      const result = await predictGlucoseImpactHandler({
        action_type: 'insulin',
        insulin_units: 2.0,
      });

      expect(result.content[0].text).toContain('Error predicting glucose impact');
      expect(result.isError).toBe(true);
    });
  });

  describe('get_adaptive_insights', () => {
    it('should return adaptive insights from observations', async () => {
      vi.mocked(modelingService.getRecentDrift).mockReturnValue({
        summary: { totalObservations: 10, avgIsfDeviation: 8, avgIcrDeviation: 3 },
        isfObservations: [],
        icrObservations: [],
      });

      vi.mocked(modelingService.detectParameterDrift).mockReturnValue({
        observations: [],
        driftSummary: {
          isfDrift: { detected: true, avgDeviation: 8 },
          icrDrift: { detected: false, avgDeviation: 3 },
          patterns: ['ISF drift detected'],
        },
        recommendation: 'Consider adjusting ISF',
      });

      const args = { days: 14 };
      const result = await getAdaptiveInsightsHandler(args);

      console.log('\n=== get_adaptive_insights TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));
      console.log('Response:', result.content[0].text);

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        analysisWindow: '14 days',
        baselineParameters: expect.objectContaining({
          isf: expect.any(Number),
          icr: expect.any(Number),
          basalDose: expect.any(Number),
        }),
        observationsSummary: expect.any(Object),
        detectedDrift: expect.objectContaining({
          isfDrift: expect.any(Object),
          icrDrift: expect.any(Object),
          patterns: expect.any(Array),
        }),
        recommendation: expect.any(String),
        disclaimer: expect.stringContaining('assistive observations'),
      });

      console.log('\nAdaptive Insights:', JSON.stringify(data.detectedDrift, null, 2));
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(modelingService.getRecentDrift).mockImplementation(() => {
        throw new Error('Service error');
      });

      const result = await getAdaptiveInsightsHandler({ days: 14 });

      expect(result.content[0].text).toContain('Error getting adaptive insights');
      expect(result.isError).toBe(true);
    });
  });
});

describe('Chart Tools', () => {
  let db: any;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeTestDb();
  });

  describe('generate_chart', () => {
    it('should generate timeline chart', async () => {
      vi.mocked(glucoseService.getReadings).mockResolvedValue(mockGlucoseReadings);
      vi.mocked(eventsService.getEventTimeline).mockReturnValue([]);
      vi.mocked(chartService.glucoseTimeSeries).mockReturnValue({
        spec: { data: [], mark: 'line' },
        description: 'Glucose timeline chart',
      });

      const args = {
        chart_type: 'timeline' as const,
        start_date: '2024-01-15T00:00:00Z',
        end_date: '2024-01-15T23:59:59Z',
      };

      const result = await generateChartHandler(args);

      console.log('\n=== generate_chart (timeline) TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));
      console.log('Response:', result.content[0].text);

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        chartType: 'timeline',
        description: expect.any(String),
        vegaLiteSpec: expect.any(Object),
      });

      console.log('\nChart Description:', data.description);
    });

    it('should generate daily chart', async () => {
      vi.mocked(glucoseService.getDailySummary).mockResolvedValue({
        date: '2024-01-15',
        statistics: {
          average: 120,
          standardDeviation: 25,
          min: 70,
          max: 180,
          timeInRange: 85,
          timeBelowRange: 5,
          timeAboveRange: 10,
          readingCount: 288,
          coefficientOfVariation: 21,
        },
        readings: mockGlucoseReadings,
      });

      vi.mocked(chartService.dailySummaryChart).mockReturnValue({
        spec: { data: [], mark: 'line' },
        description: 'Daily glucose chart',
      });

      const args = {
        chart_type: 'daily' as const,
        date: '2024-01-15',
      };

      const result = await generateChartHandler(args);

      console.log('\n=== generate_chart (daily) TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        chartType: 'daily',
        date: '2024-01-15',
        statistics: expect.any(Object),
        vegaLiteSpec: expect.any(Object),
      });

      console.log('\nDaily Statistics:', JSON.stringify(data.statistics, null, 2));
    });

    it('should generate AGP chart', async () => {
      vi.mocked(glucoseService.getReadings).mockResolvedValue(mockGlucoseReadings);
      vi.mocked(chartService.agpChart).mockReturnValue({
        spec: { data: [], layer: [] },
        description: 'AGP chart',
      });

      const args = {
        chart_type: 'agp' as const,
        days: 14,
      };

      const result = await generateChartHandler(args);

      console.log('\n=== generate_chart (agp) TEST ===');
      console.log('Input:', JSON.stringify(args, null, 2));

      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({
        chartType: 'agp',
        days: 14,
        readingCount: expect.any(Number),
        vegaLiteSpec: expect.any(Object),
      });
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(glucoseService.getReadings).mockRejectedValue(new Error('Service error'));

      const result = await generateChartHandler({
        chart_type: 'timeline',
        start_date: '2024-01-15T00:00:00Z',
        end_date: '2024-01-15T23:59:59Z',
      });

      expect(result.content[0].text).toContain('Error generating chart');
      expect(result.isError).toBe(true);
    });
  });
});
