import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { MatterAccessory } from 'homebridge'
import { deviceTypes } from '../node_modules/homebridge/dist/matter/types.js'
import { ApiClient } from '../src/api/client.ts'
import { HTTP_TIMEOUT_S, WAIT_HTTP_TIMEOUT_S } from '../src/core/constants.ts'
import { ENERGY_CLUSTER, MatterEnergy, type MatterEnergyApi, nullPayload } from '../src/matter/energyAccessories.ts'
import { matterName, matterUuidSeed } from '../src/matter/names.ts'
import { Platform, type PlatformApi } from '../src/platform.ts'
import { CHANNEL_NAMES, type ChannelName } from '../src/runtime/stateStore.ts'
import { PLATFORM_NAME, PLUGIN_NAME, PRODUCT_NAME } from '../src/settings.ts'
import { FakeClock } from './helpers/fakeClock.ts'
import { HomebridgeAPI, LogRecorder, emitterOf, storagePath } from './helpers/homebridgeHarness.ts'
import { loadSequence } from './helpers/sequenceReplay.ts'
import { type StubServer, startStub } from './helpers/stubServer.ts'

interface Call {
  method: 'register' | 'unregister' | 'update' | 'get'
  uuids: string[]
  attributes?: Record<string, unknown>
}

const ACCOUNT_NUMBER = '36200000000001'
const { hap } = new HomebridgeAPI()

class Recorder implements MatterEnergyApi {
  readonly calls: Call[] = []
  readonly uuid = hap.uuid
  readonly deviceTypes = { ElectricalSensor: deviceTypes.ElectricalSensor }
  readonly #states = new Map<string, Record<string, unknown>>()

  registerPlatformAccessories(_plugin: string, _platform: string, accessories: MatterAccessory[]): Promise<void> {
    this.calls.push({ method: 'register', uuids: accessories.map((accessory) => accessory.UUID) })
    for (const accessory of accessories) this.#states.set(accessory.UUID, { ...accessory.clusters?.[ENERGY_CLUSTER] })
    return Promise.resolve()
  }

  unregisterPlatformAccessories(_plugin: string, _platform: string, accessories: MatterAccessory[]): Promise<void> {
    this.calls.push({ method: 'unregister', uuids: accessories.map((accessory) => accessory.UUID) })
    return Promise.resolve()
  }

  updateAccessoryState(uuid: string, _cluster: string, attributes: Record<string, unknown>): Promise<void> {
    this.calls.push({ method: 'update', uuids: [uuid], attributes })
    const state = this.#states.get(uuid)
    if (state !== undefined) Object.assign(state, attributes)
    return Promise.resolve()
  }

  getAccessoryState(uuid: string): Promise<Record<string, unknown> | undefined> {
    this.calls.push({ method: 'get', uuids: [uuid] })
    return Promise.resolve(this.#states.get(uuid))
  }
}

function plugin(api: MatterEnergyApi, log = new LogRecorder()): MatterEnergy {
  return new MatterEnergy({ api, log: log.logging, pluginName: PLUGIN_NAME, platformName: PLATFORM_NAME })
}

function cachedAccessory(key: ChannelName): MatterAccessory {
  return {
    UUID: hap.uuid.generate(matterUuidSeed(ACCOUNT_NUMBER, key)),
    displayName: matterName(true, ACCOUNT_NUMBER, null, key),
    deviceType: deviceTypes.ElectricalSensor,
    serialNumber: 'cached',
    manufacturer: 'Flipped Energy',
    model: 'Energy History',
    context: { schema: 1, instanceKey: ACCOUNT_NUMBER, key },
    clusters: { [ENERGY_CLUSTER]: { cumulativeEnergyImported: { energy: 5, endTimestamp: 1 }, periodicEnergyImported: null } },
  }
}

test('one accessory per register call', () => {
  const recorder = new Recorder()
  plugin(recorder).bind(ACCOUNT_NUMBER, new Set(CHANNEL_NAMES), true, (key) => matterName(true, ACCOUNT_NUMBER, null, key))
  assert.deepEqual(
    recorder.calls.map((call) => [call.method, call.uuids.length]),
    [
      ['register', 1],
      ['register', 1],
      ['register', 1],
      ['register', 1],
      ['register', 1],
      ['register', 1],
    ],
  )
})

test('no update in the same turn as a first-time registration; the cached endpoint is nulled first', () => {
  const recorder = new Recorder()
  const matter = plugin(recorder)
  const cached = cachedAccessory('grid_import')
  matter.configure(cached)
  matter.nullCached()
  matter.bind(ACCOUNT_NUMBER, new Set<ChannelName>(['grid_import', 'solar_export']), true, (key) => matterName(true, ACCOUNT_NUMBER, null, key))
  const solar = matter.endpoints.get('solar_export')
  assert.deepEqual(recorder.calls, [
    { method: 'update', uuids: [cached.UUID], attributes: { cumulativeEnergyImported: null, periodicEnergyImported: null } },
    { method: 'register', uuids: [cached.UUID] },
    { method: 'register', uuids: [solar] },
  ])
  assert.equal(
    recorder.calls.some((call) => call.method === 'update' && call.uuids[0] === solar),
    false,
  )
})

test('a cached accessory of another instance, of a channel not in the state file, or with matterEnergy off is removed', () => {
  const recorder = new Recorder()
  const matter = plugin(recorder)
  const grid = cachedAccessory('grid_import')
  matter.configure(grid)
  matter.bind(ACCOUNT_NUMBER, new Set<ChannelName>(), true, (key) => matterName(true, ACCOUNT_NUMBER, null, key))
  assert.deepEqual(recorder.calls, [{ method: 'unregister', uuids: [grid.UUID] }])
  const off = new Recorder()
  const disabled = plugin(off)
  disabled.configure(grid)
  disabled.bind(ACCOUNT_NUMBER, new Set<ChannelName>(['grid_import']), false, (key) => matterName(true, ACCOUNT_NUMBER, null, key))
  assert.deepEqual(off.calls, [{ method: 'unregister', uuids: [grid.UUID] }])
  assert.deepEqual(nullPayload('solar_export'), { cumulativeEnergyExported: null, periodicEnergyExported: null })
})

const storage = storagePath()
const configPath = join(storage, 'config.json')
const pluginDirectory = join(storage, PRODUCT_NAME)
const BLOCK = { platform: PLATFORM_NAME, name: 'Flipped Energy', token: 'fdk_SEQUENCEFIXTURE000000000000000000wXyZ', matterEnergy: true, _bridge: { name: 'Flipped Energy Bridge', username: '0E:11:22:33:44:55', pin: '031-45-154', port: 51900, matter: {} } }

function handed(block: { platform: string } & Record<string, unknown>): { platform: string } & Record<string, unknown> {
  const copy: { platform: string } & Record<string, unknown> = { ...block }
  delete copy._bridge
  return copy
}

function fixtureStub(): Promise<StubServer> {
  const sequence = loadSequence('first-run-account-pinning')
  return startStub((request, response) => {
    const path = new URL(request.url ?? '', 'http://stub').pathname
    const answer = sequence.responses.find((candidate) => candidate.path === path && 'status' in candidate.answer && candidate.answer.status === 200)?.answer
    if (answer === undefined || !('status' in answer)) {
      response.writeHead(500)
      response.end(`no 200 answer for ${path}`)
      return
    }
    response.writeHead(answer.status, answer.headers)
    response.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body))
  })
}

function launch(baseUrl: string, recorder: Recorder, enabled: boolean, cached: MatterAccessory[]): { homebridge: HomebridgeAPI; log: LogRecorder; platform: Platform<number> } {
  const homebridge = new HomebridgeAPI()
  const api: PlatformApi = {
    hap: homebridge.hap,
    user: homebridge.user,
    platformAccessory: homebridge.platformAccessory,
    registerPlatformAccessories: (plugin, platform, accessories) => homebridge.registerPlatformAccessories(plugin, platform, accessories),
    updatePlatformAccessories: (accessories) => homebridge.updatePlatformAccessories(accessories),
    unregisterPlatformAccessories: (plugin, platform, accessories) => homebridge.unregisterPlatformAccessories(plugin, platform, accessories),
    isMatterEnabled: () => enabled,
    matter: recorder,
    on: (event: 'didFinishLaunching' | 'shutdown', listener: () => void) => emitterOf(homebridge).on(event, listener),
  }
  const log = new LogRecorder()
  const platform = new Platform(log.logging, handed(BLOCK), api, {
    createTransport: (token) => new ApiClient({ baseUrl, token, httpTimeoutS: HTTP_TIMEOUT_S, waitHttpTimeoutS: WAIT_HTTP_TIMEOUT_S }),
    timers: new FakeClock(Date.parse('2026-10-01T02:30:00Z')),
  })
  for (const accessory of cached) platform.configureMatterAccessory(accessory)
  homebridge.signalFinished()
  return { homebridge, log, platform }
}

test('a channel first seen at run time is not registered; at the next start it is, alone in its call and with no update', async () => {
  rmSync(pluginDirectory, { recursive: true, force: true })
  writeFileSync(configPath, JSON.stringify({ bridge: { name: 'Test Bridge' }, platforms: [BLOCK] }))
  const stub = await fixtureStub()
  try {
    const first = new Recorder()
    const run = launch(stub.url, first, true, [])
    await run.log.until((record) => record.message === 'energy: ok')
    run.homebridge.signalShutdown()
    assert.deepEqual(first.calls, [])
    assert.deepEqual(run.log.messages('info').filter((line) => line.includes('Matter')), ['grid_import: its Matter accessory is added at the next Homebridge restart'])
    const files = JSON.parse(readFileSync(join(pluginDirectory, 'pin.json'), 'utf8'))
    assert.equal(files.accountNumber, ACCOUNT_NUMBER)
    const second = new Recorder()
    const again = launch(stub.url, second, true, [])
    assert.deepEqual(second.calls, [{ method: 'register', uuids: [hap.uuid.generate(matterUuidSeed(ACCOUNT_NUMBER, 'grid_import'))] }])
    again.homebridge.signalShutdown()
    assert.deepEqual(run.log.messages('error').filter((line) => line.includes('Matter')), [])
  } finally {
    await stub.close()
  }
})

test('no call when Matter is not enabled', async () => {
  rmSync(pluginDirectory, { recursive: true, force: true })
  writeFileSync(configPath, JSON.stringify({ bridge: { name: 'Test Bridge' }, platforms: [BLOCK] }))
  const stub = await fixtureStub()
  try {
    const recorder = new Recorder()
    const run = launch(stub.url, recorder, false, [cachedAccessory('grid_import')])
    await run.log.until((record) => record.message === 'energy: ok')
    run.homebridge.signalShutdown()
    assert.deepEqual(recorder.calls, [])
    assert.deepEqual(
      run.log.messages('error').filter((line) => line.includes('Matter')),
      ['matterEnergy is true and Matter is not enabled on this bridge: no Matter accessory is registered'],
    )
  } finally {
    await stub.close()
  }
})

test('matterEnergy whose block in config.json has no _bridge.matter: a configuration error, IDLE, no request and only the cached endpoint nulled', async () => {
  rmSync(pluginDirectory, { recursive: true, force: true })
  writeFileSync(configPath, JSON.stringify({ bridge: { name: 'Test Bridge' }, platforms: [handed(BLOCK)] }))
  const stub = await startStub((_request, response) => {
    response.writeHead(500)
    response.end('no request is expected in this test')
  })
  try {
    const recorder = new Recorder()
    const cached = cachedAccessory('grid_import')
    const run = launch(stub.url, recorder, true, [cached])
    run.homebridge.signalShutdown()
    assert.equal(run.platform.idle, true)
    assert.deepEqual(stub.requests, [])
    assert.deepEqual(run.log.messages('error'), [
      `${configPath} platforms[0]: matterEnergy: true needs this block on a child bridge with Matter enabled, and the block has no "_bridge" object with a "matter" object in it`,
    ])
    assert.deepEqual(recorder.calls, [{ method: 'update', uuids: [cached.UUID], attributes: { cumulativeEnergyImported: null, periodicEnergyImported: null } }])
  } finally {
    await stub.close()
  }
})

test('a throw at run time puts the plugin into IDLE and every Matter endpoint to null', async () => {
  rmSync(pluginDirectory, { recursive: true, force: true })
  writeFileSync(configPath, JSON.stringify({ bridge: { name: 'Test Bridge' }, platforms: [BLOCK] }))
  const stub = await fixtureStub()
  try {
    const first = launch(stub.url, new Recorder(), true, [])
    await first.log.until((record) => record.message === 'energy: ok')
    first.homebridge.signalShutdown()
    const [stateFile] = readdirSync(pluginDirectory).filter((name) => name.startsWith('instance-') && name.endsWith('.json'))
    if (stateFile === undefined) throw new Error(`no instance state file in ${pluginDirectory} after the first run`)
    const recorder = new Recorder()
    const run = launch(stub.url, recorder, true, [])
    mkdirSync(join(pluginDirectory, `${stateFile}.tmp`))
    await run.log.until((record) => record.level === 'error' && record.message === 'signalsChanged')
    run.homebridge.signalShutdown()
    const uuid = hap.uuid.generate(matterUuidSeed(ACCOUNT_NUMBER, 'grid_import'))
    assert.equal(run.platform.idle, true)
    assert.deepEqual(recorder.calls, [
      { method: 'register', uuids: [uuid] },
      { method: 'update', uuids: [uuid], attributes: nullPayload('grid_import') },
    ])
  } finally {
    await stub.close()
  }
})
