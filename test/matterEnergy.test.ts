import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { Taken } from '../src/energy/ledger.ts'
import { ENERGY_CLUSTER, MatterEnergy, confirms, energyPayload, nullPayload } from '../src/matter/energyAccessories.ts'
import { matterName } from '../src/matter/names.ts'
import { CHANNEL_NAMES, type ChannelName } from '../src/runtime/stateStore.ts'
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.ts'
import { LogRecorder } from './helpers/homebridgeHarness.ts'
import { OfflineMatter, matterStorage } from './helpers/matterServer.ts'

const ACCOUNT_A = '36200000001234'
const ACCOUNT_B = '36200000004321'
const NMI = '4103005678'
const TOTALS = { totalKwh: 10.5, through: '2026-09-30T14:00:00Z' }
const TAKEN: Taken = { firstStart: '2026-09-29T14:00:00Z', lastEnd: '2026-09-30T14:00:00Z', deltaKwh: 7.25 }

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error(`not an object: ${String(value)}`)
  return { ...value }
}

function featuresOf(offline: OfflineMatter, uuid: string): { displayName: unknown; clusters: string[]; features: Record<string, unknown> } {
  const info = record(offline.server.getAccessoryInfo(uuid))
  const clusters = record(info.clusters)
  const energy = record(clusters[ENERGY_CLUSTER])
  return { displayName: info.displayName, clusters: Object.keys(clusters).sort(), features: record(energy.featureMap) }
}

function energyOf(offline: OfflineMatter, uuid: string): Record<string, unknown> | undefined {
  return offline.server.getAccessoryState(uuid, ENERGY_CLUSTER)
}

function plugin(offline: OfflineMatter, log: LogRecorder): MatterEnergy {
  return new MatterEnergy({ api: offline.api, log: log.logging, pluginName: PLUGIN_NAME, platformName: PLATFORM_NAME })
}

function uuidOf(matter: MatterEnergy, key: ChannelName): string {
  const uuid = matter.endpoints.get(key)
  if (uuid === undefined) throw new Error(`no endpoint for ${key}`)
  return uuid
}

describe('against Homebridge MatterServer, offline', () => {
  let offline: OfflineMatter
  const log = new LogRecorder()
  let grid: MatterEnergy

  before(async () => {
    offline = await OfflineMatter.start(matterStorage())
  })

  after(async () => {
    await offline.stop()
  })

  test('the registration payloads create endpoints with the expected features for all three name shapes', async () => {
    const shapes = [
      { instanceKey: ACCOUNT_A, first: true, account: ACCOUNT_A, nmi: null },
      { instanceKey: ACCOUNT_B, first: false, account: ACCOUNT_B, nmi: null },
      { instanceKey: `${ACCOUNT_B}:${NMI}`, first: false, account: ACCOUNT_B, nmi: NMI },
    ]
    const bound = shapes.map((shape) => {
      const matter = plugin(offline, log)
      matter.bind(shape.instanceKey, new Set(CHANNEL_NAMES), true, (key) => matterName(shape.first, shape.account, shape.nmi, key))
      return { shape, matter }
    })
    const first = bound[0]
    if (first === undefined) throw new Error('three shapes expected')
    grid = first.matter
    await offline.settled()
    assert.deepEqual(offline.failures, [])
    for (const { shape, matter } of bound) {
      for (const key of CHANNEL_NAMES) {
        const uuid = uuidOf(matter, key)
        const exported = key === 'solar_export'
        assert.deepEqual(featuresOf(offline, uuid), {
          displayName: matterName(shape.first, shape.account, shape.nmi, key),
          clusters: [ENERGY_CLUSTER],
          features: { importedEnergy: !exported, exportedEnergy: exported, cumulativeEnergy: true, periodicEnergy: true, apparentEnergy: false, reactiveEnergy: false },
        })
        assert.ok(confirms(nullPayload(key), energyOf(offline, uuid)), key)
      }
    }
    assert.deepEqual(log.messages('error'), [])
  })

  test('the update payloads are accepted and read back equal: values with timestamps, cumulative only, null', async () => {
    const uuid = uuidOf(grid, 'grid_import')
    const steps = [energyPayload('grid_import', TOTALS, TAKEN), energyPayload('grid_import', { totalKwh: 11, through: '2026-10-01T02:00:00Z' }, null), nullPayload('grid_import')]
    await grid.push('grid_import', TOTALS, TAKEN)
    await offline.settled()
    assert.deepEqual(record(energyOf(offline, uuid)?.cumulativeEnergyImported), { energy: 10500000, endTimestamp: 1790776800, startTimestamp: undefined, startSystime: undefined, endSystime: undefined, apparentEnergy: undefined, reactiveEnergy: undefined })
    assert.ok(confirms(steps[0] ?? {}, energyOf(offline, uuid)))
    await grid.confirm()
    await grid.push('grid_import', { totalKwh: 11, through: '2026-10-01T02:00:00Z' }, null)
    await offline.settled()
    assert.ok(confirms(steps[1] ?? {}, energyOf(offline, uuid)))
    assert.ok(confirms({ periodicEnergyImported: { energy: 7250000, startTimestamp: 1790690400, endTimestamp: 1790776800 } }, energyOf(offline, uuid)))
    await grid.confirm()
    grid.pushNull('grid_import')
    await offline.settled()
    assert.ok(confirms(steps[2] ?? {}, energyOf(offline, uuid)))
    await grid.confirm()
    assert.deepEqual(offline.failures, [])
    assert.deepEqual(log.messages('error'), [])
  })

  test('endTimestamp == startTimestamp is rejected by matter.js and the confirmation reports the mismatch', async () => {
    assert.throws(() => energyPayload('grid_import', TOTALS, { ...TAKEN, firstStart: TAKEN.lastEnd }), /periodic end 2026-09-30T14:00:00Z is not after its start/)
    const uuid = uuidOf(grid, 'grid_import')
    const errors = log.messages('error').length
    const equal = { periodicEnergyImported: { energy: 1000, startTimestamp: 1790776800, endTimestamp: 1790776800 } }
    grid.send('grid_import', uuid, equal, false)
    await offline.settled()
    assert.equal(offline.failures.length, 1)
    assert.match(offline.failures[0] ?? '', /Constraint "min startTimestamp \+ 1"/)
    await grid.confirm()
    const reported = log.messages('error').slice(errors)
    assert.equal(reported.length, 1)
    assert.match(reported[0] ?? '', /^grid_import: Matter [0-9a-f-]+ electricalEnergyMeasurement sent \{ periodicEnergyImported: \{ energy: 1000, startTimestamp: 1790776800, endTimestamp: 1790776800 \} \}, read \{/)
    await offline.settled()
    assert.ok(confirms(nullPayload('grid_import'), energyOf(offline, uuid)))
    await grid.confirm()
    assert.equal(log.messages('error').length, errors + 1)
    offline.failures.length = 0
  })

  test('an update for a UUID with no endpoint leaves getAccessoryState undefined and is reported', async () => {
    const local = new LogRecorder()
    const matter = plugin(offline, local)
    matter.bind('36200000005555', new Set<ChannelName>(['grid_import']), true, () => 'Flipped Energy 1234 5678 Grid Import')
    await offline.settled()
    assert.equal(offline.failures.length, 1)
    assert.match(offline.failures[0] ?? '', /Failed to register accessory: AggregateError: Behaviors have errors/)
    const uuid = uuidOf(matter, 'grid_import')
    assert.equal(energyOf(offline, uuid), undefined)
    await matter.push('grid_import', TOTALS, TAKEN)
    assert.deepEqual(local.messages('error'), [`grid_import: ${uuid}: no Matter endpoint`])
    matter.send('grid_import', uuid, nullPayload('grid_import'), false)
    await offline.settled()
    await matter.confirm()
    assert.equal(local.messages('error')[1], `grid_import: Matter ${uuid} electricalEnergyMeasurement sent { cumulativeEnergyImported: null, periodicEnergyImported: null }, read undefined`)
    assert.equal(energyOf(offline, uuid), undefined)
    offline.failures.length = 0
  })
})

test('a second start on the same storage shows the restored endpoint holding the previous state until step 1 nulls it', async () => {
  const directory = matterStorage()
  const log = new LogRecorder()
  const instanceKey = ACCOUNT_A
  const name = (key: ChannelName): string => matterName(true, ACCOUNT_A, null, key)
  const channels = new Set<ChannelName>(['grid_import'])
  const first = await OfflineMatter.start(directory)
  let uuid: string
  try {
    const matter = plugin(first, log)
    matter.bind(instanceKey, channels, true, name)
    await first.settled()
    uuid = uuidOf(matter, 'grid_import')
    const written = first.cacheWritten((text) => text.includes('10500000') && text.includes('7250000'))
    await matter.push('grid_import', TOTALS, TAKEN)
    await first.settled()
    await written
  } finally {
    await first.stop()
  }
  const second = await OfflineMatter.start(directory)
  try {
    const sent = energyPayload('grid_import', TOTALS, TAKEN)
    assert.ok(confirms(sent, energyOf(second, uuid)))
    const cached = second.cached()
    assert.deepEqual(
      cached.map((accessory) => accessory.UUID),
      [uuid],
    )
    const matter = plugin(second, log)
    for (const accessory of cached) matter.configure(accessory)
    matter.nullCached()
    await second.settled()
    assert.ok(confirms(nullPayload('grid_import'), energyOf(second, uuid)))
    matter.bind(instanceKey, channels, true, name)
    await second.settled()
    assert.ok(confirms(nullPayload('grid_import'), energyOf(second, uuid)))
    assert.deepEqual(second.failures, [])
    assert.deepEqual(log.messages('error'), [])
  } finally {
    await second.stop()
  }
})
