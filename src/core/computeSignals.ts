import { ACCOUNT_MAX_AGE_S, MS_PER_DAY, MS_PER_SECOND, PRICE_STALE_AFTER_S, TOKEN_EXPIRY_WARNING_DAYS } from './constants.ts'
import { accountGroup } from './account.ts'
import { energyGroup } from './energy.ts'
import { priceGroup } from './price.ts'
import { tariffGroup } from './tariff.ts'
import { formatInstantCeil, parseInstant } from './time.ts'
import { type Fault, type SignalConfig, type Signals, type Snapshot, fault } from './types.ts'

function clockUnsynced(): Signals {
  const reason = (): Fault => fault('clock_unsynced')
  return {
    account: {
      status: 'faulted',
      fault: reason(),
      accountNumber: null,
      accountState: null,
      productName: null,
      region: null,
      timeZone: null,
      tokenExpiresAt: null,
      tokenScope: null,
      tokenExpiringSoon: null,
    },
    tariff: { status: 'faulted', fault: reason(), structure: null, spotLinked: null, peak: null, offPeak: null, period: null, nextChange: null, schedule: null },
    price: { status: 'faulted', fault: reason(), centsPerKwh: null, intervalStart: null, tier: null, priceHigh: null, priceLow: null, negative: null, forecast: null },
    energy: { status: 'faulted', fault: reason(), nmi: null, intervals: null, days: null, latestIntervalEnd: null },
    nextEvaluation: null,
  }
}

function instantOf(text: string, field: string): number {
  const parsed = parseInstant(text)
  if (parsed === null) throw new Error(`${field} is not an ISO-8601 instant: ${JSON.stringify(text)}`)
  return parsed
}

export function computeSignals(
  instant: string | null,
  config: SignalConfig,
  account: Snapshot,
  meters: Snapshot,
  tokens: Snapshot,
  outlook: Snapshot,
  usageHalfHourly: Snapshot,
  usageDaily: Snapshot,
): Signals {
  if (instant === null) return clockUnsynced()
  const instantMs = instantOf(instant, 'instant')
  const accountResult = accountGroup(instantMs, config, account, tokens)
  const tariffResult = tariffGroup(instantMs, config, account)
  const priceResult = priceGroup(instantMs, config, account, outlook)
  const energy = energyGroup(config, account, meters, usageHalfHourly, usageDaily)
  const candidates: number[] = []
  if (tariffResult.signals.status === 'ok' && tariffResult.signals.nextChange !== null) candidates.push(instantOf(tariffResult.signals.nextChange, 'tariff.nextChange'))
  if (tariffResult.planChangeInstantMs !== null) candidates.push(tariffResult.planChangeInstantMs)
  if (account.body !== null && account.fetchedAt !== null) candidates.push(instantOf(account.fetchedAt, 'account.fetchedAt') + ACCOUNT_MAX_AGE_S * MS_PER_SECOND)
  if (priceResult.intervalStartMs !== null) candidates.push(priceResult.intervalStartMs + PRICE_STALE_AFTER_S * MS_PER_SECOND)
  if (accountResult.tokenExpiresAtMs !== null) candidates.push(accountResult.tokenExpiresAtMs - TOKEN_EXPIRY_WARNING_DAYS * MS_PER_DAY)
  const later = candidates.filter((candidate) => candidate > instantMs)
  return {
    account: accountResult.signals,
    tariff: tariffResult.signals,
    price: priceResult.signals,
    energy,
    nextEvaluation: later.length === 0 ? null : formatInstantCeil(Math.min(...later)),
  }
}
