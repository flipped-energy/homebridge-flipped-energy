import type { Characteristic, CharacteristicProps, HAP } from 'homebridge'
import { FORMAT_DATA, FORMAT_FLOAT, PERM_HIDDEN, PERM_NOTIFY, PERM_PAIRED_READ, PERM_PAIRED_WRITE } from '../hap/constants.ts'
import { EVE_POWER_CONSUMPTION_UUID, EVE_TOTAL_CONSUMPTION_UUID } from '../hap/fault.ts'

export const EVE_UUIDS = {
  totalConsumption: EVE_TOTAL_CONSUMPTION_UUID,
  powerConsumption: EVE_POWER_CONSUMPTION_UUID,
  historyService: 'E863F007-079E-48FF-8F27-9C2605A29F52',
  historyStatus: 'E863F116-079E-48FF-8F27-9C2605A29F52',
  historyEntries: 'E863F117-079E-48FF-8F27-9C2605A29F52',
  historyRequest: 'E863F11C-079E-48FF-8F27-9C2605A29F52',
  setTime: 'E863F121-079E-48FF-8F27-9C2605A29F52',
} as const

export const TOTAL_CONSUMPTION_UNIT = 'kWh'
export const TOTAL_CONSUMPTION_MAX = 1000000
export const TOTAL_CONSUMPTION_STEP = 0.01

export type CharacteristicType = (new () => Characteristic) & { readonly UUID: string }

export interface EveTypes {
  TotalConsumption: CharacteristicType
  PowerConsumption: CharacteristicType
  HistoryStatus: CharacteristicType
  HistoryEntries: CharacteristicType
  HistoryRequest: CharacteristicType
  SetTime: CharacteristicType
}

function characteristicType(hap: HAP, name: string, uuid: string, props: CharacteristicProps): CharacteristicType {
  return class extends hap.Characteristic {
    static readonly UUID = uuid

    constructor() {
      super(name, uuid, props)
      this.value = this.getDefaultValue()
    }
  }
}

const created = new WeakMap<HAP, EveTypes>()

export function eveTypes(hap: HAP): EveTypes {
  const known = created.get(hap)
  if (known !== undefined) return known
  const data = (perms: CharacteristicProps['perms']): CharacteristicProps => ({ format: FORMAT_DATA, perms })
  const types: EveTypes = {
    TotalConsumption: characteristicType(hap, 'Total Consumption', EVE_UUIDS.totalConsumption, {
      format: FORMAT_FLOAT,
      unit: TOTAL_CONSUMPTION_UNIT,
      minValue: 0,
      maxValue: TOTAL_CONSUMPTION_MAX,
      minStep: TOTAL_CONSUMPTION_STEP,
      perms: [PERM_PAIRED_READ, PERM_NOTIFY],
    }),
    PowerConsumption: characteristicType(hap, 'Power Usage (last metered interval)', EVE_UUIDS.powerConsumption, {
      format: FORMAT_FLOAT,
      unit: 'W',
      minValue: 0,
      maxValue: 1000000,
      minStep: 0.1,
      perms: [PERM_PAIRED_READ, PERM_NOTIFY],
    }),
    HistoryStatus: characteristicType(hap, 'History Status', EVE_UUIDS.historyStatus, data([PERM_PAIRED_READ, PERM_NOTIFY, PERM_HIDDEN])),
    HistoryEntries: characteristicType(hap, 'History Entries', EVE_UUIDS.historyEntries, data([PERM_PAIRED_READ, PERM_NOTIFY, PERM_HIDDEN])),
    HistoryRequest: characteristicType(hap, 'History Request', EVE_UUIDS.historyRequest, data([PERM_PAIRED_WRITE, PERM_HIDDEN])),
    SetTime: characteristicType(hap, 'Set Time', EVE_UUIDS.setTime, data([PERM_PAIRED_WRITE, PERM_HIDDEN])),
  }
  created.set(hap, types)
  return types
}
