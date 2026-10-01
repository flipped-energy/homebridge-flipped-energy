import { type ApiRequest, nemWallClock, outlook, wait } from '../api/endpoints.ts'
import { DISPATCH_INTERVAL_S, MS_PER_SECOND, WAIT_HOLDS_PER_INTERVAL } from '../core/constants.ts'
import { parseInstant } from '../core/time.ts'
import { type SnapshotError, InvalidResponse, isRecord, readRecord, readString } from '../core/types.ts'
import type { Exchanged, RequestGate, RuntimeLog } from './requestGate.ts'
import type { Scheduler } from './scheduler.ts'

export const DISPATCH_INTERVAL_MS = DISPATCH_INTERVAL_S * MS_PER_SECOND

export function boundary(instantMs: number): number {
  return Math.floor(instantMs / DISPATCH_INTERVAL_MS) * DISPATCH_INTERVAL_MS
}

export function nextBoundary(instantMs: number): number {
  return boundary(instantMs) + DISPATCH_INTERVAL_MS
}

export interface PriceLoopHost {
  readonly gate: RequestGate
  readonly scheduler: Scheduler
  readonly log: RuntimeLog
  outlookFailed(error: SnapshotError): void
}

export type PriceLoopState = 'bootstrap' | 'arm' | 'hold' | 'outlook'

function outlookTime(body: unknown): number | null {
  if (!isRecord(body) || !isRecord(body.now) || typeof body.now.time !== 'string') return null
  return parseInstant(body.now.time)
}

function pointTimes(body: unknown[]): number[] {
  return body.map((element, index) => {
    const point = readRecord(element, `wait[${index}]`)
    const text = readString(point.time, `wait[${index}].time`)
    const parsed = parseInstant(text)
    if (parsed === null) throw new InvalidResponse(`wait[${index}].time: not an ISO-8601 date-time with offset: ${JSON.stringify(text)}`)
    return parsed
  })
}

export class PriceLoop {
  readonly #host: PriceLoopHost
  readonly #region: string
  readonly #stopped = new AbortController()
  readonly #holdStarts: number[] = []
  #since: number | null = null
  #state: PriceLoopState = 'bootstrap'

  constructor(host: PriceLoopHost, region: string) {
    this.#host = host
    this.#region = region
  }

  get region(): string {
    return this.#region
  }

  get state(): PriceLoopState {
    return this.#state
  }

  get since(): number | null {
    return this.#since
  }

  stop(): void {
    this.#stopped.abort()
  }

  async run(): Promise<void> {
    while (!this.#stopped.signal.aborted) {
      const next = await this.#step(this.#state)
      if (next === null) return
      this.#state = next
    }
  }

  holdsAt(instantMs: number): number {
    const start = boundary(instantMs)
    return this.#holdStarts.filter((sentAtMs) => sentAtMs >= start && sentAtMs < start + DISPATCH_INTERVAL_MS).length
  }

  #step(state: PriceLoopState): Promise<PriceLoopState | null> {
    if (state === 'bootstrap') return this.#bootstrap()
    if (state === 'arm') return this.#arm()
    if (state === 'hold') return this.#hold()
    return this.#outlook()
  }

  #exchange(request: ApiRequest): Promise<Exchanged> {
    return this.#host.gate.session((send) => send(request, 'normal'))
  }

  async #untilNextBoundary(then: PriceLoopState): Promise<PriceLoopState | null> {
    const reached = await this.#host.scheduler.until('price', nextBoundary(this.#host.scheduler.now()), this.#stopped.signal)
    return reached ? then : null
  }

  #heldSince(): number {
    if (this.#since === null) throw new Error(`price loop ${this.#state}: no interval start held`)
    return this.#since
  }

  async #bootstrap(): Promise<PriceLoopState | null> {
    const exchanged = await this.#exchange(outlook(this.#region))
    if (exchanged.kind === 'refused') return null
    const { answer } = exchanged
    if (answer.kind === 'failed' && answer.stop !== null) return null
    if (answer.kind === 'body') {
      const time = outlookTime(answer.body)
      if (time !== null) {
        this.#since = time
        return 'arm'
      }
    }
    return this.#untilNextBoundary('bootstrap')
  }

  async #arm(): Promise<PriceLoopState | null> {
    const target = this.#heldSince() + DISPATCH_INTERVAL_MS
    if (target <= this.#host.scheduler.now()) return 'hold'
    const reached = await this.#host.scheduler.until('price', target, this.#stopped.signal)
    return reached ? 'hold' : null
  }

  async #hold(): Promise<PriceLoopState | null> {
    if (this.holdsAt(this.#host.scheduler.now()) >= WAIT_HOLDS_PER_INTERVAL) return this.#untilNextBoundary('hold')
    const since = this.#heldSince()
    const exchanged = await this.#exchange(wait(this.#region, since))
    if (exchanged.kind === 'refused') return null
    const current = boundary(exchanged.sentAtMs)
    const kept = this.#holdStarts.filter((sentAtMs) => sentAtMs >= current)
    this.#holdStarts.splice(0, this.#holdStarts.length, ...kept, exchanged.sentAtMs)
    const { answer } = exchanged
    if (answer.kind === 'noContent') return 'hold'
    if (answer.kind === 'failed') return answer.stop === null ? this.#untilNextBoundary('hold') : null
    if (!Array.isArray(answer.body)) throw new Error('price loop: wait body is not an array after validation')
    let times: number[]
    try {
      times = pointTimes(answer.body)
    } catch (error) {
      if (!(error instanceof InvalidResponse)) throw error
      this.#host.log.error(`GET ${wait(this.#region, since).path}: ${error.message}`)
      this.#host.outlookFailed({ kind: 'invalid', message: error.message })
      return this.#untilNextBoundary('hold')
    }
    const newer = times.filter((time) => time > since)
    if (newer.length === 0) {
      const message = `wait_no_progress: HTTP 200 with ${times.length} points, none after since=${nemWallClock(since)}`
      this.#host.log.error(message)
      this.#host.outlookFailed({ kind: 'invalid', message })
      this.#since = since + DISPATCH_INTERVAL_MS
      return 'arm'
    }
    this.#since = Math.max(...newer)
    return 'outlook'
  }

  async #outlook(): Promise<PriceLoopState | null> {
    const exchanged = await this.#exchange(outlook(this.#region))
    if (exchanged.kind === 'refused') return null
    const { answer } = exchanged
    if (answer.kind === 'failed' && answer.stop !== null) return null
    if (answer.kind === 'body') {
      const time = outlookTime(answer.body)
      if (time !== null) this.#since = Math.max(this.#heldSince(), time)
    }
    return 'arm'
  }
}
