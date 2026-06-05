import {
  getCarbEvents as dbGetCarbEvents,
  getExerciseEvents as dbGetExerciseEvents,
  getInsulinEvents as dbGetInsulinEvents,
  getReadingsInRange,
  insertCarbEvent,
  insertExerciseEvent,
  insertInsulinEvent,
} from '../db/queries.js'
import type { CarbEvent, EventTimeline, ExerciseEvent, InsulinEvent } from '../types/index.js'

// Re-export async query functions for direct use by tools
export {
  dbGetCarbEvents as getCarbEvents,
  dbGetExerciseEvents as getExerciseEvents,
  dbGetInsulinEvents as getInsulinEvents,
}

/**
 * Events Service
 * Manages insulin, carb, and exercise event logging and retrieval
 */

/**
 * Log an insulin event
 */
export async function logInsulin(event: InsulinEvent): Promise<number> {
  return insertInsulinEvent(event)
}

/**
 * Log a carb event
 */
export async function logCarbs(event: CarbEvent): Promise<number> {
  return insertCarbEvent(event)
}

/**
 * Log an exercise event
 */
export async function logExercise(event: ExerciseEvent): Promise<number> {
  return insertExerciseEvent(event)
}

/**
 * Get all events around a specific timestamp within a time window
 * Useful for correlation analysis
 */
export async function getEventsAround(
  timestamp: string,
  windowMinutes: number = 60,
): Promise<{
  insulin: InsulinEvent[]
  carbs: CarbEvent[]
  exercise: ExerciseEvent[]
}> {
  const centerTime = new Date(timestamp)
  const startTime = new Date(centerTime.getTime() - windowMinutes * 60 * 1000)
  const endTime = new Date(centerTime.getTime() + windowMinutes * 60 * 1000)

  const [insulin, carbs, exercise] = await Promise.all([
    dbGetInsulinEvents(startTime.toISOString(), endTime.toISOString()),
    dbGetCarbEvents(startTime.toISOString(), endTime.toISOString()),
    dbGetExerciseEvents(startTime.toISOString(), endTime.toISOString()),
  ])

  return { insulin, carbs, exercise }
}

/**
 * Get a merged, chronological timeline of all event types
 * Optionally includes glucose context for each event
 */
export async function getEventTimeline(
  startDate: string,
  endDate: string,
  includeGlucoseContext: boolean = true,
): Promise<EventTimeline[]> {
  const [insulin, carbs, exercise] = await Promise.all([
    dbGetInsulinEvents(startDate, endDate),
    dbGetCarbEvents(startDate, endDate),
    dbGetExerciseEvents(startDate, endDate),
  ])

  const timeline: EventTimeline[] = []

  // Add insulin events
  for (const event of insulin) {
    timeline.push({
      timestamp: event.timestamp,
      eventType: 'insulin',
      data: event,
    })
  }

  // Add carb events
  for (const event of carbs) {
    timeline.push({
      timestamp: event.timestamp,
      eventType: 'carbs',
      data: event,
    })
  }

  // Add exercise events
  for (const event of exercise) {
    timeline.push({
      timestamp: event.timestamp,
      eventType: 'exercise',
      data: event,
    })
  }

  // Sort by timestamp
  timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

  // Add glucose context if requested
  if (includeGlucoseContext) {
    const glucoseReadings = await getReadingsInRange(startDate, endDate)

    for (const event of timeline) {
      // Find the closest glucose reading within 15 minutes
      const eventTime = new Date(event.timestamp).getTime()
      let closestReading = null
      let closestDiff = Infinity

      for (const reading of glucoseReadings) {
        const readingTime = new Date(reading.recordedAt).getTime()
        const diff = Math.abs(eventTime - readingTime)

        if (diff < closestDiff && diff <= 15 * 60 * 1000) {
          // Within 15 minutes
          closestReading = reading
          closestDiff = diff
        }
      }

      if (closestReading) {
        event.glucoseContext = closestReading
      }
    }
  }

  return timeline
}

/**
 * Get events by type within a date range
 */
export async function getEventsByType(
  eventType: 'insulin' | 'carbs' | 'exercise',
  startDate: string,
  endDate: string,
): Promise<InsulinEvent[] | CarbEvent[] | ExerciseEvent[]> {
  switch (eventType) {
    case 'insulin':
      return dbGetInsulinEvents(startDate, endDate)
    case 'carbs':
      return dbGetCarbEvents(startDate, endDate)
    case 'exercise':
      return dbGetExerciseEvents(startDate, endDate)
  }
}

/**
 * Get summary of events for a date range
 */
export async function getEventsSummary(
  startDate: string,
  endDate: string,
): Promise<{
  totalInsulin: number
  totalCarbs: number
  totalExercise: number
  insulinByType: Record<string, number>
  exerciseByIntensity: Record<string, number>
}> {
  const [insulin, carbs, exercise] = await Promise.all([
    dbGetInsulinEvents(startDate, endDate),
    dbGetCarbEvents(startDate, endDate),
    dbGetExerciseEvents(startDate, endDate),
  ])

  const totalInsulin = insulin.reduce((sum, event) => sum + event.units, 0)
  const totalCarbs = carbs.reduce((sum, event) => sum + event.grams, 0)
  const totalExercise = exercise.length

  // Group insulin by type
  const insulinByType: Record<string, number> = {}
  for (const event of insulin) {
    insulinByType[event.type] = (insulinByType[event.type] || 0) + event.units
  }

  // Group exercise by intensity
  const exerciseByIntensity: Record<string, number> = {}
  for (const event of exercise) {
    if (event.intensity) {
      exerciseByIntensity[event.intensity] = (exerciseByIntensity[event.intensity] || 0) + 1
    }
  }

  return {
    totalInsulin,
    totalCarbs,
    totalExercise,
    insulinByType,
    exerciseByIntensity,
  }
}
