import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PATHS } from '../src/api/endpoints.ts'
import { Instance } from '../src/runtime/instance.ts'
import { createScheduler } from '../src/runtime/scheduler.ts'
import { STATE_FILE_MODE, StateFileError, StateStore, instanceHash, instanceKeyOf } from '../src/runtime/stateStore.ts'
import { FakeClock } from './helpers/fakeClock.ts'
import { Script } from './helpers/scriptedTransport.ts'
import { SEQUENCE_SETS, assertReplay, loadSequence, readIndex, recordingLog, replay, replayFile } from './helpers/sequenceReplay.ts'

function withDirectory<T>(name: string, body: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), `flipped-${name}-`))
  return body(directory).finally(() => rmSync(directory, { recursive: true, force: true }))
}

function instanceAt(directory: string, accountNumber: string | null): { instance: Instance; script: Script } {
  const clock = new FakeClock(Date.parse('2026-10-01T02:21:10Z'))
  const script = new Script(clock, [])
  const instance = new Instance({
    config: { token: 'fdk_SEQUENCEFIXTURE000000000000000000wXyZ', accountNumber, nmi: null, priceHighThresholdCentsPerKwh: null, priceLowThresholdCentsPerKwh: null },
    transport: script.transport(),
    scheduler: createScheduler(clock, () => undefined),
    store: new StateStore(directory),
    log: recordingLog([]),
    signalsChanged: () => undefined,
    routineFailed: (error) => {
      throw error
    },
  })
  return { instance, script }
}

test('the three replay files cover the ten sequences of test/sequences/index.json', () => {
  const listed = readIndex().map((entry) => entry.path.replace(/\.json$/, '')).sort()
  const covered = [...SEQUENCE_SETS.priceLoop, ...SEQUENCE_SETS.sync, ...SEQUENCE_SETS.instance].sort()
  assert.equal(listed.length, 10)
  assert.deepEqual(covered, listed)
})

for (const name of SEQUENCE_SETS.instance) {
  test(`sequence ${name}: the pin is written on the first run and kept when a second account appears`, async () => {
    await withDirectory(name, async (directory) => {
      const sequence = loadSequence(name)
      const result = await replay(sequence, directory)
      assertReplay(sequence, result)
      const pinPath = join(directory, 'pin.json')
      assert.deepEqual(JSON.parse(readFileSync(pinPath, 'utf8')), { version: 1, accountNumber: sequence.expected.storedAccountNumber })
      assert.equal(statSync(pinPath).mode & 0o777, STATE_FILE_MODE)
      assert.equal(result.transportStops, 2)
      assert.equal(result.pendingAfterStop, 0)
    })
  })
}

test('start-up order is E1, E6, E7, E2, E4, E5, then the first E3', async () => {
  const result = await replayFile('price-loop-basics')
  const order = result.requests.slice(0, 7).map((request) => Object.entries(PATHS).find(([, path]) => path === request.path)?.[0])
  assert.deepEqual(order, ['E1', 'E6', 'E7', 'E2', 'E4', 'E5', 'E3'])
})

test('a configured accountNumber writes no pin.json', async () => {
  await withDirectory('configured', async (directory) => {
    const sequence = loadSequence('price-loop-basics')
    assert.notEqual(sequence.config.accountNumber, null)
    assertReplay(sequence, await replay(sequence, directory))
    assert.equal(existsSync(join(directory, 'pin.json')), false)
  })
})

test('an unparsable pin.json throws the raw parse error with the file name', async () => {
  await withDirectory('unparsable', async (directory) => {
    writeFileSync(join(directory, 'pin.json'), '{"version":1,')
    let expected = ''
    try {
      JSON.parse('{"version":1,')
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      expected = error.message
    }
    assert.throws(() => instanceAt(directory, null), (error: unknown) => error instanceof StateFileError && error.message === `${join(directory, 'pin.json')}: ${expected}`)
  })
})

test('a pin.json with an unknown version throws', async () => {
  await withDirectory('version', async (directory) => {
    writeFileSync(join(directory, 'pin.json'), '{"version":2,"accountNumber":"36200000000001"}')
    assert.throws(() => instanceAt(directory, null), (error: unknown) => error instanceof StateFileError && error.message.endsWith('version 2, expected 1'))
  })
})

test('a configured accountNumber does not read pin.json', async () => {
  await withDirectory('ignored', async (directory) => {
    writeFileSync(join(directory, 'pin.json'), 'not json')
    const { instance, script } = instanceAt(directory, '36200000000002')
    assert.equal(instance.accountNumber, '36200000000002')
    assert.equal(script.sent.length, 0)
  })
})

test('instance-<h>.json round-trips with mode 0600 under the first 16 hex characters of SHA-256 of the instanceKey', async () => {
  await withDirectory('state', async (directory) => {
    const store = new StateStore(directory)
    const instanceKey = instanceKeyOf('36200000000001', '4102000000')
    assert.equal(instanceKey, '36200000000001:4102000000')
    assert.match(instanceHash(instanceKey), /^[0-9a-f]{16}$/)
    assert.equal(store.readInstance(instanceKey), null)
    const state = { version: 1 as const, instanceKey, channels: { grid_import: { totalKwh: 1.5 } } }
    store.writeInstance(state)
    const path = join(directory, `instance-${instanceHash(instanceKey)}.json`)
    assert.equal(statSync(path).mode & 0o777, STATE_FILE_MODE)
    assert.deepEqual(store.readInstance(instanceKey), state)
    assert.equal(existsSync(`${path}.tmp`), false)
  })
})
