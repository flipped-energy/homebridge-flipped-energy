import type { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CharacteristicChange, Characteristic, Logging, PlatformAccessory } from 'homebridge'
import { HomebridgeAPI } from '../../node_modules/homebridge/dist/api.js'
import { User } from '../../node_modules/homebridge/dist/user.js'
import { PLATFORM_NAME, PLUGIN_NAME } from '../../src/settings.ts'

export { HomebridgeAPI, User }

export type LogLevelName = 'info' | 'success' | 'warn' | 'error' | 'debug' | 'log'

export interface LogRecord {
  level: LogLevelName
  message: string
}

interface Waiter {
  predicate(record: LogRecord): boolean
  resolve(record: LogRecord): void
}

export class LogRecorder {
  readonly records: LogRecord[] = []
  readonly logging: Logging
  #waiters: Waiter[] = []

  constructor() {
    const at =
      (level: LogLevelName) =>
      (message: string): void => {
        this.#push({ level, message })
      }
    this.logging = Object.assign(at('info'), {
      prefix: PLATFORM_NAME,
      info: at('info'),
      success: at('success'),
      warn: at('warn'),
      error: at('error'),
      debug: at('debug'),
      log: (_level: Parameters<Logging['log']>[0], message: string): void => {
        this.#push({ level: 'log', message })
      },
    })
  }

  messages(level: LogLevelName): string[] {
    return this.records.filter((record) => record.level === level).map((record) => record.message)
  }

  until(predicate: (record: LogRecord) => boolean): Promise<LogRecord> {
    const found = this.records.find(predicate)
    if (found !== undefined) return Promise.resolve(found)
    return new Promise((resolve) => {
      this.#waiters.push({ predicate, resolve })
    })
  }

  #push(record: LogRecord): void {
    this.records.push(record)
    const matched = this.#waiters.filter((waiter) => waiter.predicate(record))
    this.#waiters = this.#waiters.filter((waiter) => !matched.includes(waiter))
    for (const waiter of matched) waiter.resolve(record)
  }
}

let storage: string | null = null

export function storagePath(): string {
  if (storage !== null) return storage
  const directory = mkdtempSync(join(tmpdir(), 'flipped-homebridge-'))
  User.setStoragePath(directory)
  process.once('exit', () => rmSync(directory, { recursive: true, force: true }))
  storage = directory
  return directory
}

export function emitterOf(api: HomebridgeAPI): EventEmitter {
  return api
}

export function associate(api: HomebridgeAPI, accessories: PlatformAccessory[]): void {
  api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories)
}

export function restoreFromCache(api: HomebridgeAPI, accessory: PlatformAccessory): PlatformAccessory {
  const json: Parameters<HomebridgeAPI['platformAccessory']['deserialize']>[0] = JSON.parse(JSON.stringify(api.platformAccessory.serialize(accessory)))
  return api.platformAccessory.deserialize(json)
}

export function changesOf(characteristic: Characteristic): CharacteristicChange[] {
  const changes: CharacteristicChange[] = []
  characteristic.on('change', (change: CharacteristicChange) => {
    changes.push(change)
  })
  return changes
}

export async function readStatus(characteristic: Characteristic): Promise<{ value: unknown } | { status: unknown }> {
  try {
    const value: unknown = await characteristic.handleGetRequest()
    return { value }
  } catch (status: unknown) {
    return { status }
  }
}
