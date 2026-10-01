import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Characteristic, PlatformAccessory, Service } from 'homebridge'
import { SIGNAL_SERVICES } from '../src/config.ts'
import type { AccountSignals, PriceSignals, PriceTier, Signals, TariffSignals } from '../src/core/types.ts'
import { booleanCharacteristic, booleanServiceType, booleanValue } from '../src/hap/booleanSignal.ts'
import { STATUS_READ_ONLY_CHARACTERISTIC, STATUS_SERVICE_COMMUNICATION_FAILURE } from '../src/hap/constants.ts'
import { faultCachedAccessory, valueCharacteristicUuids } from '../src/hap/fault.ts'
import { GroupAccessory, type GroupKind, type GroupOptions } from '../src/hap/groupAccessory.ts'
import type { ServiceKey } from '../src/hap/names.ts'
import { LIGHT_LEVEL_MAX, LIGHT_LEVEL_MIN } from '../src/hap/priceSensor.ts'
import { StatusAccessory } from '../src/hap/statusAccessory.ts'
import { TokenAccessory } from '../src/hap/tokenAccessory.ts'
import type { RuntimeLog } from '../src/runtime/requestGate.ts'
import { HomebridgeAPI, associate, changesOf, readStatus, restoreFromCache } from './helpers/homebridgeHarness.ts'

const api = new HomebridgeAPI()
const { hap } = api
const C = hap.Characteristic

const FAULTED = { status: STATUS_SERVICE_COMMUNICATION_FAILURE }

const ALL_ON: GroupOptions = { signalService: 'switch', wholesalePriceSensor: true, wholesalePriceLevelSensor: true }

interface Lines {
  log: RuntimeLog
  errors: string[]
}

function lines(): Lines {
  const errors: string[] = []
  const ignore = (): void => undefined
  return { errors, log: { debug: ignore, info: ignore, warn: ignore, error: (message) => errors.push(message) } }
}

function account(tokenExpiringSoon: boolean | null): AccountSignals {
  if (tokenExpiringSoon === null) {
    return {
      status: 'faulted',
      fault: { code: 'http_error', httpStatus: 503 },
      accountNumber: null,
      accountState: null,
      productName: null,
      region: null,
      timeZone: null,
      tokenExpiresAt: null,
      tokenScope: null,
      tokenExpiringSoon: null,
    }
  }
  return {
    status: 'ok',
    fault: null,
    accountNumber: '10001234',
    accountState: 'Active',
    productName: 'Flipped Saver',
    region: 'Ausgrid',
    timeZone: 'Australia/Sydney',
    tokenExpiresAt: '2026-10-20T00:00:00Z',
    tokenScope: 'read',
    tokenExpiringSoon,
  }
}

function tariff(peak: boolean | null, offPeak = false): TariffSignals {
  if (peak === null) {
    return { status: 'faulted', fault: { code: 'billing_unit_overlap' }, structure: null, spotLinked: null, peak: null, offPeak: null, period: null, nextChange: null, schedule: null }
  }
  return {
    status: 'ok',
    fault: null,
    structure: 'timeOfUse',
    spotLinked: false,
    peak,
    offPeak,
    period: {
      band: peak ? 'peak' : 'offPeak',
      name: peak ? 'Peak' : 'Off Peak',
      rateCentsPerKwh: 30,
      kwhLimit: null,
      rateAfterLimitCentsPerKwh: null,
      blocks: [],
      wholesaleLinked: false,
      wholesaleCapCentsPerKwh: null,
      start: '2026-10-01T07:00:00Z',
      end: '2026-10-01T11:00:00Z',
    },
    nextChange: '2026-10-01T11:00:00Z',
    schedule: [],
  }
}

function price(centsPerKwh: number | null, tier: PriceTier = 'Normal'): PriceSignals {
  if (centsPerKwh === null) {
    return { status: 'faulted', fault: { code: 'price_stale' }, centsPerKwh: null, intervalStart: null, tier: null, priceHigh: null, priceLow: null, negative: null, forecast: null }
  }
  return {
    status: 'ok',
    fault: null,
    centsPerKwh,
    intervalStart: '2026-10-01T02:25:00Z',
    tier,
    priceHigh: centsPerKwh > 30,
    priceLow: centsPerKwh < 5,
    negative: centsPerKwh < 0,
    forecast: { nextHour: null, ahead: null },
  }
}

function signals(parts: { account?: AccountSignals; tariff?: TariffSignals; price?: PriceSignals }): Signals {
  return {
    account: parts.account ?? account(false),
    tariff: parts.tariff ?? tariff(true),
    price: parts.price ?? price(8.4321),
    energy: { status: 'faulted', fault: { code: 'not_loaded' }, nmi: null, intervals: null, days: null, latestIntervalEnd: null },
    nextEvaluation: null,
  }
}

function accessory(name: string): PlatformAccessory {
  return new api.platformAccessory(name, hap.uuid.generate(`flipped:test:${name}`))
}

function service(target: PlatformAccessory, key: ServiceKey): Service {
  const found = target.services.find((candidate) => candidate.subtype === key)
  if (found === undefined) throw new Error(`${target.displayName}: no service ${key}`)
  return found
}

function valueOf(target: PlatformAccessory, key: ServiceKey): Characteristic {
  const found = service(target, key).characteristics.find((candidate) => valueCharacteristicUuids(hap).has(candidate.UUID))
  if (found === undefined) throw new Error(`${target.displayName}: ${key} has no value characteristic`)
  return found
}

function group(kind: GroupKind, options: GroupOptions = ALL_ON, target: PlatformAccessory = accessory(kind)): GroupAccessory {
  return new GroupAccessory(hap, target, kind, options, lines().log)
}

async function sensorStatus(target: Service): Promise<[unknown, unknown]> {
  return [await target.getCharacteristic(C.StatusFault).handleGetRequest(), await target.getCharacteristic(C.StatusActive).handleGetRequest()]
}

test('each signalService carries true, false and unknown on its own service and characteristic', async () => {
  for (const kind of SIGNAL_SERVICES) {
    const rates = group('tariff', { ...ALL_ON, signalService: kind })
    const type = booleanServiceType(hap, kind)
    const sensor = kind !== 'switch'
    for (const key of ['peak_rate', 'off_peak_rate'] as const) {
      assert.equal(service(rates.accessory, key).UUID, type.uuid, `${kind} ${key}`)
      assert.equal(valueOf(rates.accessory, key).UUID, booleanCharacteristic(hap, kind).UUID)
    }
    rates.publish(signals({ tariff: tariff(true, false) }))
    assert.deepEqual(await readStatus(valueOf(rates.accessory, 'peak_rate')), { value: booleanValue(hap, kind, true) })
    assert.deepEqual(await readStatus(valueOf(rates.accessory, 'off_peak_rate')), { value: booleanValue(hap, kind, false) })
    if (sensor) assert.deepEqual(await sensorStatus(service(rates.accessory, 'peak_rate')), [C.StatusFault.NO_FAULT, true])
    rates.publish(signals({ tariff: tariff(null) }))
    assert.deepEqual(await readStatus(valueOf(rates.accessory, 'peak_rate')), FAULTED)
    if (sensor) assert.deepEqual(await sensorStatus(service(rates.accessory, 'peak_rate')), [C.StatusFault.GENERAL_FAULT, false])
  }
})

test('a tariff fault leaves every Wholesale characteristic readable, and the reverse', async () => {
  const rates = group('tariff')
  const wholesale = group('wholesale')
  const readAll = async (target: PlatformAccessory): Promise<unknown[]> => {
    const values = valueCharacteristicUuids(hap)
    const results: unknown[] = []
    for (const candidate of target.services) {
      for (const characteristic of candidate.characteristics) if (values.has(characteristic.UUID)) results.push(await readStatus(characteristic))
    }
    return results
  }
  const faultedTariff = signals({ tariff: tariff(null) })
  rates.publish(faultedTariff)
  wholesale.publish(faultedTariff)
  assert.deepEqual(await readAll(rates.accessory), [FAULTED, FAULTED])
  assert.deepEqual(await readAll(wholesale.accessory), [{ value: false }, { value: false }, { value: false }, { value: 8.4321 }, { value: C.AirQuality.GOOD }])
  const faultedPrice = signals({ price: price(null) })
  rates.publish(faultedPrice)
  wholesale.publish(faultedPrice)
  assert.deepEqual(await readAll(rates.accessory), [{ value: true }, { value: false }])
  assert.deepEqual(await readAll(wholesale.accessory), [FAULTED, FAULTED, FAULTED, FAULTED, FAULTED])
})

test('an unknown value sets status -70402 and emits no change event', async () => {
  const rates = group('tariff')
  rates.publish(signals({ tariff: tariff(true) }))
  const on = valueOf(rates.accessory, 'peak_rate')
  const changes = changesOf(on)
  rates.publish(signals({ tariff: tariff(null) }))
  assert.deepEqual(changes, [])
  assert.deepEqual(await readStatus(on), FAULTED)
})

test('recovery emits a change event with reason event for an unchanged value', async () => {
  const rates = group('tariff')
  rates.publish(signals({ tariff: tariff(true) }))
  rates.publish(signals({ tariff: tariff(null) }))
  const on = valueOf(rates.accessory, 'peak_rate')
  const changes = changesOf(on)
  rates.publish(signals({ tariff: tariff(true) }))
  assert.deepEqual(
    changes.map(({ oldValue, newValue, reason }) => ({ oldValue, newValue, reason })),
    [{ oldValue: true, newValue: true, reason: 'event' }],
  )
  assert.deepEqual(await readStatus(on), { value: true })
})

test('a write is refused with -70404 and the value stays readable and unchanged, with no event', async () => {
  const rates = group('tariff')
  rates.publish(signals({ tariff: tariff(true) }))
  const on = valueOf(rates.accessory, 'peak_rate')
  const changes = changesOf(on)
  await assert.rejects(on.handleSetRequest(false), (status: unknown) => status === STATUS_READ_ONLY_CHARACTERISTIC)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(await readStatus(on), { value: true })
  assert.equal(on.value, true)
  assert.deepEqual(
    changes.filter((change) => change.reason === 'event'),
    [],
  )
  rates.publish(signals({ tariff: tariff(null) }))
  await assert.rejects(on.handleSetRequest(true), (status: unknown) => status === STATUS_READ_ONLY_CHARACTERISTIC)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(await readStatus(on), FAULTED)
})

test('the status sensors follow the group status and are never faulted', async () => {
  const status = new StatusAccessory(hap, accessory('status'))
  const read = async (): Promise<unknown[]> => [
    await readStatus(valueOf(status.accessory, 'tariff_unavailable')),
    await readStatus(valueOf(status.accessory, 'wholesale_unavailable')),
  ]
  const detected = { value: C.OccupancyDetected.OCCUPANCY_DETECTED }
  const clear = { value: C.OccupancyDetected.OCCUPANCY_NOT_DETECTED }
  assert.deepEqual(await read(), [detected, detected])
  status.publish(signals({ tariff: tariff(null) }))
  assert.deepEqual(await read(), [detected, clear])
  status.publish(signals({ price: price(null) }))
  assert.deepEqual(await read(), [clear, detected])
  status.publish(signals({}))
  assert.deepEqual(await read(), [clear, clear])
  assert.deepEqual(await sensorStatus(service(status.accessory, 'tariff_unavailable')), [C.StatusFault.NO_FAULT, true])
})

test('the token sensor shows expiry and faults when unknown', async () => {
  const token = new TokenAccessory(hap, accessory('token'))
  const occupancy = valueOf(token.accessory, 'token_expiring')
  token.publish(signals({ account: account(true) }))
  assert.deepEqual(await readStatus(occupancy), { value: C.OccupancyDetected.OCCUPANCY_DETECTED })
  token.publish(signals({ account: account(false) }))
  assert.deepEqual(await readStatus(occupancy), { value: C.OccupancyDetected.OCCUPANCY_NOT_DETECTED })
  token.publish(signals({ account: account(null) }))
  assert.deepEqual(await readStatus(occupancy), FAULTED)
  assert.deepEqual(await sensorStatus(service(token.accessory, 'token_expiring')), [C.StatusFault.GENERAL_FAULT, false])
})

test('the light sensor shows -3.2 and 0 at its minimum with Negative next to it, and 8.4321 as is', async () => {
  const props = new C.CurrentAmbientLightLevel().props
  assert.deepEqual([props.minValue, props.maxValue], [LIGHT_LEVEL_MIN, LIGHT_LEVEL_MAX])
  const wholesale = group('wholesale')
  const read = async (): Promise<unknown[]> => [
    await readStatus(valueOf(wholesale.accessory, 'wholesale_price')),
    await readStatus(valueOf(wholesale.accessory, 'wholesale_price_negative')),
  ]
  wholesale.publish(signals({ price: price(-3.2) }))
  assert.deepEqual(await read(), [{ value: 0.0001 }, { value: true }])
  wholesale.publish(signals({ price: price(0) }))
  assert.deepEqual(await read(), [{ value: 0.0001 }, { value: false }])
  wholesale.publish(signals({ price: price(8.4321) }))
  assert.deepEqual(await read(), [{ value: 8.4321 }, { value: false }])
})

test('a price above the light sensor maximum is a fault with one error line, never clamped', async () => {
  const recorded = lines()
  const wholesale = new GroupAccessory(hap, accessory('wholesale'), 'wholesale', ALL_ON, recorded.log)
  wholesale.publish(signals({ price: price(165000) }))
  wholesale.publish(signals({ price: price(165000) }))
  assert.deepEqual(await readStatus(valueOf(wholesale.accessory, 'wholesale_price')), FAULTED)
  assert.deepEqual(recorded.errors, ['wholesale_price: 165000 c/kWh is above 100000, the maximum of CurrentAmbientLightLevel'])
})

test('the price level sensor maps the four tiers and faults when unknown', async () => {
  const wholesale = group('wholesale')
  const level = valueOf(wholesale.accessory, 'wholesale_price_level')
  const expected: Readonly<Record<PriceTier, number>> = { UnusuallyLow: 1, Normal: 2, Elevated: 4, Spike: 5 }
  for (const [tier, quality] of Object.entries(expected)) {
    const known = (['UnusuallyLow', 'Normal', 'Elevated', 'Spike'] as const).find((candidate) => candidate === tier)
    if (known === undefined) throw new Error(`tier ${tier}`)
    wholesale.publish(signals({ price: price(10, known) }))
    assert.deepEqual(await readStatus(level), { value: quality }, tier)
  }
  wholesale.publish(signals({ price: price(null) }))
  assert.deepEqual(await readStatus(level), FAULTED)
})

test('the services follow the options: off removes them, a changed signalService replaces them', () => {
  const wholesale = group('wholesale')
  associate(api, [wholesale.accessory])
  const restored = restoreFromCache(api, wholesale.accessory)
  const bound = group('wholesale', { signalService: 'contactSensor', wholesalePriceSensor: false, wholesalePriceLevelSensor: false }, restored)
  const keys = bound.accessory.services.filter((candidate) => candidate.UUID !== hap.Service.AccessoryInformation.UUID).map((candidate) => [candidate.subtype, candidate.UUID])
  assert.deepEqual(keys, [
    ['wholesale_price_high', hap.Service.ContactSensor.UUID],
    ['wholesale_price_low', hap.Service.ContactSensor.UUID],
  ])
})

test('ConfiguredName is set on a new service and left alone on a restored one', async () => {
  const rates = group('tariff')
  const configured = service(rates.accessory, 'peak_rate').getCharacteristic(C.ConfiguredName)
  assert.equal(await configured.handleGetRequest(), 'Peak Rate')
  await configured.handleSetRequest('Hot Water Window')
  associate(api, [rates.accessory])
  const restored = restoreFromCache(api, rates.accessory)
  const bound = group('tariff', ALL_ON, restored)
  assert.equal(await service(bound.accessory, 'peak_rate').getCharacteristic(C.ConfiguredName).handleGetRequest(), 'Hot Water Window')
  assert.equal(await service(bound.accessory, 'off_peak_rate').getCharacteristic(C.ConfiguredName).handleGetRequest(), 'Off-Peak Rate')
})

test('a cached accessory reads its cached value until it is faulted, then -70402; a cached status accessory reads 1', async () => {
  const rates = group('tariff')
  rates.accessory.context = { schema: 1, instanceKey: '10001234', kind: 'tariff' }
  rates.publish(signals({ tariff: tariff(true) }))
  const status = new StatusAccessory(hap, accessory('status'))
  status.accessory.context = { schema: 1, instanceKey: '10001234', kind: 'status' }
  status.publish(signals({}))
  associate(api, [rates.accessory, status.accessory])
  const cachedRates = restoreFromCache(api, rates.accessory)
  const cachedStatus = restoreFromCache(api, status.accessory)
  assert.deepEqual(await readStatus(valueOf(cachedRates, 'peak_rate')), { value: true })
  assert.deepEqual(await readStatus(valueOf(cachedStatus, 'tariff_unavailable')), { value: 0 })
  faultCachedAccessory(hap, cachedRates)
  faultCachedAccessory(hap, cachedStatus)
  assert.deepEqual(await readStatus(valueOf(cachedRates, 'peak_rate')), FAULTED)
  assert.deepEqual(await readStatus(valueOf(cachedStatus, 'tariff_unavailable')), { value: 1 })
  assert.deepEqual(await readStatus(valueOf(cachedStatus, 'wholesale_unavailable')), { value: 1 })
  await assert.rejects(valueOf(cachedRates, 'peak_rate').handleSetRequest(false), (code: unknown) => code === STATUS_READ_ONLY_CHARACTERISTIC)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(await readStatus(valueOf(cachedRates, 'peak_rate')), FAULTED)
})
