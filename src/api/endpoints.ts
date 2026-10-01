import { MS_PER_DAY, USAGE_LOOKBACK_DAYS, WAIT_TIMEOUT_S } from '../core/constants.ts'
import { nextDate, toLocal } from '../core/time.ts'

export type EndpointId = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7'

export interface ApiRequest {
  readonly endpoint: EndpointId
  readonly path: string
  readonly query: Readonly<Record<string, string>>
}

export interface UsageWindow {
  readonly start: string
  readonly end: string
}

export const PATHS: Readonly<Record<EndpointId, string>> = {
  E1: '/api/MyAccount/GetAccountData',
  E2: '/api/Live/nempricing/outlook',
  E3: '/api/Live/nempricing/wait',
  E4: '/api/Usage/usage/projectreads/halfhourly',
  E5: '/api/Usage/usage/projectreads/daily',
  E6: '/api/Billing/meters',
  E7: '/tokens',
}

const NEM_OFFSET_MS = 10 * 3600 * 1000
const LOCAL_MIDNIGHT = 'T00:00:00'

export function nemWallClock(instantMs: number): string {
  return new Date(instantMs + NEM_OFFSET_MS).toISOString().slice(0, 19)
}

function daysBefore(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * MS_PER_DAY).toISOString().slice(0, 10)
}

export function usageWindow(nowMs: number, zone: string): UsageWindow {
  const today = toLocal(nowMs, zone).date
  return { start: `${daysBefore(today, USAGE_LOOKBACK_DAYS)}${LOCAL_MIDNIGHT}`, end: `${nextDate(today)}${LOCAL_MIDNIGHT}` }
}

export function accountData(): ApiRequest {
  return { endpoint: 'E1', path: PATHS.E1, query: {} }
}

export function outlook(region: string): ApiRequest {
  return { endpoint: 'E2', path: PATHS.E2, query: { region } }
}

export function wait(region: string, sinceMs: number): ApiRequest {
  return { endpoint: 'E3', path: PATHS.E3, query: { region, since: nemWallClock(sinceMs), timeoutSeconds: String(WAIT_TIMEOUT_S) } }
}

export function usageHalfHourly(window: UsageWindow, nmi: string): ApiRequest {
  return { endpoint: 'E4', path: PATHS.E4, query: { start: window.start, end: window.end, nmi } }
}

export function usageDaily(window: UsageWindow, nmi: string): ApiRequest {
  return { endpoint: 'E5', path: PATHS.E5, query: { start: window.start, end: window.end, nmi } }
}

export function meters(): ApiRequest {
  return { endpoint: 'E6', path: PATHS.E6, query: {} }
}

export function tokens(): ApiRequest {
  return { endpoint: 'E7', path: PATHS.E7, query: {} }
}

export function requestUrl(baseUrl: string, request: ApiRequest): URL {
  const url = new URL(`${baseUrl}${request.path}`)
  for (const [key, value] of Object.entries(request.query)) url.searchParams.append(key, value)
  return url
}
