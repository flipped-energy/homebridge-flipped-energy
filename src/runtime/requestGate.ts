import { inspect } from 'node:util'
import type { ApiResult, HttpResult } from '../api/client.ts'
import type { ApiRequest, EndpointId } from '../api/endpoints.ts'
import { validateBody } from '../api/validate.ts'
import { MS_PER_SECOND } from '../core/constants.ts'
import { type JsonRecord, type SnapshotError, isRecord } from '../core/types.ts'
import type { Scheduler } from './scheduler.ts'

export interface Transport {
  get(request: ApiRequest): Promise<ApiResult>
  stop(): void
}

export interface RuntimeLog {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export type StopKind = 'gatewayUnauthorized' | 'refused' | 'disabled'

export type Answer =
  | { kind: 'body'; body: JsonRecord | unknown[] }
  | { kind: 'noContent' }
  | { kind: 'failed'; error: SnapshotError; stop: StopKind | null }

export type GateMode = 'running' | 'accountSyncOnly' | 'stopped'

export type Admission = 'normal' | 'accountProbe'

export type Exchanged = { kind: 'answered'; answer: Answer; sentAtMs: number } | { kind: 'refused' }

export type Send = (request: ApiRequest, admission: Admission) => Promise<Exchanged>

export interface GateHooks {
  answered(request: ApiRequest, answer: Answer, result: ApiResult): void
  modeChanged(mode: GateMode): void
}

export interface RequestGateOptions {
  transport: Transport
  scheduler: Scheduler
  log: RuntimeLog
  hooks: GateHooks
}

function jsonObject(text: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

function stopKind(result: HttpResult): StopKind | null {
  if (result.status === 401) return jsonObject(result.body)?.error === 'unauthorized' ? 'gatewayUnauthorized' : 'refused'
  if (result.status === 403) return 'refused'
  if (result.status === 400) return 'disabled'
  if (result.status === 404 && jsonObject(result.body)?.error === 'unknown_operation') return 'disabled'
  return null
}

export function classify(endpoint: EndpointId, result: ApiResult): Answer {
  if (result.kind === 'network') return { kind: 'failed', error: { kind: 'network', message: result.message }, stop: null }
  if (result.kind === 'http') {
    if (result.retryAfterError !== undefined) return { kind: 'failed', error: { kind: 'invalid', message: result.retryAfterError }, stop: null }
    return { kind: 'failed', error: { kind: 'http', status: result.status, body: result.body, bodyBytes: result.bodyBytes }, stop: stopKind(result) }
  }
  if (result.kind === 'noContent' && endpoint === 'E3') return { kind: 'noContent' }
  const validated = validateBody(endpoint, result)
  if (validated.kind === 'invalid') return { kind: 'failed', error: { kind: 'invalid', message: validated.message }, stop: null }
  return { kind: 'body', body: validated.body }
}

export function logAnswer(log: RuntimeLog, request: ApiRequest, result: ApiResult, answer: Answer): void {
  const line = `GET ${request.path}`
  if (result.kind === 'network') {
    log.error(line)
    log.error(inspect(result.error))
    return
  }
  if (result.kind === 'http') {
    log.error(`${line} -> HTTP ${result.status}, ${result.bodyBytes} bytes`)
    log.error(result.body)
    if (result.location !== undefined) log.error(`Location: ${result.location}`)
  }
  if (answer.kind === 'failed' && answer.error.kind === 'invalid') {
    log.error(`${line}: ${answer.error.message}`)
    return
  }
  if (result.kind === 'ok') log.debug(`${line} -> HTTP ${result.status}`)
  if (result.kind === 'noContent') log.debug(`${line} -> HTTP 204`)
}

export class RequestGate {
  readonly #transport: Transport
  readonly #scheduler: Scheduler
  readonly #log: RuntimeLog
  readonly #hooks: GateHooks
  readonly #disabled = new Set<EndpointId>()
  readonly #closed = new AbortController()
  readonly #waiters: (() => void)[] = []
  #mode: GateMode = 'running'
  #busy = false

  constructor(options: RequestGateOptions) {
    this.#transport = options.transport
    this.#scheduler = options.scheduler
    this.#log = options.log
    this.#hooks = options.hooks
  }

  get mode(): GateMode {
    return this.#mode
  }

  get closed(): boolean {
    return this.#closed.signal.aborted
  }

  resume(): void {
    if (this.#mode !== 'accountSyncOnly') throw new Error(`request gate: resume from ${this.#mode}`)
    this.#setMode('running')
  }

  close(): void {
    if (this.#closed.signal.aborted) return
    this.#closed.abort()
    for (const waiter of this.#waiters.splice(0)) waiter()
    this.#transport.stop()
  }

  async session<T>(body: (send: Send) => Promise<T>): Promise<T> {
    await this.#acquire()
    try {
      return await body(this.#send)
    } finally {
      this.#release()
    }
  }

  #acquire(): Promise<void> {
    if (!this.#busy) {
      this.#busy = true
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.#waiters.push(resolve)
    })
  }

  #release(): void {
    const next = this.#waiters.shift()
    if (next === undefined) this.#busy = false
    else next()
  }

  #admits(request: ApiRequest, admission: Admission): boolean {
    if (this.#closed.signal.aborted) return false
    if (this.#disabled.has(request.endpoint)) return false
    if (this.#mode === 'running') return true
    return this.#mode === 'accountSyncOnly' && admission === 'accountProbe'
  }

  #setMode(mode: GateMode): void {
    if (this.#mode === mode) return
    this.#mode = mode
    this.#hooks.modeChanged(mode)
  }

  #stop(endpoint: EndpointId, kind: StopKind): void {
    if (kind === 'disabled') {
      this.#disabled.add(endpoint)
      return
    }
    if (kind === 'gatewayUnauthorized') {
      this.#setMode('stopped')
      return
    }
    if (this.#mode !== 'stopped') this.#setMode('accountSyncOnly')
  }

  readonly #send: Send = async (request, admission) => {
    for (;;) {
      if (!this.#admits(request, admission)) return { kind: 'refused' }
      const sentAtMs = this.#scheduler.now()
      const result = await this.#transport.get(request)
      if (this.#closed.signal.aborted) return { kind: 'refused' }
      const answer = classify(request.endpoint, result)
      logAnswer(this.#log, request, result, answer)
      this.#hooks.answered(request, answer, result)
      if (result.kind === 'http' && result.status === 429 && result.retryAfterS !== undefined) {
        const reopened = await this.#scheduler.until('retryAfter', this.#scheduler.now() + result.retryAfterS * MS_PER_SECOND, this.#closed.signal)
        if (!reopened) return { kind: 'refused' }
        continue
      }
      if (answer.kind === 'failed' && answer.stop !== null) this.#stop(request.endpoint, answer.stop)
      return { kind: 'answered', answer, sentAtMs }
    }
  }
}
