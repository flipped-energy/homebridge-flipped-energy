import { MS_PER_SECOND, PRICE_STALE_AFTER_S, PRICE_TIERS } from './constants.ts'
import { selectAccount } from './account.ts'
import { formatInstant, parseInstant } from './time.ts'
import {
  type Fault,
  type Forecast,
  type PriceSignals,
  type PriceTier,
  type SignalConfig,
  type Snapshot,
  InvalidResponse,
  fault,
  faultFromError,
  noBodyFault,
  readArray,
  readNullableRecord,
  readNullableString,
  readNumber,
  readRecord,
  readString,
} from './types.ts'

export interface PriceResult {
  signals: PriceSignals
  intervalStartMs: number | null
}

interface Outlook {
  centsPerKwh: number
  intervalStartMs: number
  tier: PriceTier
  nextHour: Forecast | null
  ahead: Forecast | null
}

function faulted(reason: Fault): PriceResult {
  return {
    signals: {
      status: 'faulted',
      fault: reason,
      centsPerKwh: null,
      intervalStart: null,
      tier: null,
      priceHigh: null,
      priceLow: null,
      negative: null,
      forecast: null,
    },
    intervalStartMs: null,
  }
}

function isTier(value: string): value is PriceTier {
  return PRICE_TIERS.includes(value)
}

function readInstant(value: unknown, field: string): number {
  const text = readString(value, field)
  const parsed = parseInstant(text)
  if (parsed === null) throw new InvalidResponse(`${field}: not an ISO-8601 date-time with offset: ${JSON.stringify(text)}`)
  return parsed
}

function readTier(value: unknown, field: string): PriceTier {
  const assessment = readRecord(value, field)
  const tier = readString(assessment.tier, `${field}.tier`)
  if (!isTier(tier)) throw new InvalidResponse(`${field}.tier: not one of ${PRICE_TIERS.join(', ')}: ${JSON.stringify(tier)}`)
  return tier
}

function readForecast(root: Record<string, unknown>, key: 'nextHour' | 'ahead', peakKey: 'nextHourPeak' | 'aheadPeak'): Forecast | null {
  const forecast = readNullableRecord(root[key], `outlook.${key}`)
  if (forecast === null) return null
  const points = readArray(forecast.points, `outlook.${key}.points`)
  if (points.length === 0) return null
  return {
    from: formatInstant(readInstant(forecast.from, `outlook.${key}.from`)),
    to: formatInstant(readInstant(forecast.to, `outlook.${key}.to`)),
    publishedAt: formatInstant(readInstant(forecast.publishedAt, `outlook.${key}.publishedAt`)),
    minCentsPerKwh: readNumber(forecast.minCentsPerKwh, `outlook.${key}.minCentsPerKwh`),
    maxCentsPerKwh: readNumber(forecast.maxCentsPerKwh, `outlook.${key}.maxCentsPerKwh`),
    tier: readTier(root[peakKey], `outlook.${peakKey}`),
    points: points.map((element, index) => {
      const point = readRecord(element, `outlook.${key}.points[${index}]`)
      return {
        start: formatInstant(readInstant(point.time, `outlook.${key}.points[${index}].time`)),
        centsPerKwh: readNumber(point.averageCentsPerKwh, `outlook.${key}.points[${index}].averageCentsPerKwh`),
      }
    }),
  }
}

function readOutlook(body: unknown): Outlook {
  const root = readRecord(body, 'outlook')
  const now = readRecord(root.now, 'outlook.now')
  return {
    centsPerKwh: readNumber(now.averageCentsPerKwh, 'outlook.now.averageCentsPerKwh'),
    intervalStartMs: readInstant(now.time, 'outlook.now.time'),
    tier: readTier(root.nowAssessment, 'outlook.nowAssessment'),
    nextHour: readForecast(root, 'nextHour', 'nextHourPeak'),
    ahead: readForecast(root, 'ahead', 'aheadPeak'),
  }
}

function computePrice(instantMs: number, config: SignalConfig, account: Snapshot, outlook: Snapshot): PriceResult {
  const missingAccount = noBodyFault(account)
  if (missingAccount !== null) return faulted(missingAccount)
  const selection = selectAccount(account.body, config)
  if ('fault' in selection) return faulted(selection.fault)
  const gridType = readNullableString(selection.selected.product.gridType, 'product.gridType')
  if (gridType === null) return faulted(fault('region_missing', 'product.gridType is null or absent'))
  const missingOutlook = noBodyFault(outlook)
  if (missingOutlook !== null) return faulted(missingOutlook)
  let values: Outlook
  try {
    values = readOutlook(outlook.body)
  } catch (error) {
    if (!(error instanceof InvalidResponse)) throw error
    return faulted(outlook.error === null ? fault('invalid_response', error.message) : faultFromError(outlook.error))
  }
  const age = Math.max(0, instantMs - values.intervalStartMs)
  if (age >= PRICE_STALE_AFTER_S * MS_PER_SECOND) {
    return faulted(outlook.error === null ? fault('price_stale', `outlook.now.time ${formatInstant(values.intervalStartMs)} is ${Math.floor(age / MS_PER_SECOND)} s old`) : faultFromError(outlook.error))
  }
  const cents = values.centsPerKwh
  const high = config.priceHighThresholdCentsPerKwh
  const low = config.priceLowThresholdCentsPerKwh
  const highT = high === null ? null : cents >= high
  const lowT = low === null ? null : cents <= low
  const highTier = (values.tier === 'Elevated' || values.tier === 'Spike') && cents >= 0
  const lowTier = values.tier === 'UnusuallyLow' || cents < 0
  return {
    signals: {
      status: 'ok',
      fault: null,
      centsPerKwh: cents,
      intervalStart: formatInstant(values.intervalStartMs),
      tier: values.tier,
      priceHigh: highT !== null ? highT : highTier && lowT !== true,
      priceLow: lowT !== null ? lowT : lowTier && highT !== true,
      negative: cents < 0,
      forecast: { nextHour: values.nextHour, ahead: values.ahead },
    },
    intervalStartMs: values.intervalStartMs,
  }
}

export function priceGroup(instantMs: number, config: SignalConfig, account: Snapshot, outlook: Snapshot): PriceResult {
  try {
    return computePrice(instantMs, config, account, outlook)
  } catch (error) {
    if (error instanceof InvalidResponse) return faulted(fault('invalid_response', error.message))
    throw error
  }
}
