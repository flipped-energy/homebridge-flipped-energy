import { inspect } from 'node:util'
import type { EndpointType, MatterAccessory } from 'homebridge'
import { parseInstant } from '../core/time.ts'
import type { Taken } from '../energy/ledger.ts'
import { logThrown } from '../log.ts'
import type { RuntimeLog } from '../runtime/requestGate.ts'
import { CHANNEL_NAMES, type ChannelName } from '../runtime/stateStore.ts'
import { MANUFACTURER } from '../hap/names.ts'
import { MATTER_MODEL, matterSerialNumber, matterUuidSeed } from './names.ts'

export const ENERGY_CLUSTER = 'electricalEnergyMeasurement'
export const MATTER_CONTEXT_SCHEMA = 1
export const MWH_PER_KWH = 1e6

const MS_PER_SECOND = 1000

export interface Measurement {
  energy: number
  startTimestamp?: number
  endTimestamp?: number
}

export type MeasurementKey = 'cumulativeEnergyImported' | 'periodicEnergyImported' | 'cumulativeEnergyExported' | 'periodicEnergyExported'

export type EnergyState = Partial<Record<MeasurementKey, Measurement | null>>

export interface MatterEnergyApi {
  readonly uuid: { generate(data: string): string }
  readonly deviceTypes: { readonly ElectricalSensor: EndpointType }
  registerPlatformAccessories(pluginIdentifier: string, platformName: string, accessories: MatterAccessory[]): Promise<void>
  unregisterPlatformAccessories(pluginIdentifier: string, platformName: string, accessories: MatterAccessory[]): Promise<void>
  updateAccessoryState(uuid: string, cluster: string, attributes: Record<string, unknown>): Promise<void>
  getAccessoryState(uuid: string, cluster: string): Promise<Record<string, unknown> | undefined>
}

export interface MatterEnergyContext {
  schema: typeof MATTER_CONTEXT_SCHEMA
  instanceKey: string
  key: ChannelName
}

export interface MatterEnergyDeps {
  api: MatterEnergyApi
  log: RuntimeLog
  pluginName: string
  platformName: string
}

export interface ChannelTotals {
  totalKwh: number
  through: string
}

interface Pending {
  key: ChannelName
  uuid: string
  payload: EnergyState
  settled: boolean
  retry: boolean
}

const PAIRS: Readonly<Record<ChannelName, { cumulative: MeasurementKey; periodic: MeasurementKey }>> = {
  grid_import: { cumulative: 'cumulativeEnergyImported', periodic: 'periodicEnergyImported' },
  controlled_load: { cumulative: 'cumulativeEnergyImported', periodic: 'periodicEnergyImported' },
  solar_export: { cumulative: 'cumulativeEnergyExported', periodic: 'periodicEnergyExported' },
  peak: { cumulative: 'cumulativeEnergyImported', periodic: 'periodicEnergyImported' },
  off_peak: { cumulative: 'cumulativeEnergyImported', periodic: 'periodicEnergyImported' },
  shoulder: { cumulative: 'cumulativeEnergyImported', periodic: 'periodicEnergyImported' },
}

const MEASUREMENT_KEYS: readonly MeasurementKey[] = ['cumulativeEnergyImported', 'periodicEnergyImported', 'cumulativeEnergyExported', 'periodicEnergyExported']

const MEASUREMENT_FIELDS = ['energy', 'startTimestamp', 'endTimestamp'] as const

function oneLine(value: unknown): string {
  return inspect(value, { depth: null, breakLength: Infinity, compact: true })
}

function unixSeconds(instant: string): number {
  const ms = parseInstant(instant)
  if (ms === null) throw new Error(`Matter energy: ${JSON.stringify(instant)} is not an instant`)
  return ms / MS_PER_SECOND
}

export function nullPayload(key: ChannelName): EnergyState {
  const pair = PAIRS[key]
  return { [pair.cumulative]: null, [pair.periodic]: null }
}

export function energyPayload(key: ChannelName, totals: ChannelTotals, taken: Taken | null): EnergyState {
  const pair = PAIRS[key]
  const cumulative: Measurement = { energy: Math.round(totals.totalKwh * MWH_PER_KWH), endTimestamp: unixSeconds(totals.through) }
  if (taken === null) return { [pair.cumulative]: cumulative }
  const startTimestamp = unixSeconds(taken.firstStart)
  const endTimestamp = unixSeconds(taken.lastEnd)
  if (endTimestamp <= startTimestamp) throw new Error(`Matter energy ${key}: periodic end ${taken.lastEnd} is not after its start ${taken.firstStart}`)
  return { [pair.cumulative]: cumulative, [pair.periodic]: { energy: Math.round(taken.deltaKwh * MWH_PER_KWH), startTimestamp, endTimestamp } }
}

function sameMeasurement(sent: Measurement | null | undefined, read: unknown): boolean {
  if (sent === undefined) return true
  if (sent === null) return read === null
  if (typeof read !== 'object' || read === null) return false
  const fields: Record<string, unknown> = { ...read }
  return MEASUREMENT_FIELDS.every((field) => fields[field] === sent[field])
}

export function confirms(payload: EnergyState, state: Record<string, unknown> | undefined): boolean {
  if (state === undefined) return false
  return MEASUREMENT_KEYS.every((key) => sameMeasurement(payload[key], state[key]))
}

export function readMatterContext(accessory: MatterAccessory): MatterEnergyContext | null {
  const schema: unknown = accessory.context.schema
  const instanceKey: unknown = accessory.context.instanceKey
  const key: unknown = accessory.context.key
  if (schema !== MATTER_CONTEXT_SCHEMA || typeof instanceKey !== 'string') return null
  const channel = CHANNEL_NAMES.find((candidate) => candidate === key)
  return channel === undefined ? null : { schema: MATTER_CONTEXT_SCHEMA, instanceKey, key: channel }
}

export class MatterEnergy {
  readonly #deps: MatterEnergyDeps
  readonly #cache = new Map<string, MatterAccessory>()
  readonly #endpoints = new Map<ChannelName, string>()
  #pending: Pending[] = []

  constructor(deps: MatterEnergyDeps) {
    this.#deps = deps
  }

  get endpoints(): ReadonlyMap<ChannelName, string> {
    return this.#endpoints
  }

  configure(accessory: MatterAccessory): void {
    this.#cache.set(accessory.UUID, accessory)
  }

  nullCached(): void {
    for (const accessory of this.#cache.values()) {
      const declared = accessory.clusters?.[ENERGY_CLUSTER]
      const attributes: EnergyState = {}
      for (const key of MEASUREMENT_KEYS) if (declared !== undefined && key in declared) attributes[key] = null
      this.#call(`null cached Matter accessory ${accessory.UUID}`, this.#deps.api.updateAccessoryState(accessory.UUID, ENERGY_CLUSTER, attributes))
    }
  }

  bind(instanceKey: string | null, channels: ReadonlySet<ChannelName>, wanted: boolean, name: (key: ChannelName) => string): void {
    const kept = new Map<ChannelName, MatterAccessory>()
    for (const accessory of this.#cache.values()) {
      const context = readMatterContext(accessory)
      if (!wanted || context === null || context.instanceKey !== instanceKey || !channels.has(context.key) || kept.has(context.key)) {
        this.#call(`unregister Matter accessory ${accessory.UUID}`, this.#deps.api.unregisterPlatformAccessories(this.#deps.pluginName, this.#deps.platformName, [accessory]))
        continue
      }
      kept.set(context.key, accessory)
    }
    this.#cache.clear()
    if (!wanted || instanceKey === null) return
    for (const key of CHANNEL_NAMES) {
      if (!channels.has(key)) continue
      const cached = kept.get(key)
      const accessory = this.#accessory(instanceKey, key, cached === undefined ? name(key) : cached.displayName)
      if (cached !== undefined && cached.UUID !== accessory.UUID) throw new Error(`Matter accessory ${cached.UUID} of ${key} differs from ${accessory.UUID}`)
      this.#call(`register Matter accessory ${accessory.displayName}`, this.#deps.api.registerPlatformAccessories(this.#deps.pluginName, this.#deps.platformName, [accessory]))
      this.#endpoints.set(key, accessory.UUID)
    }
  }

  channelAppeared(key: ChannelName): void {
    this.#deps.log.info(`${key}: its Matter accessory is added at the next Homebridge restart`)
  }

  async push(key: ChannelName, totals: ChannelTotals, taken: Taken | null): Promise<void> {
    const uuid = this.#endpoints.get(key)
    if (uuid === undefined) return
    const payload = energyPayload(key, totals, taken)
    const state = await this.#deps.api.getAccessoryState(uuid, ENERGY_CLUSTER)
    if (state === undefined) {
      this.#deps.log.error(`${key}: ${uuid}: no Matter endpoint`)
      return
    }
    this.send(key, uuid, payload, false)
  }

  pushNull(key: ChannelName): void {
    const uuid = this.#endpoints.get(key)
    if (uuid === undefined) return
    this.send(key, uuid, nullPayload(key), false)
  }

  async confirm(): Promise<void> {
    const due = this.#pending.filter((pending) => pending.settled)
    this.#pending = this.#pending.filter((pending) => !pending.settled)
    for (const pending of due) {
      const state = await this.#deps.api.getAccessoryState(pending.uuid, ENERGY_CLUSTER)
      if (confirms(pending.payload, state)) continue
      this.#deps.log.error(`${pending.key}: Matter ${pending.uuid} ${ENERGY_CLUSTER} sent ${oneLine(pending.payload)}, read ${oneLine(state)}`)
      if (!pending.retry) this.send(pending.key, pending.uuid, nullPayload(pending.key), true)
    }
  }

  send(key: ChannelName, uuid: string, payload: EnergyState, retry: boolean): void {
    const pending: Pending = { key, uuid, payload, settled: false, retry }
    this.#pending.push(pending)
    const settle = (): void => {
      pending.settled = true
    }
    this.#deps.api.updateAccessoryState(uuid, ENERGY_CLUSTER, payload).then(settle, (error: unknown) => {
      settle()
      logThrown(this.#deps.log, `${key}: Matter ${uuid} ${ENERGY_CLUSTER} update ${oneLine(payload)}`, error)
    })
  }

  #accessory(instanceKey: string, key: ChannelName, displayName: string): MatterAccessory<MatterEnergyContext> {
    return {
      UUID: this.#deps.api.uuid.generate(matterUuidSeed(instanceKey, key)),
      displayName,
      deviceType: this.#deps.api.deviceTypes.ElectricalSensor,
      serialNumber: matterSerialNumber(instanceKey, key),
      manufacturer: MANUFACTURER,
      model: MATTER_MODEL,
      context: { schema: MATTER_CONTEXT_SCHEMA, instanceKey, key },
      clusters: { [ENERGY_CLUSTER]: nullPayload(key) },
    }
  }

  #call(step: string, call: Promise<void>): void {
    call.then(undefined, (error: unknown) => logThrown(this.#deps.log, step, error))
  }
}
