import { accountData, meters, tokens, usageDaily, usageHalfHourly, usageWindow } from '../api/endpoints.ts'
import { ACCOUNT_SYNC_LOCAL_TIME, MS_PER_DAY, USAGE_SYNC_LOCAL_TIME } from '../core/constants.ts'
import { localToInstant, nextDate, toLocal, wallAsUtc } from '../core/time.ts'
import { nextBoundary } from './priceLoop.ts'
import type { Answer, Exchanged, RequestGate } from './requestGate.ts'
import type { ArmedTimer, Scheduler } from './scheduler.ts'

export interface AccountTarget {
  region: string | null
  zone: string | null
}

export interface UsageTarget {
  nmi: string
  zone: string
}

export interface SyncHost {
  readonly gate: RequestGate
  readonly scheduler: Scheduler
  accountTarget(): AccountTarget
  usageTarget(): UsageTarget | null
  accountPartFailed(): boolean
  startPriceLoop(region: string): void
  routineFailed(error: unknown): void
}

export function nextLocalTime(instantMs: number, zone: string, time: string): number {
  let date = toLocal(instantMs, zone).date
  for (;;) {
    const candidate = localToInstant(`${date}T${time}`, zone)
    if (candidate > instantMs) return candidate
    date = nextDate(date)
  }
}

export function nextUtcTime(instantMs: number, time: string): number {
  const today = new Date(Math.floor(instantMs / MS_PER_DAY) * MS_PER_DAY).toISOString().slice(0, 10)
  const candidate = wallAsUtc(`${today}T${time}`)
  return candidate > instantMs ? candidate : candidate + MS_PER_DAY
}

export class Sync {
  readonly #host: SyncHost
  #accountTimer: ArmedTimer | null = null
  #usageTimer: ArmedTimer | null = null
  #startupTimer: ArmedTimer | null = null
  #zone: string | null = null

  constructor(host: SyncHost) {
    this.#host = host
  }

  start(): void {
    this.#launch(this.#startup())
  }

  cancelTimers(): void {
    for (const timer of [this.#accountTimer, this.#usageTimer, this.#startupTimer]) timer?.cancel()
    this.#accountTimer = null
    this.#usageTimer = null
    this.#startupTimer = null
  }

  #launch(routine: Promise<void>): void {
    routine.then(undefined, (error: unknown) => this.#host.routineFailed(error))
  }

  async #startup(): Promise<void> {
    const first = await this.#begin()
    if (first.kind === 'refused') return
    if (first.answer.kind === 'body') {
      await this.#startLoops()
      return
    }
    this.#retryStartup(first.answer)
  }

  #retryStartup(answer: Answer): void {
    if (answer.kind !== 'failed') throw new Error(`start-up: E1 answered ${answer.kind}`)
    if (answer.stop === 'gatewayUnauthorized' || answer.stop === 'disabled') return
    const now = this.#host.scheduler.now()
    const target = answer.stop === 'refused' ? nextUtcTime(now, ACCOUNT_SYNC_LOCAL_TIME) : nextBoundary(now)
    this.#startupTimer = this.#host.scheduler.armAt('startup', target, () => {
      this.#startupTimer = null
      this.#launch(this.#startup())
    })
  }

  #begin(): Promise<Exchanged> {
    const { gate } = this.#host
    return gate.session(async (send) => {
      const first = await send(accountData(), 'accountProbe')
      if (first.kind === 'answered' && first.answer.kind === 'body') {
        if (gate.mode === 'accountSyncOnly') gate.resume()
        this.#armSyncPoints()
        await send(meters(), 'normal')
        await send(tokens(), 'normal')
      }
      return first
    })
  }

  async #startLoops(): Promise<void> {
    if (this.#host.gate.mode !== 'running') return
    const { region } = this.#host.accountTarget()
    if (region !== null) this.#host.startPriceLoop(region)
    await this.#usagePart()
  }

  async #accountPart(): Promise<void> {
    await this.#host.gate.session(async (send) => {
      await send(accountData(), 'normal')
      await send(meters(), 'normal')
      await send(tokens(), 'normal')
    })
  }

  async #usagePart(): Promise<void> {
    const target = this.#host.usageTarget()
    if (target === null) return
    await this.#host.gate.session(async (send) => {
      const window = usageWindow(this.#host.scheduler.now(), target.zone)
      await send(usageHalfHourly(window, target.nmi), 'normal')
      await send(usageDaily(window, target.nmi), 'normal')
    })
  }

  #armSyncPoints(): void {
    const { zone } = this.#host.accountTarget()
    if (zone !== null) this.#zone = zone
    if (this.#zone === null) return
    if (this.#accountTimer === null) this.#armAccountSync(this.#zone)
    if (this.#usageTimer === null) this.#armUsageSync(this.#zone)
  }

  #armAccountSync(zone: string): void {
    const target = nextLocalTime(this.#host.scheduler.now(), zone, ACCOUNT_SYNC_LOCAL_TIME)
    this.#accountTimer = this.#host.scheduler.armAt('accountSync', target, () => {
      this.#accountTimer = null
      this.#armSyncPoints()
      this.#launch(this.#accountSync())
    })
  }

  #armUsageSync(zone: string): void {
    const target = nextLocalTime(this.#host.scheduler.now(), zone, USAGE_SYNC_LOCAL_TIME)
    this.#usageTimer = this.#host.scheduler.armAt('usageSync', target, () => {
      this.#usageTimer = null
      this.#armSyncPoints()
      this.#launch(this.#usageSync())
    })
  }

  async #accountSync(): Promise<void> {
    const { mode } = this.#host.gate
    if (mode === 'stopped') return
    if (mode === 'accountSyncOnly') {
      const first = await this.#begin()
      if (first.kind === 'answered' && first.answer.kind === 'body') await this.#startLoops()
      return
    }
    await this.#accountPart()
    if (this.#host.gate.mode !== 'running') return
    await this.#usagePart()
  }

  async #usageSync(): Promise<void> {
    if (this.#host.gate.mode !== 'running') return
    if (this.#host.accountPartFailed()) await this.#accountPart()
    if (this.#host.gate.mode !== 'running') return
    await this.#usagePart()
  }
}
