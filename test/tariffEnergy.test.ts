import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { EnergyEntry, SignalConfig, Snapshot } from '../src/core/types.ts'
import { readArray, readRecord } from '../src/core/types.ts'
import { tariffEnergy, tariffHistoryIntervals } from '../src/energy/tariff.ts'
import { advance, emptyLedger } from '../src/energy/ledger.ts'

function picker() {
  const vector: { input: { config: SignalConfig; account: Snapshot } } = JSON.parse(readFileSync(new URL('./vectors/tariff/tou-two-rate-peak.json', import.meta.url), 'utf8'))
  return tariffEnergy(vector.input.config, vector.input.account)
}

function interval(local: string, start: string): EnergyEntry {
  return { local, start, durationMinutes: 30, gridImportKwh: 1, controlledLoadKwh: 0, solarExportKwh: 0, costAud: null, feedInCreditAud: null }
}

test('tariff meters retain only energy during their hours', () => {
  const pick = picker()
  const peak = interval('2026-10-01T17:00:00', '2026-10-01T07:00:00Z')
  const offPeak = interval('2026-10-01T12:00:00', '2026-10-01T02:00:00Z')
  assert.equal(pick(peak, 'peak'), 1)
  assert.equal(pick(peak, 'off_peak'), 0)
  assert.equal(pick(offPeak, 'peak'), 0)
  assert.equal(pick(offPeak, 'off_peak'), 1)
  assert.equal(pick(peak, 'shoulder'), 0)
})

test('an interval crossing a tariff boundary is divided by time', () => {
  const pick = picker()
  const entry = interval('2026-10-01T14:50:00', '2026-10-01T04:50:00Z')
  assert.equal(pick(entry, 'peak'), 2 / 3)
  assert.equal(pick(entry, 'off_peak'), 1 / 3)
})

test('Eve samples at a tariff boundary contain energy only during that tariff', () => {
  const vector: { input: { config: SignalConfig; account: Snapshot } } = JSON.parse(readFileSync(new URL('./vectors/tariff/tou-two-rate-peak.json', import.meta.url), 'utf8'))
  const { config, account } = vector.input
  const entries = tariffHistoryIntervals([interval('2026-10-01T14:50:00', '2026-10-01T04:50:00Z')], config, account)
  const pick = tariffEnergy(config, account)
  const result = advance(emptyLedger(), entries, (entry) => {
    const value = pick(entry, 'peak')
    assert.ok(value !== null)
    return value
  })
  assert.deepEqual(result.entries.map((entry) => entry.deciwatts), [0, 20000, 20000])
  assert.equal(result.channel.totalKwh, 2 / 3)
})

test('history before the known plan is unclassified rather than counted as zero', () => {
  const pick = picker()
  const entry = interval('2025-10-01T17:00:00', '2025-10-01T07:00:00Z')
  assert.equal(pick(entry, 'peak'), null)
  assert.equal(pick(entry, 'off_peak'), null)
})

test('a merged repeated-hour interval follows actual local time across daylight saving', () => {
  const vector: { input: { config: SignalConfig; account: Snapshot } } = JSON.parse(readFileSync(new URL('./vectors/tariff/tou-two-rate-peak.json', import.meta.url), 'utf8'))
  const account = readRecord(readArray(readRecord(vector.input.account.body, 'body').accounts, 'accounts')[0], 'account')
  const plan = readRecord(readRecord(account.product, 'product').currentPlan, 'plan')
  plan.start = '2025-07-01T00:00:00'
  const units = readArray(plan.billingUnits, 'billingUnits').map((unit) => readRecord(unit, 'unit'))
  assert.ok(units[0])
  assert.ok(units[1])
  Object.assign(units[0], { timeOfDayStartMinutes: 0, timeOfDayEndMinutes: 180 })
  Object.assign(units[1], { timeOfDayStartMinutes: 180, timeOfDayEndMinutes: 0 })
  const pick = tariffEnergy(vector.input.config, vector.input.account)
  const entry = { ...interval('2026-04-05T02:00:00', '2026-04-04T15:00:00Z'), durationMinutes: 120 }
  assert.equal(pick(entry, 'peak'), 0)
  assert.equal(pick(entry, 'off_peak'), 1)
})
