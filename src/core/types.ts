export type FaultCode =
  | 'not_loaded'
  | 'clock_unsynced'
  | 'http_error'
  | 'network_error'
  | 'invalid_response'
  | 'account_none'
  | 'account_selection_required'
  | 'account_not_found'
  | 'account_not_supplied'
  | 'account_data_stale'
  | 'timezone_missing'
  | 'timezone_unsupported'
  | 'local_time_nonexistent'
  | 'plan_unavailable'
  | 'billing_unit_unsupported'
  | 'billing_unit_malformed'
  | 'billing_unit_overlap'
  | 'tariff_gap'
  | 'spot_direction_unknown'
  | 'region_missing'
  | 'price_stale'
  | 'nmi_selection_required'
  | 'nmi_not_found'
  | 'usage_timezone_ambiguous'

export interface Fault {
  code: FaultCode
  httpStatus?: number
  body?: string
  bodyBytes?: number
  message?: string
}

export type SnapshotError =
  | { kind: 'http'; status: number; body: string; bodyBytes?: number }
  | { kind: 'network'; message: string }
  | { kind: 'invalid'; message: string }

export interface Snapshot {
  fetchedAt: string | null
  error: SnapshotError | null
  body: unknown
}

export interface SignalConfig {
  accountNumber: string | null
  nmi: string | null
  tokenPreview: string | null
  priceHighThresholdCentsPerKwh: number | null
  priceLowThresholdCentsPerKwh: number | null
}

export interface AccountOk {
  status: 'ok'
  fault: null
  accountNumber: string
  accountState: string
  productName: string | null
  region: string | null
  timeZone: string | null
  tokenExpiresAt: string | null
  tokenScope: string | null
  tokenExpiringSoon: boolean | null
}

export interface AccountFaulted {
  status: 'faulted'
  fault: Fault
  accountNumber: null
  accountState: null
  productName: null
  region: null
  timeZone: null
  tokenExpiresAt: null
  tokenScope: null
  tokenExpiringSoon: null
}

export type AccountSignals = AccountOk | AccountFaulted

export type Band = 'anytime' | 'offPeak' | 'peak' | 'shoulder'
export type Structure = 'flat' | 'timeOfUse'

export interface Block {
  fromKwh: number
  toKwh: number | null
  rateCentsPerKwh: number
}

export interface Segment {
  band: Band
  name: string
  rateCentsPerKwh: number
  kwhLimit: number | null
  rateAfterLimitCentsPerKwh: number | null
  blocks: Block[]
  wholesaleLinked: boolean
  wholesaleCapCentsPerKwh: number | null
}

export interface Period extends Segment {
  start: string | null
  end: string | null
}

export interface ScheduleEntry extends Segment {
  startMinute: number
  endMinute: number
}

export interface TariffOk {
  status: 'ok'
  fault: null
  structure: Structure
  spotLinked: boolean
  peak: boolean
  offPeak: boolean
  period: Period
  nextChange: string | null
  schedule: ScheduleEntry[]
}

export interface TariffFaulted {
  status: 'faulted'
  fault: Fault
  structure: null
  spotLinked: null
  peak: null
  offPeak: null
  period: null
  nextChange: null
  schedule: null
}

export type TariffSignals = TariffOk | TariffFaulted

export type PriceTier = 'UnusuallyLow' | 'Normal' | 'Elevated' | 'Spike'

export interface ForecastPoint {
  start: string
  centsPerKwh: number
}

export interface Forecast {
  from: string
  to: string
  publishedAt: string
  minCentsPerKwh: number
  maxCentsPerKwh: number
  tier: PriceTier
  points: ForecastPoint[]
}

export interface PriceOk {
  status: 'ok'
  fault: null
  centsPerKwh: number
  intervalStart: string
  tier: PriceTier
  priceHigh: boolean
  priceLow: boolean
  negative: boolean
  forecast: { nextHour: Forecast | null; ahead: Forecast | null }
}

export interface PriceFaulted {
  status: 'faulted'
  fault: Fault
  centsPerKwh: null
  intervalStart: null
  tier: null
  priceHigh: null
  priceLow: null
  negative: null
  forecast: null
}

export type PriceSignals = PriceOk | PriceFaulted

export interface EnergyEntry {
  local: string
  start: string
  durationMinutes: number
  gridImportKwh: number
  controlledLoadKwh: number
  solarExportKwh: number
  costAud: number | null
  feedInCreditAud: number | null
}

export interface EnergyOk {
  status: 'ok'
  fault: null
  nmi: string
  intervals: EnergyEntry[]
  days: EnergyEntry[]
  latestIntervalEnd: string | null
}

export interface EnergyFaulted {
  status: 'faulted'
  fault: Fault
  nmi: null
  intervals: null
  days: null
  latestIntervalEnd: null
}

export type EnergySignals = EnergyOk | EnergyFaulted

export interface Signals {
  account: AccountSignals
  tariff: TariffSignals
  price: PriceSignals
  energy: EnergySignals
  nextEvaluation: string | null
}

export type JsonRecord = Record<string, unknown>

export class InvalidResponse extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidResponse'
  }
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  return value === undefined ? 'missing' : JSON.stringify(value)
}

export function readRecord(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) throw new InvalidResponse(`${field}: expected an object, got ${describe(value)}`)
  return value
}

export function readNullableRecord(value: unknown, field: string): JsonRecord | null {
  if (value === null || value === undefined) return null
  return readRecord(value, field)
}

export function readArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new InvalidResponse(`${field}: expected an array, got ${describe(value)}`)
  return value
}

export function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new InvalidResponse(`${field}: expected a string, got ${describe(value)}`)
  return value
}

export function readNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  return readString(value, field)
}

export function readNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new InvalidResponse(`${field}: expected a number, got ${describe(value)}`)
  return value
}

export function readNullableNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  return readNumber(value, field)
}

export function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new InvalidResponse(`${field}: expected a boolean, got ${describe(value)}`)
  return value
}

export function fault(code: FaultCode, message?: string): Fault {
  return message === undefined ? { code } : { code, message }
}

export function faultFromError(error: SnapshotError): Fault {
  if (error.kind === 'http') {
    const recorded: Fault = { code: 'http_error', httpStatus: error.status, body: error.body }
    if (error.bodyBytes !== undefined) recorded.bodyBytes = error.bodyBytes
    return recorded
  }
  if (error.kind === 'network') return { code: 'network_error', message: error.message }
  return { code: 'invalid_response', message: error.message }
}

export function noBodyFault(snapshot: Snapshot): Fault | null {
  if (snapshot.body !== null) return null
  return snapshot.error === null ? fault('not_loaded') : faultFromError(snapshot.error)
}

export function unusableFault(snapshot: Snapshot, aged: boolean, ageCode: FaultCode): Fault | null {
  if (snapshot.body !== null && !aged) return null
  if (snapshot.error !== null) return faultFromError(snapshot.error)
  if (snapshot.body === null) return fault('not_loaded')
  return fault(ageCode)
}
