import { describe, expect, it } from 'vitest'
import { dayBoundsInTimezone, todayInTimezone } from '../src/utils/timezone.js'

describe('timezone utilities', () => {
  it.each([
    ['2026-07-16', 'America/New_York', '2026-07-16T04:00:00.000Z', '2026-07-17T03:59:59.999Z'],
    ['2026-01-15', 'America/New_York', '2026-01-15T05:00:00.000Z', '2026-01-16T04:59:59.999Z'],
    ['2026-03-08', 'America/New_York', '2026-03-08T05:00:00.000Z', '2026-03-09T03:59:59.999Z'],
    ['2026-11-01', 'America/New_York', '2026-11-01T04:00:00.000Z', '2026-11-02T04:59:59.999Z'],
    ['2026-07-16', 'UTC', '2026-07-16T00:00:00.000Z', '2026-07-16T23:59:59.999Z'],
    ['2026-07-16', 'Asia/Kolkata', '2026-07-15T18:30:00.000Z', '2026-07-16T18:29:59.999Z'],
  ])('calculates bounds for %s in %s', (date, timeZone, expectedStart, expectedEnd) => {
    const { start, end } = dayBoundsInTimezone(date, timeZone)

    expect(start.toISOString()).toBe(expectedStart)
    expect(end.toISOString()).toBe(expectedEnd)
  })

  it('returns a YYYY-MM-DD date and matches UTC today', () => {
    expect(todayInTimezone('America/New_York')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(todayInTimezone('UTC')).toBe(new Date().toISOString().slice(0, 10))
  })
})
