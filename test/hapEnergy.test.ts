import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Characteristic, PlatformAccessory, Service } from 'homebridge'
import { ApiClient } from '../src/api/client.ts'
import { HTTP_TIMEOUT_S, WAIT_HTTP_TIMEOUT_S } from '../src/core/constants.ts'
import { EVE_UUIDS } from '../src/eve/characteristics.ts'
import { EveEnergyAccessory, roundTotal } from '../src/eve/energyAccessory.ts'
import { readChannelState } from '../src/energy/ledger.ts'
import { EveHistory, emptyHistoryState } from '../src/eve/history.ts'
import { STATUS_READ_ONLY_CHARACTERISTIC } from '../src/hap/constants.ts'
import { faultCachedAccessory } from '../src/hap/fault.ts'
import { Platform } from '../src/platform.ts'
import { instanceHash } from '../src/runtime/stateStore.ts'
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.ts'
import { FakeClock } from './helpers/fakeClock.ts'
import { HomebridgeAPI, LogRecorder, associate, emitterOf, readStatus, restoreFromCache, storagePath } from './helpers/homebridgeHarness.ts'
import { loadSequence } from './helpers/sequenceReplay.ts'
import { startStub } from './helpers/stubServer.ts'

const INSTANCE_KEY = '36200000000001'
const FAULTED = { status: -70402 }
const api = new HomebridgeAPI()
const { hap } = api
const ignore = (): void => undefined
const quiet = { debug: ignore, info: ignore, warn: ignore, error: ignore }

interface Transfer {
  request: string
  reads: string[]
}

const threeEntries: { entries: { time: number; deciwatts: number }[]; historyStatus: string; historyEntries: Transfer[] } = JSON.parse(
  readFileSync(new URL('./fixtures/eve-history/three-entries.json', import.meta.url), 'utf8'),
)

function created(history: EveHistory): { accessory: PlatformAccessory; energy: EveEnergyAccessory } {
  const accessory = new api.platformAccessory('Flipped Energy Grid Import', hap.uuid.generate(`flipped:${INSTANCE_KEY}:grid_import`))
  accessory.context = { schema: 1, instanceKey: INSTANCE_KEY, kind: 'energy', key: 'grid_import' }
  return { accessory, energy: new EveEnergyAccessory(hap, accessory, 'grid_import', INSTANCE_KEY, history, quiet) }
}

function serviceOf(accessory: PlatformAccessory, uuid: string): Service {
  const service = accessory.services.find((candidate) => candidate.UUID === uuid && candidate.subtype === 'grid_import')
  if (service === undefined) throw new Error(`no service ${uuid}`)
  return service
}

function characteristicOf(service: Service, uuid: string): Characteristic {
  const found = service.characteristics.find((characteristic) => characteristic.UUID === uuid)
  if (found === undefined) throw new Error(`no characteristic ${uuid} on ${service.UUID}`)
  return found
}

const USAGE_ROWS = [
  { time: '2026-09-29T11:00:00', value: 0.412, usageType: 'Export', controlledLoad: false, nmi: '4102000000', cost: 0.1 },
  { time: '2026-09-29T11:00:00', value: 0.1, usageType: 'Import', controlledLoad: false, nmi: '4102000000', cost: -0.01 },
  { time: '2026-09-29T11:30:00', value: 0.5, usageType: 'Export', controlledLoad: false, nmi: '4102000000', cost: 0.12 },
]

const base64 = (hex: string): string => Buffer.from(hex, 'hex').toString('base64')

test('an energy accessory has the outlet with Total Consumption and the Eve history service', async () => {
  const { accessory } = created(new EveHistory(emptyHistoryState(4032)))
  const { Characteristic: C, Service: S } = hap
  const information = accessory.getService(S.AccessoryInformation)
  if (information === undefined) throw new Error('no AccessoryInformation')
  assert.equal(information.getCharacteristic(C.Model).value, 'Energy History')
  assert.equal(information.getCharacteristic(C.SerialNumber).value, `FE-${instanceHash(INSTANCE_KEY)}-GI`)
  assert.deepEqual(
    accessory.services.map((service) => [service.UUID, service.subtype ?? null]),
    [
      [S.AccessoryInformation.UUID, null],
      [S.Outlet.UUID, 'grid_import'],
      [EVE_UUIDS.historyService, 'grid_import'],
    ],
  )
  const outlet = serviceOf(accessory, S.Outlet.UUID)
  assert.equal(outlet.getCharacteristic(C.ConfiguredName).value, 'Grid Import')
  assert.equal(outlet.getCharacteristic(C.OutletInUse).value, true)
  const total = characteristicOf(outlet, EVE_UUIDS.totalConsumption)
  assert.deepEqual(
    { format: total.props.format, unit: total.props.unit, minValue: total.props.minValue, maxValue: total.props.maxValue, minStep: total.props.minStep, perms: total.props.perms },
    { format: 'float', unit: 'kWh', minValue: 0, maxValue: 1000000, minStep: 0.01, perms: ['pr', 'ev'] },
  )
  assert.equal(
    outlet.characteristics.some((characteristic) => characteristic.UUID === 'E863F10D-079E-48FF-8F27-9C2605A29F52'),
    false,
  )
  const history = serviceOf(accessory, EVE_UUIDS.historyService)
  assert.deepEqual(
    history.characteristics.map((characteristic) => [characteristic.UUID, characteristic.props.format, characteristic.props.perms]),
    [
      [hap.Characteristic.Name.UUID, 'string', ['pr']],
      [EVE_UUIDS.historyStatus, 'data', ['pr', 'ev', 'hd']],
      [EVE_UUIDS.historyEntries, 'data', ['pr', 'ev', 'hd']],
      [EVE_UUIDS.historyRequest, 'data', ['pw', 'hd']],
      [EVE_UUIDS.setTime, 'data', ['pw', 'hd']],
    ],
  )
  assert.deepEqual(await readStatus(outlet.getCharacteristic(C.On)), FAULTED)
  assert.deepEqual(await readStatus(total), FAULTED)
})

test('fault state: On and Total Consumption follow the energy group, history stays readable, a write to On is refused', async () => {
  const history = new EveHistory(emptyHistoryState(4032))
  for (const entry of threeEntries.entries) history.add(entry.time, entry.deciwatts)
  const { accessory, energy } = created(history)
  const outlet = serviceOf(accessory, hap.Service.Outlet.UUID)
  const on = outlet.getCharacteristic(hap.Characteristic.On)
  const total = characteristicOf(outlet, EVE_UUIDS.totalConsumption)
  const historyService = serviceOf(accessory, EVE_UUIDS.historyService)
  assert.equal(characteristicOf(historyService, EVE_UUIDS.historyStatus).value, base64(threeEntries.historyStatus))
  energy.publish(12.3456)
  assert.deepEqual(await readStatus(on), { value: true })
  assert.deepEqual(await readStatus(total), { value: 12.35 })
  energy.publish(null)
  assert.deepEqual(await readStatus(on), FAULTED)
  assert.deepEqual(await readStatus(total), FAULTED)
  const transfer = threeEntries.historyEntries[0]
  if (transfer === undefined) throw new Error('fixture has no transfer')
  await characteristicOf(historyService, EVE_UUIDS.historyRequest).handleSetRequest(base64(transfer.request))
  const reads: unknown[] = []
  for (const _read of transfer.reads) reads.push(await characteristicOf(historyService, EVE_UUIDS.historyEntries).handleGetRequest())
  assert.deepEqual(reads, transfer.reads.map(base64))
  energy.publish(1)
  await assert.rejects(on.handleSetRequest(false), (status: unknown) => status === STATUS_READ_ONLY_CHARACTERISTIC)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(await readStatus(on), { value: true })
})

test('a cached energy accessory is faulted before binding and keeps one set of services when bound again', async () => {
  const { accessory, energy } = created(new EveHistory(emptyHistoryState(4032)))
  energy.publish(5)
  associate(api, [accessory])
  const restored = restoreFromCache(api, accessory)
  faultCachedAccessory(hap, restored)
  const outlet = serviceOf(restored, hap.Service.Outlet.UUID)
  assert.deepEqual(await readStatus(characteristicOf(outlet, EVE_UUIDS.totalConsumption)), FAULTED)
  assert.deepEqual(await readStatus(outlet.getCharacteristic(hap.Characteristic.On)), FAULTED)
  const bound = new EveEnergyAccessory(hap, restored, 'grid_import', INSTANCE_KEY, new EveHistory(emptyHistoryState(4032)), quiet)
  bound.publish(5)
  assert.equal(restored.services.length, 3)
  assert.equal(serviceOf(restored, EVE_UUIDS.historyService).characteristics.length, 5)
  assert.deepEqual(await readStatus(characteristicOf(outlet, EVE_UUIDS.totalConsumption)), { value: 5 })
})

async function runPlatform(failUsage: boolean, halfHourly: unknown[] | null, until: (record: { level: string; message: string }) => boolean): Promise<{ registered: PlatformAccessory[]; platform: Platform<number> }> {
  const storage = storagePath()
  const configPath = join(storage, 'config.json')
  rmSync(join(storage, PLUGIN_NAME), { recursive: true, force: true })
  const config = { platform: PLATFORM_NAME, name: 'Flipped Energy', token: 'fdk_SEQUENCEFIXTURE000000000000000000wXyZ' }
  writeFileSync(configPath, JSON.stringify({ bridge: { name: 'Test Bridge' }, platforms: [config] }))
  const sequence = loadSequence('first-run-account-pinning')
  const stub = await startStub((request, response) => {
    const path = new URL(request.url ?? '', 'http://stub').pathname
    if (halfHourly !== null && path === '/api/Usage/usage/projectreads/halfhourly') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(halfHourly))
      return
    }
    if (failUsage && path.startsWith('/api/Usage/')) {
      response.writeHead(503)
      response.end('usage store unavailable')
      return
    }
    const answer = sequence.responses.find((candidate) => candidate.path === path && 'status' in candidate.answer && candidate.answer.status === 200)?.answer
    if (answer === undefined || !('status' in answer)) {
      response.writeHead(500)
      response.end(`no 200 answer for ${path}`)
      return
    }
    response.writeHead(answer.status, answer.headers)
    response.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body))
  })
  const homebridge = new HomebridgeAPI()
  const registered: PlatformAccessory[] = []
  emitterOf(homebridge).on('registerPlatformAccessories', (accessories: PlatformAccessory[]) => registered.push(...accessories))
  const log = new LogRecorder()
  const platform = new Platform(log.logging, config, homebridge, {
    createTransport: (token) => new ApiClient({ baseUrl: stub.url, token, httpTimeoutS: HTTP_TIMEOUT_S, waitHttpTimeoutS: WAIT_HTTP_TIMEOUT_S }),
    timers: new FakeClock(Date.parse('2026-10-01T02:30:00Z')),
  })
  try {
    homebridge.signalFinished()
    await log.until(until)
    return { registered, platform }
  } finally {
    homebridge.signalShutdown()
    await stub.close()
  }
}

test('no energy accessory exists before the energy group has been ok', async () => {
  const { registered, platform } = await runPlatform(true, null, (record) => record.level === 'error' && record.message.startsWith('energy: '))
  assert.deepEqual(
    registered.map((accessory) => accessory.displayName),
    ['Flipped Energy Rates', 'Flipped Energy Wholesale', 'Flipped Energy Status'],
  )
  assert.equal(platform.accessories.length, 3)
  assert.equal(existsSync(join(storagePath(), PLUGIN_NAME, `instance-${instanceHash(INSTANCE_KEY)}.json`)), false)
})

test('the first usage sync with the energy group ok runs the ledger, writes the Eve history and the state file, and publishes Total Consumption', async () => {
  const { registered } = await runPlatform(false, USAGE_ROWS, (record) => record.message === 'energy: ok')
  const grid = registered.find((accessory) => accessory.displayName === 'Flipped Energy Grid Import')
  if (grid === undefined) throw new Error('no Grid Import accessory')
  const file = JSON.parse(readFileSync(join(storagePath(), PLUGIN_NAME, `instance-${instanceHash(INSTANCE_KEY)}.json`), 'utf8'))
  const channel = readChannelState(file.channels.grid_import, 'grid_import')
  assert.equal(channel.totalKwh, 0.412 + 0.5)
  assert.equal(channel.through, '2026-09-29T02:00:00Z')
  assert.equal(channel.history.lastEntry, 7)
  assert.deepEqual(registered.map((accessory) => accessory.displayName).slice(3), ['Flipped Energy Grid Import', 'Flipped Energy Solar Export'])
  assert.equal(file.channels.controlled_load, undefined)
  const outlet = serviceOf(grid, hap.Service.Outlet.UUID)
  assert.deepEqual(await readStatus(outlet.getCharacteristic(hap.Characteristic.On)), { value: true })
  assert.deepEqual(await readStatus(characteristicOf(outlet, EVE_UUIDS.totalConsumption)), { value: roundTotal(channel.totalKwh) })
  const status = new EveHistory(channel.history).status()
  if (status === null) throw new Error('no history status')
  assert.equal(characteristicOf(serviceOf(grid, EVE_UUIDS.historyService), EVE_UUIDS.historyStatus).value, base64(status))
})
