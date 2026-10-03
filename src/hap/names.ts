import type { ChannelName } from '../runtime/stateStore.ts'
import { instanceHash } from '../runtime/stateStore.ts'

export const MANUFACTURER = 'Flipped Energy'

export const DEVICE_NAME = 'Flipped Energy'

export const GROUP_NAMES = {
  account: 'Account',
  tariff: 'Rates',
  price: 'Wholesale Price',
  energy: 'Usage History',
} as const

export type SignalKey =
  | 'peak_rate'
  | 'off_peak_rate'
  | 'shoulder_rate'
  | 'wholesale_price_high'
  | 'wholesale_price_low'
  | 'wholesale_price_negative'
  | 'wholesale_price'
  | 'wholesale_price_level'
  | 'token_expiring'

export type StatusKey = 'tariff_unavailable' | 'wholesale_unavailable'

export type ServiceKey = SignalKey | StatusKey

export const SERVICE_NAMES: Readonly<Record<ServiceKey, string>> = {
  peak_rate: 'Peak Rate',
  off_peak_rate: 'Off-Peak Rate',
  shoulder_rate: 'Shoulder Rate',
  wholesale_price_high: 'Wholesale Price High',
  wholesale_price_low: 'Wholesale Price Low',
  wholesale_price_negative: 'Wholesale Price Negative',
  wholesale_price: 'Wholesale Price',
  wholesale_price_level: 'Wholesale Price Level',
  token_expiring: 'Token Expiring Soon',
  tariff_unavailable: `${GROUP_NAMES.tariff} Unavailable`,
  wholesale_unavailable: `${GROUP_NAMES.price} Unavailable`,
}

export type HapAccessoryKind = 'tariff' | 'wholesale' | 'status' | 'token'

export type AccessoryKind = HapAccessoryKind | 'energy'

export const HAP_ACCESSORY_KINDS: readonly HapAccessoryKind[] = ['tariff', 'wholesale', 'status', 'token']

export const ACCESSORY_KINDS: readonly AccessoryKind[] = [...HAP_ACCESSORY_KINDS, 'energy']

export interface AccessoryIdentity {
  suffix: string
  model: string
  tag: string
}

export const ACCESSORY_IDENTITIES: Readonly<Record<HapAccessoryKind, AccessoryIdentity>> = {
  tariff: { suffix: GROUP_NAMES.tariff, model: 'Tariff Signals', tag: 'TA' },
  wholesale: { suffix: 'Wholesale', model: 'Wholesale Price Signals', tag: 'WP' },
  status: { suffix: 'Status', model: 'Status', tag: 'ST' },
  token: { suffix: 'Token', model: 'Token Status', tag: 'TK' },
}

export const ENERGY_MODEL = 'Energy History'

export const CHANNEL_IDENTITIES: Readonly<Record<ChannelName, AccessoryIdentity>> = {
  peak: { suffix: 'Peak Usage', model: ENERGY_MODEL, tag: 'PK' },
  off_peak: { suffix: 'Off-Peak Usage', model: ENERGY_MODEL, tag: 'OP' },
  shoulder: { suffix: 'Shoulder Usage', model: ENERGY_MODEL, tag: 'SH' },
  grid_import: { suffix: 'Power Usage', model: ENERGY_MODEL, tag: 'GI' },
  solar_export: { suffix: 'Solar Export', model: ENERGY_MODEL, tag: 'SE' },
  controlled_load: { suffix: 'Controlled Load', model: ENERGY_MODEL, tag: 'CL' },
}

const SUFFIX_LENGTH = 4

export function deviceName(firstInstance: boolean, accountNumber: string, nmi: string | null): string {
  if (firstInstance) return DEVICE_NAME
  const account = `${DEVICE_NAME} ${accountNumber.slice(-SUFFIX_LENGTH)}`
  return nmi === null ? account : `${account} ${nmi.slice(-SUFFIX_LENGTH)}`
}

export function accessoryName(device: string, identity: AccessoryIdentity): string {
  return `${device} ${identity.suffix}`
}

export function uuidSeed(instanceKey: string, id: HapAccessoryKind | ChannelName): string {
  return `flipped:${instanceKey}:${id}`
}

export function serialNumber(instanceKey: string, identity: AccessoryIdentity): string {
  return `FE-${instanceHash(instanceKey)}-${identity.tag}`
}
