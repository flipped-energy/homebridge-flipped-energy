import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { describe, test } from 'node:test'
import type { EnergyEntry } from '../src/core/types.ts'
import { advance, emptyLedger } from '../src/energy/ledger.ts'
import { EVE_EPOCH, ENERGY_ENTRY_TYPE, ENERGY_SIGNATURE, EveHistory, TRANSFER_DONE, emptyHistoryState, readHistoryState } from '../src/eve/history.ts'

interface IndexEntry {
  path: string
  sha256: string
}

interface FixtureInterval {
  start: string
  durationMinutes: number
  kwh: number
}

interface FixtureOverflow extends FixtureInterval {
  watts: number
  deciwatts: number
}

interface FixtureEntry {
  time: number
  watts: number
  deciwatts: number
}

interface Transfer {
  address: number
  request: string
  reads: string[]
}

interface Counters {
  firstEntry: number
  lastEntry: number
  usedMemory: number
  refTime: number
  initialTime: number
}

interface Fixture {
  name: string
  memorySize: number
  epoch: number
  signature: string
  entryType: string
  intervals: FixtureInterval[]
  overflow: FixtureOverflow[]
  entries: FixtureEntry[]
  restartAfterEntry: number | null
  beforeRestart: { historyStatus: string; historyEntries: Transfer[]; state: Counters } | null
  afterRestart: { historyEntries: Transfer[]; state: Counters } | null
  historyStatus: string
  historyEntries: Transfer[]
  state: Counters
}

const fixturesDirectory = new URL('./fixtures/eve-history/', import.meta.url)
const specDirectory = new URL('../../spec/eve-history/', import.meta.url)

function readText(name: string, directory: URL): Buffer {
  return readFileSync(new URL(name, directory))
}

const index: IndexEntry[] = JSON.parse(readText('index.json', fixturesDirectory).toString('utf8'))

function load(path: string): Fixture {
  return JSON.parse(readText(path, fixturesDirectory).toString('utf8'))
}

function energyEntry(interval: FixtureInterval): EnergyEntry {
  return { local: interval.start, start: interval.start, durationMinutes: interval.durationMinutes, gridImportKwh: interval.kwh, controlledLoadKwh: 0, solarExportKwh: 0, costAud: null, feedInCreditAud: null }
}

function counters(history: EveHistory): Counters {
  const { firstEntry, lastEntry, usedMemory, refTime, initialTime } = history.state
  if (initialTime === null) throw new Error('no initial time after entries were added')
  return { firstEntry, lastEntry, usedMemory, refTime, initialTime }
}

function replay(history: EveHistory, transfers: readonly Transfer[]): Transfer[] {
  return transfers.map((transfer) => {
    const address = Buffer.alloc(4)
    address.writeUInt32LE(transfer.address)
    const request = `0114${address.toString('hex')}0000`
    history.request(Buffer.from(transfer.request, 'hex'))
    const reads: string[] = []
    for (;;) {
      const read = history.read()
      reads.push(read)
      if (read === TRANSFER_DONE) break
      if (reads.length > 1000) throw new Error(`transfer from ${transfer.address} did not end`)
    }
    return { address: transfer.address, request, reads }
  })
}

function reload(history: EveHistory): EveHistory {
  return new EveHistory(readHistoryState(JSON.parse(JSON.stringify(history.state)), 'persisted'))
}

test('the fixture index lists every fixture file with its SHA-256', () => {
  const files = readdirSync(fixturesDirectory).filter((name) => name !== 'index.json').sort()
  assert.deepEqual(index.map((entry) => entry.path).sort(), files)
  for (const entry of index) assert.equal(createHash('sha256').update(readText(entry.path, fixturesDirectory)).digest('hex'), entry.sha256, entry.path)
})

test('the fixtures are byte-identical with spec/eve-history when the monorepo is present', { skip: !existsSync(specDirectory) }, () => {
  for (const name of ['index.json', ...index.map((entry) => entry.path)]) assert.ok(readText(name, fixturesDirectory).equals(readText(name, specDirectory)), name)
})

describe('Eve history bytes equal the fakegato-history golden fixtures', () => {
  for (const { path } of index) {
    const fixture = load(path)
    test(fixture.name, () => {
      assert.equal(fixture.epoch, EVE_EPOCH)
      assert.equal(fixture.signature.replaceAll(' ', ''), ENERGY_SIGNATURE)
      assert.equal(fixture.entryType, ENERGY_ENTRY_TYPE)
      const taken = advance(emptyLedger(), fixture.intervals.map(energyEntry), (entry) => entry.gridImportKwh)
      assert.deepEqual(
        taken.entries,
        fixture.entries.map((entry) => ({ time: entry.time, deciwatts: entry.deciwatts })),
      )
      assert.deepEqual(
        taken.overflow,
        fixture.overflow.map((item) => ({ start: item.start, durationMinutes: item.durationMinutes, kwh: item.kwh, deciwatts: item.deciwatts })),
      )
      let history = new EveHistory(emptyHistoryState(fixture.memorySize))
      const restartAt = fixture.restartAfterEntry ?? taken.entries.length
      for (const entry of taken.entries.slice(0, restartAt)) history.add(entry.time, entry.deciwatts)
      if (fixture.restartAfterEntry !== null) {
        const before = fixture.beforeRestart
        const after = fixture.afterRestart
        if (before === null || after === null) throw new Error(`${fixture.name}: restart without beforeRestart / afterRestart`)
        assert.equal(history.status(), before.historyStatus)
        assert.deepEqual(replay(history, before.historyEntries), before.historyEntries)
        assert.deepEqual(counters(history), before.state)
        history = reload(history)
        assert.deepEqual(replay(history, after.historyEntries), after.historyEntries)
        assert.deepEqual(counters(history), after.state)
      }
      for (const entry of taken.entries.slice(restartAt)) history.add(entry.time, entry.deciwatts)
      assert.equal(history.status(), fixture.historyStatus)
      assert.deepEqual(replay(history, fixture.historyEntries), fixture.historyEntries)
      assert.deepEqual(counters(history), fixture.state)
    })
  }
})

test('a read before any request ends the transfer at once', () => {
  const history = new EveHistory(emptyHistoryState(16))
  assert.equal(history.status(), null)
  assert.equal(history.read(), TRANSFER_DONE)
})

test('an entry older than the newest one is an invalid state', () => {
  const history = new EveHistory(emptyHistoryState(16))
  history.add(1790644200, 10)
  assert.throws(() => history.add(1790644199, 10), /before the newest entry/)
})
