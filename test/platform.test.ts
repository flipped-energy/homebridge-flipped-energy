import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Characteristic, PlatformAccessory } from 'homebridge'
import { ApiClient } from '../src/api/client.ts'
import { HTTP_TIMEOUT_S, WAIT_HTTP_TIMEOUT_S } from '../src/core/constants.ts'
import type { Signals } from '../src/core/types.ts'
import { valueCharacteristicUuids } from '../src/hap/fault.ts'
import { GroupAccessory } from '../src/hap/groupAccessory.ts'
import { type PlatformEnvironment, Platform } from '../src/platform.ts'
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.ts'
import { FakeClock } from './helpers/fakeClock.ts'
import { HomebridgeAPI, LogRecorder, associate, emitterOf, readStatus, restoreFromCache, storagePath } from './helpers/homebridgeHarness.ts'
import { loadSequence } from './helpers/sequenceReplay.ts'
import { type StubServer, startStub } from './helpers/stubServer.ts'

type Block = { platform: string } & Record<string, unknown>

const TOKEN = 'fdk_SEQUENCEFIXTURE000000000000000000wXyZ'
const ACCOUNT_NUMBER = '36200000000001'
const START = Date.parse('2026-10-01T02:30:00Z')
const FAULTED = { status: -70402 }

const storage = storagePath()
const configPath = join(storage, 'config.json')
const pluginDirectory = join(storage, PLUGIN_NAME)
const { hap } = new HomebridgeAPI()

function block(fields: Record<string, unknown>): Block {
  return { platform: PLATFORM_NAME, name: 'Flipped Energy', ...fields }
}

function prepare(platforms: Block[] | null): void {
  rmSync(pluginDirectory, { recursive: true, force: true })
  rmSync(configPath, { force: true })
  if (platforms !== null) writeFileSync(configPath, JSON.stringify({ bridge: { name: 'Test Bridge' }, platforms }))
}

interface Launched {
  api: HomebridgeAPI
  log: LogRecorder
  transports: string[]
  platform: Platform<number>
}

function launch(config: Block, baseUrl: string, cached: PlatformAccessory[]): Launched {
  const api = new HomebridgeAPI()
  const log = new LogRecorder()
  const transports: string[] = []
  const environment: PlatformEnvironment<number> = {
    createTransport: (token) => {
      transports.push(token)
      return new ApiClient({ baseUrl, token, httpTimeoutS: HTTP_TIMEOUT_S, waitHttpTimeoutS: WAIT_HTTP_TIMEOUT_S })
    },
    timers: new FakeClock(START),
  }
  const platform = new Platform(log.logging, config, api, environment)
  for (const accessory of cached) platform.configureAccessory(accessory)
  assert.doesNotThrow(() => api.signalFinished())
  return { api, log, transports, platform }
}

const UNKNOWN_ACCOUNT: Signals['account'] = {
  status: 'faulted',
  fault: { code: 'not_loaded' },
  accountNumber: null,
  accountState: null,
  productName: null,
  region: null,
  timeZone: null,
  tokenExpiresAt: null,
  tokenScope: null,
  tokenExpiringSoon: null,
}

function cachedRates(instanceKey: string): PlatformAccessory {
  const api = new HomebridgeAPI()
  const accessory = new api.platformAccessory('Flipped Energy Rates', api.hap.uuid.generate(`flipped:${instanceKey}:tariff`))
  accessory.context = { schema: 1, instanceKey, kind: 'tariff' }
  const ignore = (): void => undefined
  const rates = new GroupAccessory(api.hap, accessory, 'tariff', { signalService: 'switch', wholesalePriceSensor: true, wholesalePriceLevelSensor: false }, { debug: ignore, info: ignore, warn: ignore, error: ignore })
  rates.publish({
    account: UNKNOWN_ACCOUNT,
    tariff: {
      status: 'ok',
      fault: null,
      structure: 'flat',
      spotLinked: false,
      peak: true,
      offPeak: false,
      period: { band: 'anytime', name: 'Anytime', rateCentsPerKwh: 30, kwhLimit: null, rateAfterLimitCentsPerKwh: null, blocks: [], wholesaleLinked: false, wholesaleCapCentsPerKwh: null, start: null, end: null },
      nextChange: null,
      schedule: [],
    },
    price: { status: 'faulted', fault: { code: 'not_loaded' }, centsPerKwh: null, intervalStart: null, tier: null, priceHigh: null, priceLow: null, negative: null, forecast: null },
    energy: { status: 'faulted', fault: { code: 'not_loaded' }, nmi: null, intervals: null, days: null, latestIntervalEnd: null },
    nextEvaluation: null,
  })
  associate(api, [accessory])
  return restoreFromCache(api, accessory)
}

function valueOf(accessory: PlatformAccessory, key: string): Characteristic {
  const service = accessory.services.find((candidate) => candidate.subtype === key)
  if (service === undefined) throw new Error(`${accessory.displayName}: no service ${key}`)
  const found = service.characteristics.find((candidate) => valueCharacteristicUuids(hap).has(candidate.UUID))
  if (found === undefined) throw new Error(`${accessory.displayName}: ${key} has no value characteristic`)
  return found
}

function refusingStub(): Promise<StubServer> {
  return startStub((_request, response) => {
    response.writeHead(500)
    response.end('no request is expected in this test')
  })
}

function fixtureStub(): Promise<StubServer> {
  const sequence = loadSequence('first-run-account-pinning')
  return startStub((request, response) => {
    const path = new URL(request.url ?? '', 'http://stub').pathname
    const answer = sequence.responses.find((candidate) => candidate.path === path && 'status' in candidate.answer && candidate.answer.status === 200)?.answer
    if (answer === undefined || !('status' in answer)) {
      response.writeHead(500)
      response.end(`no 200 answer for ${path} in first-run-account-pinning`)
      return
    }
    response.writeHead(answer.status, answer.headers)
    response.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body))
  })
}

test('accessories appear after E1 and carry the signals', async () => {
  const config = block({ token: TOKEN })
  prepare([config])
  const stub = await fixtureStub()
  const api = new HomebridgeAPI()
  const registered: PlatformAccessory[] = []
  emitterOf(api).on('registerPlatformAccessories', (accessories: PlatformAccessory[]) => registered.push(...accessories))
  const log = new LogRecorder()
  const platform = new Platform(log.logging, config, api, {
    createTransport: (token) => new ApiClient({ baseUrl: stub.url, token, httpTimeoutS: HTTP_TIMEOUT_S, waitHttpTimeoutS: WAIT_HTTP_TIMEOUT_S }),
    timers: new FakeClock(START),
  })
  try {
    api.signalFinished()
    await log.until((record) => record.message === 'energy: ok')
    assert.equal(stub.requests[0]?.url, '/api/MyAccount/GetAccountData')
    assert.deepEqual(
      registered.map((accessory) => accessory.displayName),
      ['Flipped Energy Rates', 'Flipped Energy Wholesale', 'Flipped Energy Status', 'Flipped Energy Grid Import'],
    )
    assert.deepEqual(platform.accessories, registered)
    const [rates, wholesale, status] = registered
    if (rates === undefined || wholesale === undefined || status === undefined) throw new Error('three accessories expected')
    assert.deepEqual(await readStatus(valueOf(rates, 'peak_rate')), { value: false })
    assert.deepEqual(await readStatus(valueOf(rates, 'off_peak_rate')), { value: false })
    assert.equal(typeof (await valueOf(wholesale, 'wholesale_price_high').handleGetRequest()), 'boolean')
    assert.equal(typeof (await valueOf(wholesale, 'wholesale_price').handleGetRequest()), 'number')
    assert.deepEqual(await readStatus(valueOf(status, 'tariff_unavailable')), { value: 0 })
    assert.deepEqual(await readStatus(valueOf(status, 'wholesale_unavailable')), { value: 0 })
    assert.deepEqual(JSON.parse(readFileSync(join(pluginDirectory, 'pin.json'), 'utf8')), { version: 1, accountNumber: ACCOUNT_NUMBER })
    assert.deepEqual(log.messages('error'), [])
  } finally {
    api.signalShutdown()
    await stub.close()
  }
})

test('a cached accessory plus an invalid config: a read of On throws -70402 and no request is sent', async () => {
  const config = block({ token: 'not-a-token' })
  prepare([config])
  const stub = await refusingStub()
  try {
    const cached = cachedRates(ACCOUNT_NUMBER)
    assert.deepEqual(await readStatus(valueOf(cached, 'peak_rate')), { value: true })
    const { log, transports, platform } = launch(config, stub.url, [cached])
    assert.deepEqual(await readStatus(valueOf(cached, 'peak_rate')), FAULTED)
    assert.equal(platform.idle, true)
    assert.deepEqual(transports, [])
    assert.deepEqual(stub.requests, [])
    assert.deepEqual(log.messages('error'), ['token: expected a string starting with "fdk_", got a string of 11 characters that does not'])
  } finally {
    await stub.close()
  }
})

test('a cached accessory plus an unparsable state file: a read of On throws -70402 and no request is sent', async () => {
  const config = block({ token: TOKEN })
  prepare([config])
  mkdirSync(pluginDirectory, { recursive: true })
  writeFileSync(join(pluginDirectory, 'pin.json'), '{"version":1,')
  const stub = await refusingStub()
  try {
    const cached = cachedRates(ACCOUNT_NUMBER)
    const { log, transports, platform } = launch(config, stub.url, [cached])
    assert.deepEqual(await readStatus(valueOf(cached, 'peak_rate')), FAULTED)
    assert.equal(platform.idle, true)
    assert.deepEqual(transports, [])
    assert.deepEqual(stub.requests, [])
    const [step, error] = log.messages('error')
    assert.equal(step, 'didFinishLaunching')
    assert.match(error ?? '', /StateFileError: \S+pin\.json: /)
    assert.equal(readFileSync(join(pluginDirectory, 'pin.json'), 'utf8'), '{"version":1,')
  } finally {
    await stub.close()
  }
})

test('a throwing step is logged with its stack and not rethrown', async () => {
  prepare(null)
  const stub = await refusingStub()
  try {
    const cached = cachedRates(ACCOUNT_NUMBER)
    const { log, transports, platform } = launch(block({ token: TOKEN }), stub.url, [cached])
    assert.equal(platform.idle, true)
    assert.deepEqual(await readStatus(valueOf(cached, 'peak_rate')), FAULTED)
    assert.deepEqual(transports, [])
    assert.deepEqual(stub.requests, [])
    const [step, error] = log.messages('error')
    assert.equal(step, 'didFinishLaunching')
    assert.match(error ?? '', /ENOENT[\s\S]*config\.json[\s\S]*\n\s+at /)
  } finally {
    await stub.close()
  }
})
