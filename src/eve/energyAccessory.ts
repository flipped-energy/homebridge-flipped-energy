import type { Characteristic, CharacteristicValue, HAP, PlatformAccessory, Service } from 'homebridge'
import { ValueCarrier } from '../hap/fault.ts'
import { setInformation } from '../hap/groupAccessory.ts'
import { CHANNEL_IDENTITIES } from '../hap/names.ts'
import type { RuntimeLog } from '../runtime/requestGate.ts'
import type { ChannelName } from '../runtime/stateStore.ts'
import { type CharacteristicType, EVE_UUIDS, TOTAL_CONSUMPTION_MAX, eveTypes } from './characteristics.ts'
import type { EveHistory } from './history.ts'

export const HISTORY_SERVICE_NAME = 'History'

function base64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64')
}

function characteristicOf(service: Service, type: CharacteristicType): Characteristic {
  const found = service.characteristics.find((characteristic) => characteristic.UUID === type.UUID)
  return found ?? service.addCharacteristic(type)
}

function serviceOf(accessory: PlatformAccessory, uuid: string, key: ChannelName): Service | undefined {
  return accessory.services.find((service) => service.UUID === uuid && service.subtype === key)
}

export function roundTotal(totalKwh: number): number {
  return Math.round(totalKwh * 100) / 100
}

export class EveEnergyAccessory {
  readonly accessory: PlatformAccessory
  readonly key: ChannelName
  readonly #history: EveHistory
  readonly #log: RuntimeLog
  readonly #on: ValueCarrier
  readonly #total: ValueCarrier
  readonly #power: ValueCarrier
  readonly #status: Characteristic

  constructor(hap: HAP, accessory: PlatformAccessory, key: ChannelName, instanceKey: string, history: EveHistory, log: RuntimeLog) {
    this.accessory = accessory
    this.key = key
    this.#history = history
    this.#log = log
    const types = eveTypes(hap)
    const { Characteristic: C, Service: S } = hap
    const identity = CHANNEL_IDENTITIES[key]
    setInformation(hap, accessory, identity, instanceKey)
    const information = S.AccessoryInformation.UUID
    for (const service of [...accessory.services]) {
      const wanted = service.UUID === information || (service.subtype === key && (service.UUID === S.Outlet.UUID || service.UUID === EVE_UUIDS.historyService))
      if (!wanted) accessory.removeService(service)
    }
    let outlet = serviceOf(accessory, S.Outlet.UUID, key)
    if (outlet === undefined) {
      outlet = accessory.addService(new S.Outlet(identity.suffix, key))
      if (!outlet.optionalCharacteristics.some((characteristic) => characteristic.UUID === C.ConfiguredName.UUID)) outlet.addOptionalCharacteristic(C.ConfiguredName)
      outlet.getCharacteristic(C.ConfiguredName).updateValue(identity.suffix)
    }
    accessory.displayName = accessory.displayName.replace(/Grid Import$/, identity.suffix)
    outlet.getCharacteristic(C.Name).updateValue(identity.suffix)
    outlet.getCharacteristic(C.ConfiguredName).updateValue(identity.suffix)
    outlet.getCharacteristic(C.OutletInUse).updateValue(true)
    this.#on = new ValueCarrier(hap, outlet, outlet.getCharacteristic(C.On))
    this.#on.refuseWrites()
    if (!outlet.optionalCharacteristics.some((characteristic) => characteristic.UUID === types.TotalConsumption.UUID)) outlet.addOptionalCharacteristic(types.TotalConsumption)
    this.#total = new ValueCarrier(hap, outlet, characteristicOf(outlet, types.TotalConsumption))
    this.#power = new ValueCarrier(hap, outlet, characteristicOf(outlet, types.PowerConsumption))
    const historyService = serviceOf(accessory, EVE_UUIDS.historyService, key) ?? accessory.addService(new hap.Service(HISTORY_SERVICE_NAME, EVE_UUIDS.historyService, key))
    this.#status = characteristicOf(historyService, types.HistoryStatus)
    characteristicOf(historyService, types.HistoryEntries).onGet(() => base64(this.#history.read()))
    characteristicOf(historyService, types.HistoryRequest).onSet((value: CharacteristicValue) => {
      if (typeof value !== 'string') throw new Error(`${accessory.displayName}: History Request ${JSON.stringify(value)} is not base64 data`)
      this.#history.request(Buffer.from(value, 'base64'))
    })
    characteristicOf(historyService, types.SetTime).onSet(() => undefined)
    this.historyChanged()
  }

  get history(): EveHistory {
    return this.#history
  }

  publish(totalKwh: number | null, averageWatts: number | null = null): void {
    this.#power.publish(totalKwh === null ? null : averageWatts)
    if (totalKwh === null) {
      this.#on.publish(null)
      this.#total.publish(null)
      return
    }
    const total = roundTotal(totalKwh)
    if (total > TOTAL_CONSUMPTION_MAX) {
      this.#log.error(`${this.key}: Total Consumption ${total} kWh is above ${TOTAL_CONSUMPTION_MAX}, the maximum of E863F10C`)
      this.#on.publish(null)
      this.#total.publish(null)
      return
    }
    this.#on.publish(true)
    this.#total.publish(total)
  }

  historyChanged(): void {
    const status = this.#history.status()
    if (status !== null) this.#status.updateValue(base64(status))
  }
}
