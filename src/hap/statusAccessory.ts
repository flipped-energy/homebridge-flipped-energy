import type { HAP, PlatformAccessory, Service } from 'homebridge'
import type { Signals } from '../core/types.ts'
import { booleanServiceType } from './booleanSignal.ts'
import { markSensor } from './fault.ts'
import { type Presenter, ensureService, removeServicesExcept } from './groupAccessory.ts'
import type { StatusKey } from './names.ts'

const STATUS_KEYS: readonly StatusKey[] = ['tariff_unavailable', 'wholesale_unavailable']

export class StatusAccessory implements Presenter {
  readonly accessory: PlatformAccessory
  readonly #hap: HAP
  readonly #services: Partial<Record<StatusKey, Service>>

  constructor(hap: HAP, accessory: PlatformAccessory) {
    this.accessory = accessory
    this.#hap = hap
    removeServicesExcept(hap, accessory, new Set(STATUS_KEYS))
    const type = booleanServiceType(hap, 'occupancySensor')
    this.#services = {
      tariff_unavailable: ensureService(hap, accessory, type, 'tariff_unavailable'),
      wholesale_unavailable: ensureService(hap, accessory, type, 'wholesale_unavailable'),
    }
    for (const key of STATUS_KEYS) {
      const service = this.#services[key]
      if (service === undefined) continue
      markSensor(hap, service, true)
      this.#set(service, true)
    }
  }

  publish(signals: Signals): void {
    const tariff = this.#services.tariff_unavailable
    const wholesale = this.#services.wholesale_unavailable
    if (tariff !== undefined) this.#set(tariff, signals.tariff.status === 'faulted')
    if (wholesale !== undefined) this.#set(wholesale, signals.price.status === 'faulted')
  }

  setSpotPrices(enabled: boolean): void {
    const service = this.#services.wholesale_unavailable
    if (enabled && service === undefined) {
      this.#services.wholesale_unavailable = ensureService(this.#hap, this.accessory, booleanServiceType(this.#hap, 'occupancySensor'), 'wholesale_unavailable')
      markSensor(this.#hap, this.#services.wholesale_unavailable, true)
    } else if (!enabled && service !== undefined) {
      this.accessory.removeService(service)
      delete this.#services.wholesale_unavailable
    }
  }

  #set(service: Service, unavailable: boolean): void {
    const { OccupancyDetected } = this.#hap.Characteristic
    service.getCharacteristic(OccupancyDetected).updateValue(unavailable ? OccupancyDetected.OCCUPANCY_DETECTED : OccupancyDetected.OCCUPANCY_NOT_DETECTED)
  }
}
