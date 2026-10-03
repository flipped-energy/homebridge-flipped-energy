import { isDeepStrictEqual } from 'node:util'
import type { ApiResult } from '../api/client.ts'
import type { ApiRequest, EndpointId } from '../api/endpoints.ts'
import { tokenPreview } from '../config.ts'
import { selectAccount } from '../core/account.ts'
import { computeSignals } from '../core/computeSignals.ts'
import { usageSource } from '../core/energy.ts'
import { formatInstant, parseInstant, zoneError } from '../core/time.ts'
import { type Fault, type SignalConfig, type Signals, type Snapshot, type SnapshotError, InvalidResponse, readNullableString } from '../core/types.ts'
import { PriceLoop } from './priceLoop.ts'
import { type Answer, type GateMode, type RuntimeLog, type Transport, RequestGate } from './requestGate.ts'
import type { ArmedTimer, Scheduler } from './scheduler.ts'
import { instanceKeyOf, type StateStore } from './stateStore.ts'
import { type AccountTarget, type UsageTarget, Sync } from './sync.ts'

export interface InstanceConfig {
  token: string
  accountNumber: string | null
  nmi: string | null
  priceHighThresholdCentsPerKwh: number | null
  priceLowThresholdCentsPerKwh: number | null
}

export interface InstanceDeps {
  config: InstanceConfig
  transport: Transport
  scheduler: Scheduler
  store: StateStore
  log: RuntimeLog
  signalsChanged(signals: Signals): void
  routineFailed(error: unknown): void
}

export type SnapshotName = 'account' | 'meters' | 'tokens' | 'outlook' | 'usageHalfHourly' | 'usageDaily'

export type Snapshots = Record<SnapshotName, Snapshot>

export const SNAPSHOT_OF: Readonly<Record<EndpointId, SnapshotName>> = {
  E1: 'account',
  E2: 'outlook',
  E3: 'outlook',
  E4: 'usageHalfHourly',
  E5: 'usageDaily',
  E6: 'meters',
  E7: 'tokens',
}

const GROUPS = ['account', 'tariff', 'price', 'energy'] as const

const ACCOUNT_PART: readonly SnapshotName[] = ['account', 'meters', 'tokens']

const DAILY_LIMIT_REMAINING = 'x-dailylimit-remaining'

function emptySnapshot(): Snapshot {
  return { fetchedAt: null, error: null, body: null }
}

function faultLine(group: string, fault: Fault): string {
  const status = fault.httpStatus === undefined ? '' : ` HTTP ${fault.httpStatus}`
  const message = fault.message === undefined ? '' : ` ${fault.message}`
  return `${group}: ${fault.code}${status}${message}`
}

export class Instance {
  readonly #deps: InstanceDeps
  readonly #gate: RequestGate
  readonly #sync: Sync
  readonly #snapshots: Snapshots = {
    account: emptySnapshot(),
    meters: emptySnapshot(),
    tokens: emptySnapshot(),
    outlook: emptySnapshot(),
    usageHalfHourly: emptySnapshot(),
    usageDaily: emptySnapshot(),
  }
  #accountNumber: string | null
  #signals: Signals
  #evaluation: ArmedTimer | null = null
  #priceLoop: PriceLoop | null = null
  #dailyLimitRemaining: number | null = null
  #stopped = false
  historyStart: string | undefined

  constructor(deps: InstanceDeps) {
    this.#deps = deps
    this.#accountNumber = deps.config.accountNumber === null ? deps.store.readPin() : deps.config.accountNumber
    this.#signals = this.#compute()
    this.#gate = new RequestGate({
      transport: deps.transport,
      scheduler: deps.scheduler,
      log: deps.log,
      hooks: {
        answered: (request, answer, result) => this.#answered(request, answer, result),
        modeChanged: (mode) => this.#modeChanged(mode),
      },
    })
    this.#sync = new Sync({
      gate: this.#gate,
      scheduler: deps.scheduler,
      accountTarget: () => this.#accountTarget(),
      usageTarget: () => this.#usageTarget(),
      accountPartFailed: () => ACCOUNT_PART.some((name) => this.#snapshots[name].error !== null || this.#snapshots[name].body === null),
      startPriceLoop: (region) => this.#startPriceLoop(region),
      routineFailed: (error) => deps.routineFailed(error),
    })
  }

  get signals(): Signals {
    return this.#signals
  }

  get accountNumber(): string | null {
    return this.#accountNumber
  }

  get dailyLimitRemaining(): number | null {
    return this.#dailyLimitRemaining
  }

  get mode(): GateMode {
    return this.#gate.mode
  }

  get snapshots(): Readonly<Snapshots> {
    return this.#snapshots
  }

  get priceLoop(): PriceLoop | null {
    return this.#priceLoop
  }

  start(): void {
    if (this.#stopped) throw new Error('instance: start after stop')
    this.#sync.start()
  }

  stop(): void {
    this.#stopped = true
    this.#gate.close()
    this.#priceLoop?.stop()
    this.#priceLoop = null
    this.#sync.cancelTimers()
    this.#evaluation?.cancel()
    this.#evaluation = null
  }

  recompute(): void {
    const previous = this.#signals
    const next = this.#compute()
    this.#signals = next
    if (this.#accountNumber === null && next.account.status === 'ok') {
      this.#deps.store.writePin(next.account.accountNumber)
      this.#accountNumber = next.account.accountNumber
      this.#deps.log.info(`${this.#deps.store.pinPath}: accountNumber ${next.account.accountNumber}`)
    }
    this.#logTransitions(previous, next)
    this.#deps.signalsChanged(next)
    this.#armEvaluation(next.nextEvaluation)
  }

  #signalConfig(): SignalConfig {
    const { config } = this.#deps
    return {
      accountNumber: this.#accountNumber,
      nmi: config.nmi,
      tokenPreview: tokenPreview(config.token),
      priceHighThresholdCentsPerKwh: config.priceHighThresholdCentsPerKwh,
      priceLowThresholdCentsPerKwh: config.priceLowThresholdCentsPerKwh,
    }
  }

  #compute(): Signals {
    const s = this.#snapshots
    const instant = formatInstant(this.#deps.scheduler.now())
    return computeSignals(instant, this.#signalConfig(), s.account, s.meters, s.tokens, s.outlook, s.usageHalfHourly, s.usageDaily)
  }

  #armEvaluation(nextEvaluation: string | null): void {
    const targetMs = nextEvaluation === null ? null : parseInstant(nextEvaluation)
    if (nextEvaluation !== null && targetMs === null) throw new Error(`nextEvaluation is not an instant: ${nextEvaluation}`)
    if (this.#evaluation !== null && this.#evaluation.targetMs === targetMs) return
    this.#evaluation?.cancel()
    this.#evaluation = null
    if (targetMs === null || this.#stopped) return
    this.#evaluation = this.#deps.scheduler.armAt('evaluation', targetMs, () => {
      this.#evaluation = null
      this.recompute()
    })
  }

  #logTransitions(previous: Signals, next: Signals): void {
    for (const group of GROUPS) {
      const before = previous[group].fault
      const after = next[group].fault
      if (after === null) {
        if (before !== null) this.#deps.log.info(`${group}: ok`)
        continue
      }
      if (before !== null && isDeepStrictEqual(before, after)) continue
      this.#deps.log.error(faultLine(group, after))
    }
  }

  #record(name: SnapshotName, snapshot: Snapshot): void {
    this.#snapshots[name] = snapshot
  }

  #succeeded(name: SnapshotName, body: unknown): void {
    this.#record(name, { fetchedAt: formatInstant(this.#deps.scheduler.now()), error: null, body })
  }

  #failed(name: SnapshotName, error: SnapshotError): void {
    this.#record(name, { ...this.#snapshots[name], error })
  }

  #answered(request: ApiRequest, answer: Answer, result: ApiResult): void {
    const name = SNAPSHOT_OF[request.endpoint]
    if (answer.kind === 'failed') this.#failed(name, answer.error)
    if (answer.kind === 'body' && request.endpoint !== 'E3') this.#succeeded(name, answer.body)
    if (result.kind === 'ok') {
      const remaining = result.headers.get(DAILY_LIMIT_REMAINING)
      if (remaining !== null && /^[0-9]+$/.test(remaining)) this.#dailyLimitRemaining = Number(remaining)
    }
    this.recompute()
  }

  #outlookFailed(error: SnapshotError): void {
    this.#failed('outlook', error)
    this.recompute()
  }

  #modeChanged(mode: GateMode): void {
    if (mode === 'running') return
    this.#priceLoop?.stop()
    this.#priceLoop = null
    if (mode === 'stopped') this.#sync.cancelTimers()
  }

  #startPriceLoop(region: string): void {
    this.#priceLoop?.stop()
    const loop = new PriceLoop(
      {
        gate: this.#gate,
        scheduler: this.#deps.scheduler,
        log: this.#deps.log,
        outlookFailed: (error) => this.#outlookFailed(error),
      },
      region,
    )
    this.#priceLoop = loop
    loop.run().then(undefined, (error: unknown) => this.#deps.routineFailed(error))
  }

  #accountTarget(): AccountTarget {
    const body = this.#snapshots.account.body
    if (body === null) return { region: null, zone: null }
    try {
      const selection = selectAccount(body, this.#signalConfig())
      if ('fault' in selection) return { region: null, zone: null }
      const { product } = selection.selected
      const region = readNullableString(product.gridType, 'product.gridType')
      const zone = readNullableString(product.timeZone, 'product.timeZone')
      return { region, zone: zone !== null && zoneError(zone) === null ? zone : null }
    } catch (error) {
      if (error instanceof InvalidResponse) return { region: null, zone: null }
      throw error
    }
  }

  #usageTarget(): UsageTarget | null {
    const s = this.#snapshots
    const source = usageSource(this.#signalConfig(), s.account, s.meters)
    if ('fault' in source) return null
    const selection = selectAccount(s.account.body, this.#signalConfig())
    if ('fault' in selection) return null
    const startDate = readNullableString(selection.selected.account.startDate, 'account.startDate')
    const key = instanceKeyOf(selection.selected.accountNumber, this.#deps.config.nmi)
    const stored = this.#deps.store.readInstance(key)
    this.historyStart = startDate !== null && stored?.historyStart !== startDate ? startDate : undefined
    return this.historyStart === undefined ? source : { ...source, startDate: this.historyStart }
  }
}
