import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EnergyEntry } from '../src/core/types.ts'
import { CHANNEL_PICKS, advance, channelExists, channelRecord, emptyLedger, overflowLine, readChannelState } from '../src/energy/ledger.ts'
import { EveHistory, emptyHistoryState } from '../src/eve/history.ts'

function interval(start: string, durationMinutes: number, gridImportKwh: number, solarExportKwh = 0): EnergyEntry {
  return { local: start, start, durationMinutes, gridImportKwh, controlledLoadKwh: 0, solarExportKwh, costAud: null, feedInCreditAud: null }
}

const grid = CHANNEL_PICKS.grid_import
const unix = (text: string): number => Date.parse(text) / 1000

test('a half hour of 0.412 kWh is three entries of 824 W at the end of each 10-minute slot', () => {
  const result = advance(emptyLedger(), [interval('2026-09-29T01:00:00Z', 30, 0.412)], grid)
  const start = unix('2026-09-29T01:00:00Z')
  assert.deepEqual(result.entries, [
    { time: start + 600, deciwatts: 8240 },
    { time: start + 1200, deciwatts: 8240 },
    { time: start + 1800, deciwatts: 8240 },
  ])
  assert.deepEqual(result.channel, { seen: true, totalKwh: 0.412, through: '2026-09-29T01:30:00Z' })
  assert.deepEqual(result.taken, { firstStart: '2026-09-29T01:00:00Z', lastEnd: '2026-09-29T01:30:00Z', deltaKwh: 0.412 })
})

test('the 120-minute merged daylight-saving interval gives 12 entries with the energy spread evenly', () => {
  const result = advance(emptyLedger(), [interval('2026-04-04T15:00:00Z', 120, 1.2)], grid)
  assert.equal(result.entries.length, 12)
  assert.ok(result.entries.every((entry) => entry.deciwatts === 6000))
  assert.equal(result.channel.through, '2026-04-04T17:00:00Z')
})

test('an interval above 6,553.5 W gives no entries, counts in the total and is reported', () => {
  const result = advance(emptyLedger(), [interval('2026-09-29T01:00:00Z', 30, 0.5), interval('2026-09-29T01:30:00Z', 30, 3.5), interval('2026-09-29T02:00:00Z', 30, 3.276)], grid)
  assert.equal(result.entries.length, 6)
  assert.deepEqual(result.overflow, [{ start: '2026-09-29T01:30:00Z', durationMinutes: 30, kwh: 3.5, deciwatts: 70000 }])
  assert.equal(result.entries.filter((entry) => entry.deciwatts === 65520).length, 3)
  assert.equal(result.channel.totalKwh, 0.5 + 3.5 + 3.276)
  assert.equal(overflowLine('grid_import', result.overflow), 'grid_import: 1 intervals with 3.5 kWh average above 6553.5 W have no Eve history entries (2026-09-29T01:30:00Z)')
})

test('nothing is taken twice: a revised interval already taken and one that appears behind through are ignored', () => {
  const first = advance(emptyLedger(), [interval('2026-09-29T01:00:00Z', 30, 0.4), interval('2026-09-29T01:30:00Z', 30, 0.2)], grid)
  const second = advance(
    first.channel,
    [interval('2026-09-29T00:30:00Z', 30, 9), interval('2026-09-29T01:00:00Z', 30, 0.5), interval('2026-09-29T01:30:00Z', 30, 0.3), interval('2026-09-29T02:00:00Z', 30, 0.1)],
    grid,
  )
  assert.equal(second.entries.length, 3)
  assert.deepEqual(second.taken, { firstStart: '2026-09-29T02:00:00Z', lastEnd: '2026-09-29T02:30:00Z', deltaKwh: 0.1 })
  assert.equal(second.channel.totalKwh, 0.4 + 0.2 + 0.1)
  const third = advance(second.channel, [interval('2026-09-29T02:00:00Z', 30, 0.7)], grid)
  assert.deepEqual(third, { channel: second.channel, entries: [], overflow: [], taken: null })
})

test('a channel other than grid import exists once it has seen energy', () => {
  const zero = advance(emptyLedger(), [interval('2026-09-29T01:00:00Z', 30, 0.4, 0)], CHANNEL_PICKS.solar_export)
  assert.equal(zero.entries.length, 3)
  assert.equal(channelExists('solar_export', zero.channel), false)
  assert.equal(channelExists('grid_import', zero.channel), true)
  const some = advance(emptyLedger(), [interval('2026-09-29T01:00:00Z', 30, 0.4, 0.05)], CHANNEL_PICKS.solar_export)
  assert.equal(channelExists('solar_export', some.channel), true)
})

test('negative energy, a duration that is not a multiple of 10 minutes and overlapping intervals are invalid states', () => {
  assert.throws(() => advance(emptyLedger(), [interval('2026-09-29T01:00:00Z', 30, -0.1)], grid), /-0.1 kWh/)
  assert.throws(() => advance(emptyLedger(), [interval('2026-09-29T01:00:00Z', 25, 0.1)], grid), /25 minutes/)
  assert.throws(() => advance(emptyLedger(), [interval('2026-09-29T01:00:00Z', 60, 0.1), interval('2026-09-29T01:30:00Z', 30, 0.1)], grid), /starts before 2026-09-29T02:00:00Z/)
})

test('the channel state survives its record and a broken record names the field', () => {
  const taken = advance(emptyLedger(), [interval('2026-09-29T01:00:00Z', 30, 0.412)], grid)
  const history = new EveHistory(emptyHistoryState(16))
  for (const entry of taken.entries) history.add(entry.time, entry.deciwatts)
  const record = JSON.parse(JSON.stringify(channelRecord({ ...taken.channel, history: history.state })))
  assert.deepEqual(readChannelState(record, 'channels.grid_import'), { ...taken.channel, history: history.state })
  assert.throws(() => readChannelState({ ...record, totalKwh: '1' }, 'channels.grid_import'), /channels\.grid_import\.totalKwh: "1"/)
  assert.throws(() => readChannelState({ ...record, history: { ...record.history, slots: [] } }, 'channels.grid_import'), /channels\.grid_import\.history\.slots/)
})
