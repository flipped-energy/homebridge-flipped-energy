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
  readonly #services: Readonly<Record<StatusKey, Service>>

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
      markSensor(hap, service, true)
      this.#set(service, true)
    }
  }

  publish(signals: Signals): void {
    this.#set(this.#services.tariff_unavailable, signals.tariff.status === 'faulted')
    this.#set(this.#services.wholesale_unavailable, signals.price.status === 'faulted')
  }

  #set(service: Service, unavailable: boolean): void {
    const { OccupancyDetected } = this.#hap.Characteristic
    service.getCharacteristic(OccupancyDetected).updateValue(unavailable ? OccupancyDetected.OCCUPANCY_DETECTED : OccupancyDetected.OCCUPANCY_NOT_DETECTED)
  }
}
