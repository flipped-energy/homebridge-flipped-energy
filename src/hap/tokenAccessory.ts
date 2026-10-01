import type { HAP, PlatformAccessory } from 'homebridge'
import type { Signals } from '../core/types.ts'
import { BooleanSignal, booleanServiceType } from './booleanSignal.ts'
import { type Presenter, ensureService, removeServicesExcept } from './groupAccessory.ts'

export class TokenAccessory implements Presenter {
  readonly accessory: PlatformAccessory
  readonly #signal: BooleanSignal

  constructor(hap: HAP, accessory: PlatformAccessory) {
    this.accessory = accessory
    removeServicesExcept(hap, accessory, new Set(['token_expiring']))
    const service = ensureService(hap, accessory, booleanServiceType(hap, 'occupancySensor'), 'token_expiring')
    this.#signal = new BooleanSignal(hap, service, 'occupancySensor')
  }

  publish(signals: Signals): void {
    this.#signal.publish(signals.account.tokenExpiringSoon)
  }
}
