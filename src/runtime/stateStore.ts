import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type JsonRecord, isRecord } from '../core/types.ts'

export const STATE_VERSION = 1
export const PIN_FILE = 'pin.json'
export const STATE_FILE_MODE = 0o600

export type ChannelName = 'grid_import' | 'solar_export' | 'controlled_load'

export const CHANNEL_NAMES: readonly ChannelName[] = ['grid_import', 'solar_export', 'controlled_load']

export interface PinState {
  version: typeof STATE_VERSION
  accountNumber: string
}

export interface InstanceState {
  version: typeof STATE_VERSION
  instanceKey: string
  channels: Partial<Record<ChannelName, JsonRecord>>
}

export class StateFileError extends Error {
  readonly path: string

  constructor(path: string, message: string, options?: ErrorOptions) {
    super(`${path}: ${message}`, options)
    this.name = 'StateFileError'
    this.path = path
  }
}

export function instanceKeyOf(accountNumber: string, nmi: string | null): string {
  return nmi === null ? accountNumber : `${accountNumber}:${nmi}`
}

export function instanceHash(instanceKey: string): string {
  return createHash('sha256').update(instanceKey, 'utf8').digest('hex').slice(0, 16)
}

function isChannelName(value: string): value is ChannelName {
  return CHANNEL_NAMES.some((name) => name === value)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function readJson(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch (error) {
    if (error instanceof SyntaxError) throw new StateFileError(path, error.message, { cause: error })
    throw error
  }
}

function readVersioned(path: string): JsonRecord | null {
  const parsed = readJson(path)
  if (parsed === undefined) return null
  if (!isRecord(parsed)) throw new StateFileError(path, `expected an object, got ${JSON.stringify(parsed)}`)
  if (parsed.version !== STATE_VERSION) throw new StateFileError(path, `version ${JSON.stringify(parsed.version)}, expected ${STATE_VERSION}`)
  return parsed
}

export class StateStore {
  readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  get pinPath(): string {
    return join(this.directory, PIN_FILE)
  }

  instancePath(instanceKey: string): string {
    return join(this.directory, `instance-${instanceHash(instanceKey)}.json`)
  }

  readPin(): string | null {
    const path = this.pinPath
    const pin = readVersioned(path)
    if (pin === null) return null
    if (typeof pin.accountNumber !== 'string' || pin.accountNumber === '') {
      throw new StateFileError(path, `accountNumber ${JSON.stringify(pin.accountNumber)}, expected a non-empty string`)
    }
    return pin.accountNumber
  }

  writePin(accountNumber: string): void {
    const pin: PinState = { version: STATE_VERSION, accountNumber }
    this.#write(this.pinPath, pin)
  }

  readInstance(instanceKey: string): InstanceState | null {
    const path = this.instancePath(instanceKey)
    const state = readVersioned(path)
    if (state === null) return null
    if (state.instanceKey !== instanceKey) throw new StateFileError(path, `instanceKey ${JSON.stringify(state.instanceKey)}, expected ${JSON.stringify(instanceKey)}`)
    if (!isRecord(state.channels)) throw new StateFileError(path, `channels ${JSON.stringify(state.channels)}, expected an object`)
    const channels: Partial<Record<ChannelName, JsonRecord>> = {}
    for (const [name, channel] of Object.entries(state.channels)) {
      if (!isChannelName(name)) throw new StateFileError(path, `channels.${name}: not one of ${CHANNEL_NAMES.join(', ')}`)
      if (!isRecord(channel)) throw new StateFileError(path, `channels.${name}: expected an object, got ${JSON.stringify(channel)}`)
      channels[name] = channel
    }
    return { version: STATE_VERSION, instanceKey, channels }
  }

  writeInstance(state: InstanceState): void {
    this.#write(this.instancePath(state.instanceKey), state)
  }

  #write(path: string, value: PinState | InstanceState): void {
    mkdirSync(this.directory, { recursive: true })
    const temporary = `${path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: STATE_FILE_MODE })
    chmodSync(temporary, STATE_FILE_MODE)
    renameSync(temporary, path)
  }
}
