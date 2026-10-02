import type { HAP, PlatformAccessory, Service } from 'homebridge'
import type { Config } from '../config.ts'
import type { Signals } from '../core/types.ts'
import type { RuntimeLog } from '../runtime/requestGate.ts'
import { CHANNEL_NAMES, type ChannelName } from '../runtime/stateStore.ts'
import { VERSION } from '../version.ts'
import { BooleanSignal, booleanServiceType } from './booleanSignal.ts'
import { type AccessoryIdentity, type AccessoryKind, ACCESSORY_KINDS, MANUFACTURER, type SignalKey, SERVICE_NAMES, type ServiceKey, serialNumber } from './names.ts'
import { PriceLevelSensor, airQualitySensorType } from './priceLevelSensor.ts'
import { PriceSensor, lightSensorType } from './priceSensor.ts'

export const CONTEXT_SCHEMA = 1

export interface ServiceType {
  uuid: string
  create(name: string, key: string): Service
}

export interface AccessoryContext {
  schema: typeof CONTEXT_SCHEMA
  instanceKey: string
  kind: AccessoryKind
  key?: ChannelName
}

export interface Presenter {
  readonly accessory: PlatformAccessory
  publish(signals: Signals): void
}

export type GroupOptions = Pick<Config, 'signalService' | 'wholesalePriceSensor' | 'wholesalePriceLevelSensor'>

export type GroupKind = 'tariff' | 'wholesale'

export function readContext(accessory: PlatformAccessory): AccessoryContext | null {
  const schema: unknown = accessory.context.schema
  const instanceKey: unknown = accessory.context.instanceKey
  const kind: unknown = accessory.context.kind
  const key: unknown = accessory.context.key
  if (schema !== CONTEXT_SCHEMA || typeof instanceKey !== 'string') return null
  const knownKind = ACCESSORY_KINDS.find((candidate) => candidate === kind)
  if (knownKind === undefined) return null
  if (key === undefined) return { schema: CONTEXT_SCHEMA, instanceKey, kind: knownKind }
  const channel = CHANNEL_NAMES.find((candidate) => candidate === key)
  return channel === undefined ? null : { schema: CONTEXT_SCHEMA, instanceKey, kind: knownKind, key: channel }
}

export function ensureService(hap: HAP, accessory: PlatformAccessory, type: ServiceType, key: ServiceKey): Service {
  const existing = accessory.services.find((service) => service.subtype === key)
  if (existing !== undefined && existing.UUID === type.uuid) return existing
  if (existing !== undefined) accessory.removeService(existing)
  const name = SERVICE_NAMES[key]
  const service = accessory.addService(type.create(name, key))
  const { ConfiguredName } = hap.Characteristic
  if (!service.optionalCharacteristics.some((characteristic) => characteristic.UUID === ConfiguredName.UUID)) service.addOptionalCharacteristic(ConfiguredName)
  service.getCharacteristic(ConfiguredName).updateValue(name)
  return service
}

export function removeServicesExcept(hap: HAP, accessory: PlatformAccessory, keys: ReadonlySet<string>): void {
  const information = hap.Service.AccessoryInformation.UUID
  const unwanted = accessory.services.filter((service) => service.UUID !== information && (service.subtype === undefined || !keys.has(service.subtype)))
  for (const service of unwanted) accessory.removeService(service)
}

export function setInformation(hap: HAP, accessory: PlatformAccessory, identity: AccessoryIdentity, instanceKey: string): void {
  const { Characteristic: C, Service: S } = hap
  const information = accessory.getService(S.AccessoryInformation)
  if (information === undefined) throw new Error(`${accessory.displayName}: no AccessoryInformation service`)
  information.getCharacteristic(C.Manufacturer).updateValue(MANUFACTURER)
  information.getCharacteristic(C.Model).updateValue(identity.model)
  information.getCharacteristic(C.SerialNumber).updateValue(serialNumber(instanceKey, identity))
  information.getCharacteristic(C.FirmwareRevision).updateValue(VERSION)
}

interface Carrier {
  publish(signals: Signals): void
}

interface ServiceSpec {
  key: SignalKey
  present(options: GroupOptions): boolean
  type(hap: HAP, options: GroupOptions): ServiceType
  bind(hap: HAP, service: Service, options: GroupOptions, log: RuntimeLog): Carrier
}

function booleanSpec(key: SignalKey, read: (signals: Signals) => boolean | null, present: (options: GroupOptions) => boolean): ServiceSpec {
  return {
    key,
    present,
    type: (hap, options) => booleanServiceType(hap, options.signalService),
    bind: (hap, service, options) => {
      const signal = new BooleanSignal(hap, service, options.signalService)
      return { publish: (signals) => signal.publish(read(signals)) }
    },
  }
}

const always = (): boolean => true

export const GROUP_SERVICES: Readonly<Record<GroupKind, readonly ServiceSpec[]>> = {
  tariff: [
    booleanSpec('peak_rate', (s) => s.tariff.peak, always),
    booleanSpec('off_peak_rate', (s) => s.tariff.offPeak, always),
    booleanSpec('shoulder_rate', (s) => (s.tariff.period === null ? null : s.tariff.period.band === 'shoulder'), always),
  ],
  wholesale: [
    booleanSpec('wholesale_price_high', (s) => s.price.priceHigh, always),
    booleanSpec('wholesale_price_low', (s) => s.price.priceLow, always),
    booleanSpec('wholesale_price_negative', (s) => s.price.negative, (options) => options.wholesalePriceSensor),
    {
      key: 'wholesale_price',
      present: (options) => options.wholesalePriceSensor,
      type: (hap) => lightSensorType(hap),
      bind: (hap, service, _options, log) => {
        const sensor = new PriceSensor(hap, service, log)
        return { publish: (signals) => sensor.publish(signals.price.centsPerKwh) }
      },
    },
    {
      key: 'wholesale_price_level',
      present: (options) => options.wholesalePriceLevelSensor,
      type: (hap) => airQualitySensorType(hap),
      bind: (hap, service) => {
        const sensor = new PriceLevelSensor(hap, service)
        return { publish: (signals) => sensor.publish(signals.price.tier) }
      },
    },
  ],
}

export class GroupAccessory implements Presenter {
  readonly accessory: PlatformAccessory
  readonly #carriers: Carrier[]

  constructor(hap: HAP, accessory: PlatformAccessory, group: GroupKind, options: GroupOptions, log: RuntimeLog) {
    this.accessory = accessory
    const specs = GROUP_SERVICES[group].filter((spec) => spec.present(options))
    removeServicesExcept(hap, accessory, new Set(specs.map((spec) => spec.key)))
    this.#carriers = specs.map((spec) => spec.bind(hap, ensureService(hap, accessory, spec.type(hap, options), spec.key), options, log))
  }

  publish(signals: Signals): void {
    for (const carrier of this.#carriers) carrier.publish(signals)
  }
}
