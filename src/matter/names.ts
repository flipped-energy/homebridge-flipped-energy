import { CHANNEL_IDENTITIES, serialNumber } from '../hap/names.ts'
import type { ChannelName } from '../runtime/stateStore.ts'

export const NODE_LABEL_MAX = 32
export const MATTER_MODEL = 'Energy History'
export const MATTER_SERIAL_SUFFIX = '-M'

const SUFFIX_LENGTH = 4

export function nodeLabel(name: string): string {
  if (name.length > NODE_LABEL_MAX) throw new Error(`Matter NodeLabel ${JSON.stringify(name)} has ${name.length} characters, the maximum is ${NODE_LABEL_MAX}`)
  return name
}

export function matterName(firstInstance: boolean, accountNumber: string, nmi: string | null, key: ChannelName): string {
  const base = key === 'peak' || key === 'off_peak' || key === 'shoulder' ? CHANNEL_IDENTITIES[key].suffix : `${CHANNEL_IDENTITIES[key].suffix} Energy`
  if (firstInstance) return nodeLabel(base)
  const account = `${base} ${accountNumber.slice(-SUFFIX_LENGTH)}`
  return nodeLabel(nmi === null ? account : `${account} ${nmi.slice(-SUFFIX_LENGTH)}`)
}

export function matterUuidSeed(instanceKey: string, key: ChannelName): string {
  return `flipped:${instanceKey}:matter:${key}`
}

export function matterSerialNumber(instanceKey: string, key: ChannelName): string {
  return `${serialNumber(instanceKey, CHANNEL_IDENTITIES[key])}${MATTER_SERIAL_SUFFIX}`
}
