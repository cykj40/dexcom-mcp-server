import type { GlucoseReading, ChartData, EventTimeline } from '../types/index.js';
import { TARGET_RANGE } from '../types/index.js';

/**
 * Chart Service
 * Generate Vega-Lite JSON specs that Claude can render
 */

/**
 * Generate a glucose timeline chart with optional event overlays
 */
export function glucoseTimeSeries(
  readings: GlucoseReading[],
  events?: EventTimeline[]
): ChartData {
  const data = readings.map((r) => ({
    time: r.recordedAt,
    value: r.value,
    inRange:
      r.value >= TARGET_RANGE.LOW && r.value <= TARGET_RANGE.HIGH
        ? 'in-range'
        : r.value < TARGET_RANGE.LOW
          ? 'low'
          : 'high',
  }));

  const layers: any[] = [
    // Target range band
    {
      mark: { type: 'rect', opacity: 0.2 },
      encoding: {
        y: { datum: TARGET_RANGE.LOW },
        y2: { datum: TARGET_RANGE.HIGH },
        color: { value: '#4CAF50' },
      },
    },
    // Glucose line
    {
      mark: { type: 'line', point: false, strokeWidth: 2 },
      encoding: {
        x: {
          field: 'time',
          type: 'temporal',
          title: 'Time',
          axis: { format: '%b %d %H:%M' },
        },
        y: {
          field: 'value',
          type: 'quantitative',
          title: 'Glucose (mg/dL)',
          scale: { domain: [40, 400] },
        },
        color: {
          field: 'inRange',
          type: 'nominal',
          scale: {
            domain: ['low', 'in-range', 'high'],
            range: ['#F44336', '#4CAF50', '#FF9800'],
          },
          legend: { title: 'Status' },
        },
      },
    },
  ];

  // Add event markers if provided
  if (events) {
    const insulinEvents = events
      .filter((e) => e.eventType === 'insulin')
      .map((e) => ({
        time: e.timestamp,
        type: 'Insulin',
      }));

    const carbEvents = events
      .filter((e) => e.eventType === 'carbs')
      .map((e) => ({
        time: e.timestamp,
        type: 'Carbs',
      }));

    const exerciseEvents = events
      .filter((e) => e.eventType === 'exercise')
      .map((e) => ({
        time: e.timestamp,
        type: 'Exercise',
      }));

    const allEventMarkers = [...insulinEvents, ...carbEvents, ...exerciseEvents];

    if (allEventMarkers.length > 0) {
      layers.push({
        data: { values: allEventMarkers },
        mark: { type: 'point', size: 100, filled: true },
        encoding: {
          x: { field: 'time', type: 'temporal' },
          y: { datum: 350 },
          shape: {
            field: 'type',
            type: 'nominal',
            scale: {
              domain: ['Insulin', 'Carbs', 'Exercise'],
              range: ['circle', 'triangle-up', 'square'],
            },
          },
          color: {
            field: 'type',
            type: 'nominal',
            scale: {
              domain: ['Insulin', 'Carbs', 'Exercise'],
              range: ['#2196F3', '#9C27B0', '#FF5722'],
            },
          },
        },
      });
    }
  }

  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    description: 'Glucose timeline with target range and events',
    width: 800,
    height: 400,
    data: { values: data },
    layer: layers,
  };

  const eventDescription = events
    ? ` with ${events.length} logged events (insulin, carbs, exercise)`
    : '';
  const description = `Glucose timeline showing ${readings.length} readings${eventDescription}. Green shaded area represents target range (${TARGET_RANGE.LOW}-${TARGET_RANGE.HIGH} mg/dL). Line color indicates glucose status: green (in range), red (low), orange (high).`;

  return { spec, description };
}

/**
 * Generate a daily summary chart (24-hour view)
 */
export function dailySummaryChart(
  readings: GlucoseReading[],
  events?: EventTimeline[]
): ChartData {
  if (readings.length === 0) {
    return {
      spec: { data: { values: [] } },
      description: 'No data available for this day',
    };
  }

  return glucoseTimeSeries(readings, events);
}

/**
 * Generate a weekly overview chart
 */
export function weeklyOverview(dailyStats: Array<{ date: string; avgGlucose: number; timeInRange: number }>): ChartData {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    description: 'Weekly glucose overview',
    width: 800,
    height: 300,
    data: { values: dailyStats },
    layer: [
      {
        mark: { type: 'bar', opacity: 0.7 },
        encoding: {
          x: {
            field: 'date',
            type: 'ordinal',
            title: 'Date',
            axis: { labelAngle: -45 },
          },
          y: {
            field: 'timeInRange',
            type: 'quantitative',
            title: 'Time in Range (%)',
            scale: { domain: [0, 100] },
          },
          color: {
            field: 'timeInRange',
            type: 'quantitative',
            scale: {
              domain: [0, 50, 70, 100],
              range: ['#F44336', '#FF9800', '#FFC107', '#4CAF50'],
            },
            legend: null,
          },
        },
      },
      {
        mark: { type: 'line', point: true, color: '#2196F3', strokeWidth: 2 },
        encoding: {
          x: { field: 'date', type: 'ordinal' },
          y: {
            field: 'avgGlucose',
            type: 'quantitative',
            title: 'Average Glucose (mg/dL)',
            axis: { orient: 'right' },
          },
        },
      },
    ],
    resolve: { scale: { y: 'independent' } },
  };

  const description = `Weekly overview showing daily average glucose (blue line) and time in range percentage (colored bars) for ${dailyStats.length} days. Target is 70%+ time in range.`;

  return { spec, description };
}

/**
 * Generate an AGP (Ambulatory Glucose Profile) chart
 * Shows median glucose by time of day with percentile bands
 */
export function agpChart(readings: GlucoseReading[]): ChartData {
  // Group readings by time of day (5-minute buckets)
  const buckets: Map<number, number[]> = new Map();

  for (const reading of readings) {
    const date = new Date(reading.recordedAt);
    const minutesFromMidnight = date.getHours() * 60 + date.getMinutes();
    const bucket = Math.floor(minutesFromMidnight / 5) * 5; // 5-minute buckets

    if (!buckets.has(bucket)) {
      buckets.set(bucket, []);
    }
    buckets.get(bucket)!.push(reading.value);
  }

  // Calculate percentiles for each bucket
  const agpData: Array<{
    time: string;
    median: number;
    p25: number;
    p75: number;
    p10: number;
    p90: number;
  }> = [];

  for (const [minutesFromMidnight, values] of buckets.entries()) {
    if (values.length < 3) continue; // Skip buckets with too few readings

    values.sort((a, b) => a - b);
    const hours = Math.floor(minutesFromMidnight / 60);
    const minutes = minutesFromMidnight % 60;
    const timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;

    agpData.push({
      time: timeStr,
      median: percentile(values, 50),
      p25: percentile(values, 25),
      p75: percentile(values, 75),
      p10: percentile(values, 10),
      p90: percentile(values, 90),
    });
  }

  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    description: 'Ambulatory Glucose Profile (AGP)',
    width: 800,
    height: 400,
    data: { values: agpData },
    layer: [
      // 10-90th percentile band
      {
        mark: { type: 'area', opacity: 0.2 },
        encoding: {
          x: { field: 'time', type: 'ordinal', title: 'Time of Day' },
          y: { field: 'p10', type: 'quantitative', title: 'Glucose (mg/dL)' },
          y2: { field: 'p90' },
          color: { value: '#2196F3' },
        },
      },
      // 25-75th percentile band
      {
        mark: { type: 'area', opacity: 0.4 },
        encoding: {
          x: { field: 'time', type: 'ordinal' },
          y: { field: 'p25', type: 'quantitative' },
          y2: { field: 'p75' },
          color: { value: '#2196F3' },
        },
      },
      // Median line
      {
        mark: { type: 'line', strokeWidth: 3 },
        encoding: {
          x: { field: 'time', type: 'ordinal' },
          y: { field: 'median', type: 'quantitative' },
          color: { value: '#1565C0' },
        },
      },
      // Target range reference lines
      {
        mark: { type: 'rule', strokeDash: [5, 5], color: '#4CAF50' },
        encoding: {
          y: { datum: TARGET_RANGE.LOW },
        },
      },
      {
        mark: { type: 'rule', strokeDash: [5, 5], color: '#4CAF50' },
        encoding: {
          y: { datum: TARGET_RANGE.HIGH },
        },
      },
    ],
  };

  const description = `AGP chart showing glucose patterns by time of day over ${readings.length} readings. Dark blue line is median, shaded bands show 25th-75th percentile (darker) and 10th-90th percentile (lighter). Dashed green lines mark target range.`;

  return { spec, description };
}

/**
 * Calculate percentile from sorted array
 */
function percentile(sortedValues: number[], p: number): number {
  const index = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  if (lower === upper) {
    return sortedValues[lower];
  }

  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}
