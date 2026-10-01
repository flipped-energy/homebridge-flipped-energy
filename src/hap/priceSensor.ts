import type { HAP, Service } from 'homebridge'
import type { RuntimeLog } from '../runtime/requestGate.ts'
import { ValueCarrier } from './fault.ts'
import type { ServiceType } from './groupAccessory.ts'

export const LIGHT_LEVEL_MIN = 0.0001
export const LIGHT_LEVEL_MAX = 100000

export function lightSensorType(hap: HAP): ServiceType {
  const { LightSensor } = hap.Service
  return { uuid: LightSensor.UUID, create: (name, key) => new LightSensor(name, key) }
}

export function lightLevel(centsPerKwh: number): number | null {
  if (centsPerKwh > LIGHT_LEVEL_MAX) return null
  return centsPerKwh < LIGHT_LEVEL_MIN ? LIGHT_LEVEL_MIN : centsPerKwh
}

export class PriceSensor {
  readonly #carrier: ValueCarrier
  readonly #log: RuntimeLog
  #reported: number | null = null

  constructor(hap: HAP, service: Service, log: RuntimeLog) {
    this.#carrier = new ValueCarrier(hap, service, service.getCharacteristic(hap.Characteristic.CurrentAmbientLightLevel))
    this.#log = log
  }

  get carrier(): ValueCarrier {
    return this.#carrier
  }

  publish(centsPerKwh: number | null): void {
    if (centsPerKwh === null) {
      this.#reported = null
      this.#carrier.publish(null)
      return
    }
    const level = lightLevel(centsPerKwh)
    if (level === null) {
      if (this.#reported !== centsPerKwh) {
        this.#log.error(`wholesale_price: ${centsPerKwh} c/kWh is above ${LIGHT_LEVEL_MAX}, the maximum of CurrentAmbientLightLevel`)
      }
      this.#reported = centsPerKwh
      this.#carrier.publish(null)
      return
    }
    this.#reported = null
    this.#carrier.publish(level)
  }
}
