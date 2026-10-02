import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { API, DynamicPlatformPlugin, Logging, MatterAccessory, PlatformAccessory, PlatformConfig } from 'homebridge'
import { ApiClient } from './api/client.ts'
import { type Config, blockRuleErrors, matterBridgeErrors, ownBlock, parseConfig } from './config.ts'
import { BASE_URL, HTTP_TIMEOUT_S, WAIT_HTTP_TIMEOUT_S } from './core/constants.ts'
import type { EnergyOk, Signals } from './core/types.ts'
import { type Advance, CHANNEL_PICKS, type ChannelState, advance, channelExists, channelRecord, emptyLedger, overflowLine, readChannelStates } from './energy/ledger.ts'
import { EveEnergyAccessory } from './eve/energyAccessory.ts'
import { EveHistory, HISTORY_MEMORY_SIZE, emptyHistoryState } from './eve/history.ts'
import { faultCachedAccessory } from './hap/fault.ts'
import { type AccessoryContext, CONTEXT_SCHEMA, GroupAccessory, type Presenter, readContext, setInformation } from './hap/groupAccessory.ts'
import { ACCESSORY_IDENTITIES, type AccessoryKind, CHANNEL_IDENTITIES, HAP_ACCESSORY_KINDS, type HapAccessoryKind, accessoryName, deviceName, uuidSeed } from './hap/names.ts'
import { StatusAccessory } from './hap/statusAccessory.ts'
import { TokenAccessory } from './hap/tokenAccessory.ts'
import { armedLine, dailyLimitLine, logErrors, logThrown, tokenExpiringLine } from './log.ts'
import { MatterEnergy, type MatterEnergyApi } from './matter/energyAccessories.ts'
import { matterName } from './matter/names.ts'
import { Instance } from './runtime/instance.ts'
import type { Transport } from './runtime/requestGate.ts'
import { type Scheduler, type TimerApi, createScheduler, systemTimers } from './runtime/scheduler.ts'
import { CHANNEL_NAMES, type ChannelName, type InstanceState, STATE_VERSION, StateStore, instanceKeyOf } from './runtime/stateStore.ts'
import { PLATFORM_NAME, PLUGIN_NAME, PRODUCT_NAME } from './settings.ts'

export interface PlatformApi extends Pick<API, 'hap' | 'user' | 'platformAccessory' | 'registerPlatformAccessories' | 'updatePlatformAccessories' | 'unregisterPlatformAccessories' | 'isMatterEnabled'> {
  readonly matter?: MatterEnergyApi | undefined
  on(event: 'didFinishLaunching', listener: () => void): unknown
  on(event: 'shutdown', listener: () => void): unknown
}

export interface PlatformEnvironment<Handle> {
  createTransport(token: string): Transport
  timers: TimerApi<Handle>
}

export class Platform<Handle> implements DynamicPlatformPlugin {
  readonly log: Logging
  readonly api: PlatformApi
  readonly #environment: PlatformEnvironment<Handle>
  readonly #cache = new Map<string, PlatformAccessory>()
  readonly #presenters = new Map<HapAccessoryKind, Presenter>()
  #config: Config | null = null
  #store: StateStore | null = null
  #instance: Instance | null = null
  #instanceKey: string | null = null
  #instanceState: InstanceState | null = null
  #firstInstance = true
  #accountFetchedAt: string | null = null
  #tokensFetchedAt: string | null = null
  readonly #matterCache: MatterAccessory[] = []
  #matter: MatterEnergy | null = null
  readonly #energy = new Map<ChannelName, EveEnergyAccessory>()
  readonly #histories = new Map<ChannelName, EveHistory>()
  #channels: Partial<Record<ChannelName, ChannelState>> = {}
  #channelsAtStart: ReadonlySet<ChannelName> = new Set()
  #usageFetchedAt: string | null = null
  #energyOk = false

  constructor(log: Logging, config: PlatformConfig, api: PlatformApi, environment: PlatformEnvironment<Handle>) {
    this.log = log
    this.api = api
    this.#environment = environment
    this.#guard('constructor', () => {
      api.on('didFinishLaunching', () => this.#guard('didFinishLaunching', () => this.#launched()))
      api.on('shutdown', () => this.#guard('shutdown', () => this.#stop()))
      const parsed = parseConfig(config)
      if (parsed.kind === 'error') logErrors(log, parsed.errors)
      else this.#config = parsed.config
    })
  }

  get idle(): boolean {
    return this.#config === null
  }

  get instanceState(): InstanceState | null {
    return this.#instanceState
  }

  get accessories(): PlatformAccessory[] {
    return [...this.#presenters.values(), ...this.#energy.values()].map((presenter) => presenter.accessory)
  }

  get matterEnergy(): MatterEnergy | null {
    return this.#matter
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.#guard('configureAccessory', () => {
      this.#cache.set(accessory.UUID, accessory)
      faultCachedAccessory(this.api.hap, accessory)
    })
  }

  configureMatterAccessory(accessory: MatterAccessory): void {
    this.#guard('configureMatterAccessory', () => {
      this.#matterCache.push(accessory)
    })
  }

  #guard(step: string, body: () => void): void {
    try {
      body()
    } catch (error) {
      this.#failed(step, error)
    }
  }

  #failed(step: string, error: unknown): void {
    logThrown(this.log, step, error)
    this.#idle()
  }

  #idle(): void {
    this.#config = null
    this.#instance?.stop()
    this.#instance = null
    for (const presenter of [...this.#presenters.values(), ...this.#energy.values()]) faultCachedAccessory(this.api.hap, presenter.accessory)
    for (const accessory of this.#cache.values()) faultCachedAccessory(this.api.hap, accessory)
    for (const key of CHANNEL_NAMES) this.#matter?.pushNull(key)
  }

  #stop(): void {
    this.#instance?.stop()
    this.#instance = null
  }

  #launched(): void {
    const matterApi = typeof this.api.isMatterEnabled === 'function' && this.api.isMatterEnabled() ? this.api.matter : undefined
    if (matterApi !== undefined) {
      const matter = new MatterEnergy({ api: matterApi, log: this.log, pluginName: PLUGIN_NAME, platformName: PLATFORM_NAME })
      for (const accessory of this.#matterCache) matter.configure(accessory)
      matter.nullCached()
      this.#matter = matter
    }
    const config = this.#config
    if (config === null) return
    const configPath = this.api.user.configPath()
    const file: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
    const ruleErrors = blockRuleErrors(file, configPath)
    if (ruleErrors.length > 0) {
      this.#configErrors(ruleErrors)
      return
    }
    const own = ownBlock(file, configPath, config)
    const matterErrors = matterBridgeErrors(own, configPath, config)
    if (matterErrors.length > 0) {
      this.#configErrors(matterErrors)
      return
    }
    this.#firstInstance = own.first
    const store = new StateStore(join(this.api.user.storagePath(), PRODUCT_NAME))
    this.#store = store
    const accountNumber = config.accountNumber === null ? store.readPin() : config.accountNumber
    if (accountNumber !== null) this.#bind(config, store, accountNumber)
    this.#bindMatter(config, accountNumber)
    const instance = new Instance({
      config,
      transport: this.#environment.createTransport(config.token),
      scheduler: this.#scheduler(),
      store,
      log: this.log,
      signalsChanged: (signals) => this.#guard('signalsChanged', () => this.#signalsChanged(signals)),
      routineFailed: (error) => this.#failed('routine', error),
    })
    this.#instance = instance
    instance.start()
  }

  #configErrors(errors: string[]): void {
    logErrors(this.log, errors)
    this.#idle()
  }

  #scheduler(): Scheduler {
    const timers = this.#environment.timers
    const guarded: TimerApi<Handle> = {
      now: () => timers.now(),
      setTimeout: (callback, delayMs) => timers.setTimeout(() => this.#guard('timer', callback), delayMs),
      clearTimeout: (handle) => timers.clearTimeout(handle),
    }
    return createScheduler(guarded, (event) => this.log.debug(armedLine(event)))
  }

  #wanted(config: Config, kind: AccessoryKind): boolean {
    if (kind === 'status') return config.availabilitySensors
    if (kind === 'token') return config.tokenExpiringSensor
    if (kind === 'energy') return config.eveHistory
    return true
  }

  #present(config: Config, kind: HapAccessoryKind, accessory: PlatformAccessory, instanceKey: string): Presenter {
    const { hap } = this.api
    setInformation(hap, accessory, ACCESSORY_IDENTITIES[kind], instanceKey)
    if (kind === 'status') return new StatusAccessory(hap, accessory)
    if (kind === 'token') return new TokenAccessory(hap, accessory)
    return new GroupAccessory(hap, accessory, kind, config, this.log)
  }

  #bind(config: Config, store: StateStore, accountNumber: string): void {
    const instanceKey = instanceKeyOf(accountNumber, config.nmi)
    const state = store.readInstance(instanceKey)
    this.#instanceState = state
    this.#instanceKey = instanceKey
    this.#channels = state === null ? {} : readChannelStates(state.channels, store.instancePath(instanceKey))
    this.#channelsAtStart = new Set(CHANNEL_NAMES.filter((name) => this.#channels[name] !== undefined))
    for (const name of this.#channelsAtStart) {
      const channel = this.#channels[name]
      if (channel !== undefined) this.#histories.set(name, new EveHistory(channel.history))
    }
    const stale: PlatformAccessory[] = []
    const bound: PlatformAccessory[] = []
    const energy: { accessory: PlatformAccessory; key: ChannelName }[] = []
    for (const accessory of this.#cache.values()) {
      const context = readContext(accessory)
      if (context === null || context.instanceKey !== instanceKey || !this.#wanted(config, context.kind) || (context.kind === 'energy' && context.key === undefined)) {
        stale.push(accessory)
        continue
      }
      if (context.kind === 'energy') {
        if (context.key !== undefined) energy.push({ accessory, key: context.key })
        bound.push(accessory)
        continue
      }
      this.#presenters.set(context.kind, this.#present(config, context.kind, accessory, instanceKey))
      bound.push(accessory)
    }
    if (state === null && energy.length > 0) this.log.warn(`${store.instancePath(instanceKey)}: not found; ${energy.length} cached energy accessories restart their Eve history at entry 1`)
    for (const { accessory, key } of energy) this.#energy.set(key, new EveEnergyAccessory(this.api.hap, accessory, key, instanceKey, this.#history(key), this.log))
    for (const accessory of [...stale, ...bound]) this.#cache.delete(accessory.UUID)
    if (stale.length > 0) this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale)
    if (bound.length > 0) this.api.updatePlatformAccessories(bound)
  }

  #bindMatter(config: Config, accountNumber: string | null): void {
    const matter = this.#matter
    if (matter === null) {
      if (config.matterEnergy) this.log.error('matterEnergy is true and Matter is not enabled on this bridge: no Matter accessory is registered')
      return
    }
    const instanceKey = accountNumber === null ? null : instanceKeyOf(accountNumber, config.nmi)
    matter.bind(instanceKey, this.#channelsAtStart, config.matterEnergy, (key) => {
      if (accountNumber === null) throw new Error(`Matter name for ${key} without an account number`)
      return matterName(this.#firstInstance, accountNumber, config.nmi, key)
    })
  }

  #history(key: ChannelName): EveHistory {
    const known = this.#histories.get(key)
    if (known !== undefined) return known
    const history = new EveHistory(emptyHistoryState(HISTORY_MEMORY_SIZE))
    this.#histories.set(key, history)
    return history
  }

  #signalsChanged(signals: Signals): void {
    const config = this.#config
    const instance = this.#instance
    if (config === null || instance === null) return
    if (signals.account.status === 'ok') this.#ensureAccessories(config, instance)
    this.#matter?.confirm().then(undefined, (error: unknown) => logThrown(this.log, 'Matter confirmation', error))
    if (signals.energy.status === 'ok') {
      const fetchedAt = instance.snapshots.usageHalfHourly.fetchedAt
      if (this.#instanceKey !== null && fetchedAt !== null && fetchedAt !== this.#usageFetchedAt) {
        this.#usageFetchedAt = fetchedAt
        this.#energySynced(config, instance, signals.energy)
      }
    } else if (this.#energyOk) {
      for (const key of CHANNEL_NAMES) this.#matter?.pushNull(key)
    }
    this.#energyOk = signals.energy.status === 'ok'
    for (const presenter of this.#presenters.values()) presenter.publish(signals)
    for (const [key, accessory] of this.#energy) accessory.publish(this.#energyOk ? (this.#channels[key]?.totalKwh ?? null) : null)
    this.#logAccountSync(instance, signals)
  }

  #energySynced(config: Config, instance: Instance, energy: EnergyOk): void {
    const store = this.#store
    const instanceKey = this.#instanceKey
    if (store === null || instanceKey === null) throw new Error('energy group is ok before the instance is bound')
    const taken = new Map<ChannelName, Advance>()
    const appeared: ChannelName[] = []
    for (const name of CHANNEL_NAMES) {
      const prior = this.#channels[name]
      const result = advance(prior ?? emptyLedger(), energy.intervals, CHANNEL_PICKS[name])
      if (!channelExists(name, result.channel)) continue
      const history = this.#history(name)
      for (const entry of result.entries) history.add(entry.time, entry.deciwatts)
      this.#channels[name] = { ...result.channel, history: history.state }
      if (result.overflow.length > 0) this.log.warn(overflowLine(name, result.overflow))
      if (prior === undefined) appeared.push(name)
      taken.set(name, result)
    }
    const channels: InstanceState['channels'] = {}
    for (const name of CHANNEL_NAMES) {
      const channel = this.#channels[name]
      if (channel !== undefined) channels[name] = channelRecord(channel)
    }
    const state: InstanceState = { version: STATE_VERSION, instanceKey, channels }
    store.writeInstance(state)
    this.#instanceState = state
    if (config.eveHistory) this.#ensureEnergyAccessories(config, instance, instanceKey)
    for (const accessory of this.#energy.values()) accessory.historyChanged()
    const matter = this.#matter
    if (matter === null || !config.matterEnergy) return
    for (const [name, result] of taken) {
      if (!this.#channelsAtStart.has(name)) {
        if (appeared.includes(name)) matter.channelAppeared(name)
        continue
      }
      const through = result.channel.through
      if (through === null) continue
      matter.push(name, { totalKwh: result.channel.totalKwh, through }, result.taken).then(undefined, (error: unknown) => logThrown(this.log, `${name}: Matter push`, error))
    }
  }

  #ensureEnergyAccessories(config: Config, instance: Instance, instanceKey: string): void {
    const accountNumber = instance.accountNumber
    if (accountNumber === null) throw new Error('energy group is ok and the instance has no account number')
    const device = deviceName(this.#firstInstance, accountNumber, config.nmi)
    const created: PlatformAccessory[] = []
    for (const key of CHANNEL_NAMES) {
      if (this.#channels[key] === undefined || this.#energy.has(key)) continue
      const accessory = new this.api.platformAccessory(accessoryName(device, CHANNEL_IDENTITIES[key]), this.api.hap.uuid.generate(uuidSeed(instanceKey, key)))
      const context: AccessoryContext = { schema: CONTEXT_SCHEMA, instanceKey, kind: 'energy', key }
      accessory.context = context
      this.#energy.set(key, new EveEnergyAccessory(this.api.hap, accessory, key, instanceKey, this.#history(key), this.log))
      created.push(accessory)
    }
    if (created.length > 0) this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, created)
  }

  #ensureAccessories(config: Config, instance: Instance): void {
    const accountNumber = instance.accountNumber
    if (accountNumber === null) throw new Error('account group is ok and the instance has no account number')
    const store = this.#store
    if (store === null) throw new Error('account group is ok before the state store exists')
    if (this.#instanceKey === null) this.#bind(config, store, accountNumber)
    const instanceKey = instanceKeyOf(accountNumber, config.nmi)
    if (this.#instanceKey !== instanceKey) throw new Error(`instanceKey ${JSON.stringify(instanceKey)} differs from the bound ${JSON.stringify(this.#instanceKey)}`)
    const device = deviceName(this.#firstInstance, accountNumber, config.nmi)
    const created: PlatformAccessory[] = []
    for (const kind of HAP_ACCESSORY_KINDS) {
      if (!this.#wanted(config, kind) || this.#presenters.has(kind)) continue
      const identity = ACCESSORY_IDENTITIES[kind]
      const accessory = new this.api.platformAccessory(accessoryName(device, identity), this.api.hap.uuid.generate(uuidSeed(instanceKey, kind)))
      const context: AccessoryContext = { schema: CONTEXT_SCHEMA, instanceKey, kind }
      accessory.context = context
      this.#presenters.set(kind, this.#present(config, kind, accessory, instanceKey))
      created.push(accessory)
    }
    if (created.length > 0) this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, created)
  }

  #logAccountSync(instance: Instance, signals: Signals): void {
    const { account, tokens } = instance.snapshots
    if (account.fetchedAt !== null && account.fetchedAt !== this.#accountFetchedAt) {
      this.#accountFetchedAt = account.fetchedAt
      const remaining = instance.dailyLimitRemaining
      if (remaining !== null) this.log.info(dailyLimitLine(remaining))
    }
    if (tokens.fetchedAt !== null && tokens.fetchedAt !== this.#tokensFetchedAt) {
      this.#tokensFetchedAt = tokens.fetchedAt
      if (signals.account.status === 'ok' && signals.account.tokenExpiringSoon === true) this.log.warn(tokenExpiringLine(signals.account))
    }
  }
}

const PRODUCTION: PlatformEnvironment<ReturnType<typeof setTimeout>> = {
  createTransport: (token) => new ApiClient({ baseUrl: BASE_URL, token, httpTimeoutS: HTTP_TIMEOUT_S, waitHttpTimeoutS: WAIT_HTTP_TIMEOUT_S }),
  timers: systemTimers,
}

export class FlippedEnergyPlatform extends Platform<ReturnType<typeof setTimeout>> {
  constructor(log: Logging, config: PlatformConfig, api: API) {
    super(log, config, api, PRODUCTION)
  }
}
