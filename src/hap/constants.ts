import type { Formats, HAPStatus, Perms } from 'homebridge'

export const STATUS_SERVICE_COMMUNICATION_FAILURE = -70402 as HAPStatus
export const STATUS_READ_ONLY_CHARACTERISTIC = -70404 as HAPStatus
export const FORMAT_FLOAT = 'float' as Formats
export const FORMAT_DATA = 'data' as Formats
export const PERM_PAIRED_READ = 'pr' as Perms
export const PERM_PAIRED_WRITE = 'pw' as Perms
export const PERM_NOTIFY = 'ev' as Perms
export const PERM_HIDDEN = 'hd' as Perms
