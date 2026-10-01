import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LocalTimeNonexistent, formatInstant, localOccurrences, localToInstant, nextDate, parseInstant, toLocal } from '../src/core/time.ts'

const sydney = 'Australia/Sydney'
const adelaide = 'Australia/Adelaide'

function at(text: string): number {
  const parsed = parseInstant(text)
  if (parsed === null) throw new Error(`test instant does not parse: ${text}`)
  return parsed
}

function occurrences(wall: string, zone: string): string[] {
  return localOccurrences(wall, zone).map(formatInstant)
}

test('toLocal crosses the Sydney daylight-saving start from 01:59:59 AEST to 03:00:00 AEDT', () => {
  assert.deepEqual(toLocal(at('2026-10-03T15:59:59Z'), sydney), { wall: '2026-10-04T01:59:59', date: '2026-10-04', minuteOfDay: 119, offsetSeconds: 36000 })
  assert.deepEqual(toLocal(at('2026-10-03T16:00:00Z'), sydney), { wall: '2026-10-04T03:00:00', date: '2026-10-04', minuteOfDay: 180, offsetSeconds: 39600 })
})

test('toLocal crosses the Sydney daylight-saving end from 02:59:59 AEDT back to 02:00:00 AEST', () => {
  assert.deepEqual(toLocal(at('2026-04-04T15:59:59Z'), sydney), { wall: '2026-04-05T02:59:59', date: '2026-04-05', minuteOfDay: 179, offsetSeconds: 39600 })
  assert.deepEqual(toLocal(at('2026-04-04T16:00:00Z'), sydney), { wall: '2026-04-05T02:00:00', date: '2026-04-05', minuteOfDay: 120, offsetSeconds: 36000 })
})

test('toLocal crosses the Adelaide daylight-saving start from 01:59:59 ACST to 03:00:00 ACDT', () => {
  assert.deepEqual(toLocal(at('2026-10-03T16:29:59Z'), adelaide), { wall: '2026-10-04T01:59:59', date: '2026-10-04', minuteOfDay: 119, offsetSeconds: 34200 })
  assert.deepEqual(toLocal(at('2026-10-03T16:30:00Z'), adelaide), { wall: '2026-10-04T03:00:00', date: '2026-10-04', minuteOfDay: 180, offsetSeconds: 37800 })
})

test('toLocal crosses the Adelaide daylight-saving end from 02:59:59 ACDT back to 02:00:00 ACST', () => {
  assert.deepEqual(toLocal(at('2026-04-04T16:29:59Z'), adelaide), { wall: '2026-04-05T02:59:59', date: '2026-04-05', minuteOfDay: 179, offsetSeconds: 37800 })
  assert.deepEqual(toLocal(at('2026-04-04T16:30:00Z'), adelaide), { wall: '2026-04-05T02:00:00', date: '2026-04-05', minuteOfDay: 120, offsetSeconds: 34200 })
})

test('toLocal reads a fractional instant as its whole second', () => {
  assert.deepEqual(toLocal(at('2026-10-01T03:59:59.999Z'), sydney), { wall: '2026-10-01T13:59:59', date: '2026-10-01', minuteOfDay: 839, offsetSeconds: 36000 })
})

test('localOccurrences finds no instant for a wall-clock time inside the skipped hour', () => {
  assert.deepEqual(occurrences('2026-10-04T02:30:00', sydney), [])
  assert.deepEqual(occurrences('2026-10-04T02:30:00', adelaide), [])
})

test('localOccurrences finds both passes of a wall-clock time inside the repeated hour, ascending', () => {
  assert.deepEqual(occurrences('2026-04-05T02:30:00', sydney), ['2026-04-04T15:30:00Z', '2026-04-04T16:30:00Z'])
  assert.deepEqual(occurrences('2026-04-05T02:30:00', adelaide), ['2026-04-04T16:00:00Z', '2026-04-04T17:00:00Z'])
})

test('localOccurrences finds one instant on either side of a transition', () => {
  assert.deepEqual(occurrences('2026-10-04T00:00:00', sydney), ['2026-10-03T14:00:00Z'])
  assert.deepEqual(occurrences('2026-10-04T03:00:00', sydney), ['2026-10-03T16:00:00Z'])
  assert.deepEqual(occurrences('2026-10-04T03:00:00', adelaide), ['2026-10-03T16:30:00Z'])
  assert.deepEqual(occurrences('2026-04-05T03:00:00.0000000', adelaide), ['2026-04-04T17:30:00Z'])
})

test('localToInstant takes the first pass of a repeated time and refuses a skipped one', () => {
  assert.equal(formatInstant(localToInstant('2026-04-05T02:00:00', sydney)), '2026-04-04T15:00:00Z')
  assert.throws(() => localToInstant('2026-10-04T02:00:00', adelaide), LocalTimeNonexistent)
})

test('nextDate steps over month, year and leap-year ends by integer arithmetic', () => {
  assert.equal(nextDate('2026-10-03'), '2026-10-04')
  assert.equal(nextDate('2026-04-30'), '2026-05-01')
  assert.equal(nextDate('2026-12-31'), '2027-01-01')
  assert.equal(nextDate('2027-02-28'), '2027-03-01')
  assert.equal(nextDate('2028-02-28'), '2028-02-29')
  assert.equal(nextDate('2100-02-28'), '2100-03-01')
  assert.equal(nextDate('2000-02-28'), '2000-02-29')
})
