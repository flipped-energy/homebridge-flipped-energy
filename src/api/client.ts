import { MS_PER_SECOND } from '../core/constants.ts'
import { PRODUCT_NAME } from '../settings.ts'
import { VERSION } from '../version.ts'
import { type ApiRequest, requestUrl } from './endpoints.ts'

export interface OkResult {
  kind: 'ok'
  status: number
  body: string
  headers: Headers
}

export interface NoContentResult {
  kind: 'noContent'
}

export interface HttpResult {
  kind: 'http'
  status: number
  body: string
  bodyBytes: number
  retryAfterS?: number
  retryAfterError?: string
  location?: string
}

export interface NetworkResult {
  kind: 'network'
  message: string
  error: unknown
}

export type ApiResult = OkResult | NoContentResult | HttpResult | NetworkResult

export interface ApiClientOptions {
  baseUrl: string
  token: string
  httpTimeoutS: number
  waitHttpTimeoutS: number
}

export const USER_AGENT = `${PRODUCT_NAME}/${VERSION}`

const RETRY_AFTER_PATTERN = /^[0-9]+$/
const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

function messageOf(error: Error): string {
  if (error.message === '' && error instanceof AggregateError) {
    return error.errors.map((inner: unknown) => (inner instanceof Error ? inner.message : String(inner))).join('\n')
  }
  return error.message
}

export function networkMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (!(error instanceof TypeError) || error.message !== 'fetch failed') return messageOf(error)
  let current: Error = error
  while (current.cause instanceof Error) current = current.cause
  return messageOf(current)
}

function readRetryAfter(result: HttpResult, value: string | null): void {
  if (value !== null && RETRY_AFTER_PATTERN.test(value)) {
    result.retryAfterS = Number(value)
    return
  }
  result.retryAfterError = `Retry-After: expected an integer number of seconds, got ${value === null ? 'missing' : JSON.stringify(value)}`
}

export function httpResult(status: number, headers: Headers, bytes: Uint8Array): HttpResult {
  const result: HttpResult = { kind: 'http', status, body: decoder.decode(bytes), bodyBytes: bytes.byteLength }
  if (status === 429) readRetryAfter(result, headers.get('retry-after'))
  const location = headers.get('location')
  if (status >= 300 && status < 400 && location !== null) result.location = location
  return result
}

async function failure(response: Response): Promise<HttpResult> {
  return httpResult(response.status, response.headers, new Uint8Array(await response.arrayBuffer()))
}

export class ApiClient {
  readonly baseUrl: string
  readonly #token: string
  readonly #httpTimeoutMs: number
  readonly #waitHttpTimeoutMs: number
  readonly #stopped = new AbortController()

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl
    this.#token = options.token
    this.#httpTimeoutMs = options.httpTimeoutS * MS_PER_SECOND
    this.#waitHttpTimeoutMs = options.waitHttpTimeoutS * MS_PER_SECOND
  }

  stop(): void {
    this.#stopped.abort()
  }

  async get(request: ApiRequest): Promise<ApiResult> {
    const timeoutMs = request.endpoint === 'E3' ? this.#waitHttpTimeoutMs : this.#httpTimeoutMs
    const url = requestUrl(this.baseUrl, request)
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.any([this.#stopped.signal, AbortSignal.timeout(timeoutMs)]),
        headers: { Authorization: `Bearer ${this.#token}`, Accept: '*/*', 'User-Agent': USER_AGENT },
      })
      if (response.status === 204) {
        await response.arrayBuffer()
        return { kind: 'noContent' }
      }
      if (response.status >= 200 && response.status < 300) {
        return { kind: 'ok', status: response.status, body: await response.text(), headers: response.headers }
      }
      return await failure(response)
    } catch (error: unknown) {
      return { kind: 'network', message: networkMessage(error), error }
    }
  }
}
