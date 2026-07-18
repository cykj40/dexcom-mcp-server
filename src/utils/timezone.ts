type DateParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const dateFormatterOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
} as const

function getDateParts(instant: Date, timeZone: string): DateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    ...dateFormatterOptions,
    timeZone,
  }).formatToParts(instant)

  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]),
  )

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  }
}

function getOffsetMilliseconds(instant: Date, timeZone: string): number {
  const parts = getDateParts(instant, timeZone)
  const localTimeAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )

  return localTimeAsUtc - instant.getTime()
}

function parseCalendarDate(date: string): DateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) {
    throw new Error(`Invalid calendar date: ${date}. Expected YYYY-MM-DD.`)
  }

  const [year, month, day] = match.slice(1).map(Number)
  const candidate = new Date(Date.UTC(year, month - 1, day))
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${date}. Expected YYYY-MM-DD.`)
  }

  return { year, month, day, hour: 0, minute: 0, second: 0 }
}

function localTimeToUtc(parts: DateParts, timeZone: string): Date {
  const localTimeAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  let instant = new Date(localTimeAsUtc)

  // The offset is derived at the candidate instant and recalculated after each
  // adjustment so dates on either side of a DST transition resolve correctly.
  for (let attempt = 0; attempt < 3; attempt++) {
    const adjusted = localTimeAsUtc - getOffsetMilliseconds(instant, timeZone)
    if (adjusted === instant.getTime()) break
    instant = new Date(adjusted)
  }

  return instant
}

function nextCalendarDate(parts: DateParts): DateParts {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1))
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  }
}

/** Return the current YYYY-MM-DD calendar date in the given IANA timezone. */
export function todayInTimezone(timeZone: string): string {
  const { year, month, day } = getDateParts(new Date(), timeZone)
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`
}

/** Return the UTC instants that bound a local calendar day in the given timezone. */
export function dayBoundsInTimezone(date: string, timeZone: string): { start: Date; end: Date } {
  const startParts = parseCalendarDate(date)
  const start = localTimeToUtc(startParts, timeZone)
  const nextStart = localTimeToUtc(nextCalendarDate(startParts), timeZone)

  return {
    start,
    end: new Date(nextStart.getTime() - 1),
  }
}
