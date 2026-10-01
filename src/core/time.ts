import { MS_PER_DAY, MS_PER_SECOND } from './constants.ts'

export interface LocalTime {
  wall: string
  date: string
  minuteOfDay: number
  offsetSeconds: number
}

export class LocalTimeNonexistent extends Error {
  readonly wall: string
  readonly zone: string

  constructor(wall: string, zone: string) {
    super(`${wall} does not exist in ${zone}`)
    this.name = 'LocalTimeNonexistent'
    this.wall = wall
    this.zone = zone
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(zone: string): Intl.DateTimeFormat {
  const existing = formatters.get(zone)
  if (existing !== undefined) return existing
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  formatters.set(zone, created)
  return created
}

export function zoneError(zone: string): string | null {
  try {
    formatterFor(zone)
    return null
  } catch (error) {
    if (error instanceof RangeError) return error.message
    throw error
  }
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

export function utcFromParts(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  return date.getTime()
}

export function toLocal(instantMs: number, zone: string): LocalTime {
  const parts = formatterFor(zone).formatToParts(instantMs)
  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type)
    if (part === undefined) throw new Error(`Intl.DateTimeFormat gave no ${type} part for ${instantMs} in ${zone}`)
    return Number(part.value)
  }
  const year = field('year')
  const month = field('month')
  const day = field('day')
  const hour = field('hour')
  const minute = field('minute')
  const second = field('second')
  const date = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
  const wall = `${date}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}`
  const wholeSecond = Math.floor(instantMs / MS_PER_SECOND) * MS_PER_SECOND
  const offsetSeconds = (utcFromParts(year, month, day, hour, minute, second) - wholeSecond) / MS_PER_SECOND
  return { wall, date, minuteOfDay: hour * 60 + minute, offsetSeconds }
}

const wallPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/
const instantPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

type Parts = [number, number, number, number, number, number]

function partsOf(match: RegExpExecArray): Parts {
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])]
}

function validParts([year, month, day, hour, minute, second]: Parts): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month) && hour <= 23 && minute <= 59 && second <= 59
}

export function isWallText(text: string): boolean {
  const match = wallPattern.exec(text)
  if (match === null) return false
  return validParts(partsOf(match))
}

export function wallAsUtc(wall: string): number {
  const match = wallPattern.exec(wall)
  if (match === null) throw new Error(`not a wall-clock time YYYY-MM-DDTHH:mm:ss: ${wall}`)
  const parts = partsOf(match)
  if (!validParts(parts)) throw new Error(`not a wall-clock time YYYY-MM-DDTHH:mm:ss: ${wall}`)
  return utcFromParts(...parts)
}

export function parseInstant(text: string): number | null {
  const match = instantPattern.exec(text)
  if (match === null) return null
  const parts = partsOf(match)
  if (!validParts(parts)) return null
  const fraction = match[7]
  const milliseconds = fraction === undefined ? 0 : Number(fraction.slice(0, 3).padEnd(3, '0'))
  const zone = match[8]
  if (zone === undefined) throw new Error(`instant pattern matched without a zone: ${text}`)
  let offsetMinutes = 0
  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3))
    const offsetMinutesPart = Number(zone.slice(4, 6))
    if (offsetHours > 23 || offsetMinutesPart > 59) return null
    offsetMinutes = (zone.startsWith('-') ? -1 : 1) * (offsetHours * 60 + offsetMinutesPart)
  }
  return utcFromParts(...parts) + milliseconds - offsetMinutes * 60000
}

export function formatInstant(instantMs: number): string {
  return `${new Date(Math.floor(instantMs / MS_PER_SECOND) * MS_PER_SECOND).toISOString().slice(0, 19)}Z`
}

export function formatInstantCeil(instantMs: number): string {
  return formatInstant(Math.ceil(instantMs / MS_PER_SECOND) * MS_PER_SECOND)
}

export function localOccurrences(wall: string, zone: string): number[] {
  const w = wall.slice(0, 19)
  const u = wallAsUtc(w)
  const offsets = new Set([toLocal(u - MS_PER_DAY, zone).offsetSeconds, toLocal(u + MS_PER_DAY, zone).offsetSeconds])
  return [...offsets]
    .map((offset) => u - offset * MS_PER_SECOND)
    .filter((candidate) => toLocal(candidate, zone).wall === w)
    .sort((a, b) => a - b)
}

export function localToInstant(wall: string, zone: string): number {
  const occurrences = localOccurrences(wall, zone)
  const first = occurrences[0]
  if (first === undefined) throw new LocalTimeNonexistent(wall.slice(0, 19), zone)
  return first
}

export function nextDate(date: string): string {
  const match = datePattern.exec(date)
  if (match === null) throw new Error(`not a date YYYY-MM-DD: ${date}`)
  let year = Number(match[1])
  let month = Number(match[2])
  let day = Number(match[3]) + 1
  if (day > daysInMonth(year, month)) {
    day = 1
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}
