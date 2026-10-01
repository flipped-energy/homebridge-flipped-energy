import type { Characteristic, CharacteristicValue, HAP, Service, WithUUID } from 'homebridge'
import type { SignalService } from '../config.ts'
import { ValueCarrier } from './fault.ts'
import type { ServiceType } from './groupAccessory.ts'

type ValueCharacteristic = WithUUID<new () => Characteristic>

export function booleanServiceType(hap: HAP, kind: SignalService): ServiceType {
  const { Service: S } = hap
  if (kind === 'switch') return { uuid: S.Switch.UUID, create: (name, key) => new S.Switch(name, key) }
  if (kind === 'occupancySensor') return { uuid: S.OccupancySensor.UUID, create: (name, key) => new S.OccupancySensor(name, key) }
  return { uuid: S.ContactSensor.UUID, create: (name, key) => new S.ContactSensor(name, key) }
}

export function booleanCharacteristic(hap: HAP, kind: SignalService): ValueCharacteristic {
  const { Characteristic: C } = hap
  if (kind === 'switch') return C.On
  if (kind === 'occupancySensor') return C.OccupancyDetected
  return C.ContactSensorState
}

export function booleanValue(hap: HAP, kind: SignalService, value: boolean): CharacteristicValue {
  const { OccupancyDetected, ContactSensorState } = hap.Characteristic
  if (kind === 'switch') return value
  if (kind === 'occupancySensor') return value ? OccupancyDetected.OCCUPANCY_DETECTED : OccupancyDetected.OCCUPANCY_NOT_DETECTED
  return value ? ContactSensorState.CONTACT_NOT_DETECTED : ContactSensorState.CONTACT_DETECTED
}

export class BooleanSignal {
  readonly #hap: HAP
  readonly #kind: SignalService
  readonly #carrier: ValueCarrier

  constructor(hap: HAP, service: Service, kind: SignalService) {
    this.#hap = hap
    this.#kind = kind
    this.#carrier = new ValueCarrier(hap, service, service.getCharacteristic(booleanCharacteristic(hap, kind)))
    if (kind === 'switch') this.#carrier.refuseWrites()
  }

  get carrier(): ValueCarrier {
    return this.#carrier
  }

  publish(value: boolean | null): void {
    this.#carrier.publish(value === null ? null : booleanValue(this.#hap, this.#kind, value))
  }
}
