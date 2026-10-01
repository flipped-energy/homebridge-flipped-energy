import { type ApiResult, httpResult } from '../../src/api/client.ts'
import type { ApiRequest } from '../../src/api/endpoints.ts'
import { MS_PER_SECOND } from '../../src/core/constants.ts'
import type { Transport } from '../../src/runtime/requestGate.ts'
import type { FakeClock } from './fakeClock.ts'

export interface HttpAnswer {
  status: number
  headers: Record<string, string>
  body: unknown
}

export interface NetworkAnswer {
  network: string
}

export interface ScriptedResponse {
  method: string
  path: string
  query: Record<string, string>
  answer: HttpAnswer | NetworkAnswer
  holdSeconds?: number
}

export interface SentRequest {
  sendAtMs: number
  method: string
  path: string
  query: Record<string, string>
}

const NO_CONTENT = 204
const encoder = new TextEncoder()

function bodyText(body: unknown): string {
  return typeof body === 'string' ? body : JSON.stringify(body)
}

export function resultOf(answer: HttpAnswer | NetworkAnswer): ApiResult {
  if ('network' in answer) return { kind: 'network', message: answer.network, error: new Error(answer.network) }
  if (answer.status === NO_CONTENT) return { kind: 'noContent' }
  const headers = new Headers(answer.headers)
  const text = bodyText(answer.body)
  if (answer.status >= 200 && answer.status < 300) return { kind: 'ok', status: answer.status, body: text, headers }
  return httpResult(answer.status, headers, encoder.encode(text))
}

export class Script {
  readonly sent: SentRequest[] = []
  stops = 0
  readonly #clock: FakeClock
  readonly #responses: readonly ScriptedResponse[]
  #index = 0

  constructor(clock: FakeClock, responses: readonly ScriptedResponse[]) {
    this.#clock = clock
    this.#responses = responses
  }

  get answered(): number {
    return this.#index
  }

  transport(): Transport {
    return {
      get: (request) => this.#answer(request),
      stop: () => {
        this.stops += 1
      },
    }
  }

  #answer(request: ApiRequest): Promise<ApiResult> {
    this.sent.push({ sendAtMs: this.#clock.now(), method: 'GET', path: request.path, query: { ...request.query } })
    const scripted = this.#responses[this.#index]
    this.#index += 1
    if (scripted === undefined) return new Promise(() => undefined)
    const result = resultOf(scripted.answer)
    if (scripted.holdSeconds === undefined || scripted.holdSeconds === 0) return Promise.resolve(result)
    const holdMs = scripted.holdSeconds * MS_PER_SECOND
    return new Promise((resolve) => {
      this.#clock.setTimeout(() => resolve(result), holdMs)
    })
  }
}
