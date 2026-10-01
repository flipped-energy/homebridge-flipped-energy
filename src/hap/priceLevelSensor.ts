import type { HAP, Service } from 'homebridge'
import type { PriceTier } from '../core/types.ts'
import { ValueCarrier } from './fault.ts'
import type { ServiceType } from './groupAccessory.ts'

export function airQualitySensorType(hap: HAP): ServiceType {
  const { AirQualitySensor } = hap.Service
  return { uuid: AirQualitySensor.UUID, create: (name, key) => new AirQualitySensor(name, key) }
}

export function airQuality(hap: HAP, tier: PriceTier): number {
  const { AirQuality } = hap.Characteristic
  if (tier === 'UnusuallyLow') return AirQuality.EXCELLENT
  if (tier === 'Normal') return AirQuality.GOOD
  if (tier === 'Elevated') return AirQuality.INFERIOR
  return AirQuality.POOR
}

export class PriceLevelSensor {
  readonly #hap: HAP
  readonly #carrier: ValueCarrier

  constructor(hap: HAP, service: Service) {
    this.#hap = hap
    this.#carrier = new ValueCarrier(hap, service, service.getCharacteristic(hap.Characteristic.AirQuality))
  }

  get carrier(): ValueCarrier {
    return this.#carrier
  }

  publish(tier: PriceTier | null): void {
    this.#carrier.publish(tier === null ? null : airQuality(this.#hap, tier))
  }
}
