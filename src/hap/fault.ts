import type { Characteristic, CharacteristicValue, HAP, PlatformAccessory, Service } from 'homebridge'
import { STATUS_READ_ONLY_CHARACTERISTIC, STATUS_SERVICE_COMMUNICATION_FAILURE } from './constants.ts'

export const EVE_POWER_CONSUMPTION_UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52'

export const EVE_TOTAL_CONSUMPTION_UUID = 'E863F10C-079E-48FF-8F27-9C2605A29F52'

export function valueCharacteristicUuids(hap: HAP): ReadonlySet<string> {
  const { Characteristic: C } = hap
  return new Set([C.On.UUID, C.OccupancyDetected.UUID, C.ContactSensorState.UUID, C.CurrentAmbientLightLevel.UUID, C.AirQuality.UUID, EVE_TOTAL_CONSUMPTION_UUID, EVE_POWER_CONSUMPTION_UUID])
}

export function isSensor(hap: HAP, service: Service): boolean {
  const { Service: S } = hap
  return [S.OccupancySensor.UUID, S.ContactSensor.UUID, S.LightSensor.UUID, S.AirQualitySensor.UUID].includes(service.UUID)
}

export function faultCharacteristic(hap: HAP, characteristic: Characteristic): void {
  characteristic.updateValue(new hap.HapStatusError(STATUS_SERVICE_COMMUNICATION_FAILURE))
}

export function markSensor(hap: HAP, service: Service, known: boolean): void {
  const { StatusFault, StatusActive } = hap.Characteristic
  service.getCharacteristic(StatusFault).updateValue(known ? StatusFault.NO_FAULT : StatusFault.GENERAL_FAULT)
  service.getCharacteristic(StatusActive).updateValue(known)
}

export function refuseWrites(hap: HAP, characteristic: Characteristic, restore: () => void): void {
  characteristic.onSet(() => {
    setImmediate(restore)
    throw new hap.HapStatusError(STATUS_READ_ONLY_CHARACTERISTIC)
  })
}

export function faultCachedAccessory(hap: HAP, accessory: PlatformAccessory): void {
  const status = accessory.context.kind === 'status'
  const values = valueCharacteristicUuids(hap)
  const { On, OccupancyDetected } = hap.Characteristic
  for (const service of accessory.services) {
    for (const characteristic of service.characteristics) {
      if (!values.has(characteristic.UUID)) continue
      if (status && characteristic.UUID === OccupancyDetected.UUID) {
        characteristic.updateValue(OccupancyDetected.OCCUPANCY_DETECTED)
        continue
      }
      faultCharacteristic(hap, characteristic)
      if (characteristic.UUID === On.UUID) refuseWrites(hap, characteristic, () => faultCharacteristic(hap, characteristic))
    }
    if (!status && isSensor(hap, service)) markSensor(hap, service, false)
  }
}

export class ValueCarrier {
  readonly #hap: HAP
  readonly #service: Service
  readonly #characteristic: Characteristic
  readonly #sensor: boolean
  #value: CharacteristicValue | null = null

  constructor(hap: HAP, service: Service, characteristic: Characteristic) {
    this.#hap = hap
    this.#service = service
    this.#characteristic = characteristic
    this.#sensor = isSensor(hap, service)
    this.#fault()
  }

  get characteristic(): Characteristic {
    return this.#characteristic
  }

  get value(): CharacteristicValue | null {
    return this.#value
  }

  publish(next: CharacteristicValue | null): void {
    const previous = this.#value
    this.#value = next
    if (next === null) {
      if (previous !== null) this.#fault()
      return
    }
    if (previous === null) {
      this.#characteristic.sendEventNotification(next)
      if (this.#sensor) markSensor(this.#hap, this.#service, true)
      return
    }
    this.#characteristic.updateValue(next)
  }

  refuseWrites(): void {
    refuseWrites(this.#hap, this.#characteristic, () => this.restore())
  }

  restore(): void {
    if (this.#value === null) faultCharacteristic(this.#hap, this.#characteristic)
    else this.#characteristic.updateValue(this.#value)
  }

  #fault(): void {
    faultCharacteristic(this.#hap, this.#characteristic)
    if (this.#sensor) markSensor(this.#hap, this.#service, false)
  }
}
