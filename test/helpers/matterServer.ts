import { existsSync, mkdirSync, mkdtempSync, readFileSync, watch } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import type { MatterAccessory } from 'homebridge'
import { MatterServer } from '../../node_modules/homebridge/dist/matter/server.js'
import { deviceTypes } from '../../node_modules/homebridge/dist/matter/types.js'
import type { MatterEnergyApi } from '../../src/matter/energyAccessories.ts'
import { HomebridgeAPI, storagePath } from './homebridgeHarness.ts'

export const BRIDGE_UNIQUE_ID = 'AA:BB:CC:DD:EE:F1'
const BRIDGE_ID = BRIDGE_UNIQUE_ID.replaceAll(':', '')
const CACHE_FILE = 'accessories.json'

export function loopbackInterface(): string {
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (addresses?.some((address) => address.internal) === true) return name
  }
  throw new Error(`no loopback interface in ${Object.keys(networkInterfaces()).join(', ')}`)
}

export function matterStorage(): string {
  const root = join(storagePath(), 'matter')
  mkdirSync(root, { recursive: true })
  return mkdtempSync(join(root, 'run-'))
}

export class OfflineMatter {
  readonly server: MatterServer
  readonly directory: string
  readonly failures: string[] = []
  #inflight = new Set<Promise<void>>()

  private constructor(server: MatterServer, directory: string) {
    this.server = server
    this.directory = directory
  }

  static async start(directory: string): Promise<OfflineMatter> {
    const server = new MatterServer({ uniqueId: BRIDGE_UNIQUE_ID, storagePath: directory, deferOnline: true, networkInterfaces: [loopbackInterface()] })
    await server.start()
    return new OfflineMatter(server, directory)
  }

  get api(): MatterEnergyApi {
    const { uuid } = new HomebridgeAPI().hap
    return {
      uuid,
      deviceTypes: { ElectricalSensor: deviceTypes.ElectricalSensor },
      registerPlatformAccessories: (plugin, platform, accessories) => this.#emit(`register ${accessories.map((a) => a.UUID).join(', ')}`, this.server.registerPlatformAccessories(plugin, platform, accessories)),
      unregisterPlatformAccessories: (plugin, platform, accessories) => this.#emit(`unregister ${accessories.map((a) => a.UUID).join(', ')}`, this.server.unregisterPlatformAccessories(plugin, platform, accessories)),
      updateAccessoryState: (target, cluster, attributes) => this.#emit(`update ${target}`, this.server.updateAccessoryState(target, cluster, attributes)),
      getAccessoryState: (target, cluster) => Promise.resolve(this.server.getAccessoryState(target, cluster)),
    }
  }

  async settled(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.all([...this.#inflight])
  }

  cached(): MatterAccessory[] {
    return this.server.getAllCachedAccessories().map((serialized) => ({
      UUID: serialized.uuid,
      displayName: serialized.displayName,
      deviceType: deviceTypes.ElectricalSensor,
      serialNumber: serialized.serialNumber,
      manufacturer: serialized.manufacturer,
      model: serialized.model,
      context: serialized.context ?? {},
      ...(serialized.clusters === undefined ? {} : { clusters: serialized.clusters }),
    }))
  }

  cacheWritten(predicate: (text: string) => boolean): Promise<void> {
    const directory = join(this.directory, BRIDGE_ID)
    const file = join(directory, CACHE_FILE)
    mkdirSync(directory, { recursive: true })
    const matches = (): boolean => existsSync(file) && predicate(readFileSync(file, 'utf8'))
    if (matches()) return Promise.resolve()
    return new Promise((resolve) => {
      const watcher = watch(directory, (_event, name) => {
        if (name !== CACHE_FILE) return
        let found = false
        try {
          found = matches()
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
        }
        if (!found) return
        watcher.close()
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    return this.server.stop()
  }

  #emit(step: string, call: Promise<void>): Promise<void> {
    const tracked = call.then(
      () => undefined,
      (error: unknown) => {
        this.failures.push(`${step}: ${inspect(error, { depth: null })}`)
      },
    )
    this.#inflight.add(tracked)
    tracked.then(() => this.#inflight.delete(tracked), () => this.#inflight.delete(tracked))
    return Promise.resolve()
  }
}
