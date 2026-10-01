import {
  ACCOUNT_MAX_AGE_S,
  FIXED_BILLING_UNIT,
  KNOWN_BILLING_UNIT_TYPES,
  KWH_UNLIMITED,
  MINUTES_PER_DAY,
  MS_PER_DAY,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  PLAN_CHANGE_HORIZON_DAYS,
  SCAN_LIMIT_MIN,
  SPOT_BILLING_UNIT,
  SPOT_WITH_CAP_BILLING_UNIT,
  SUPPLIED_ACCOUNT_STATES,
} from './constants.ts'
import { selectAccount } from './account.ts'
import { keyToCents, rateKey } from './rateKey.ts'
import { LocalTimeNonexistent, formatInstant, isWallText, localToInstant, nextDate, parseInstant, toLocal, zoneError } from './time.ts'
import {
  type Band,
  type Fault,
  type JsonRecord,
  type ScheduleEntry,
  type Segment,
  type SignalConfig,
  type Snapshot,
  type Structure,
  type TariffSignals,
  InvalidResponse,
  fault,
  readArray,
  readNullableRecord,
  readNullableString,
  readRecord,
  readString,
  unusableFault,
} from './types.ts'

export interface TariffResult {
  signals: TariffSignals
  planChangeInstantMs: number | null
}

interface PlanDates {
  plan: JsonRecord
  start: string
  end: string
  label: string
}

interface FixedUnit {
  id: string
  name: string
  start: number
  end: number
  from: number
  to: number | null
  key: number
}

interface SpotUnit {
  id: string
  start: number
  end: number
  capKey: number | null
  withCap: boolean
}

interface MinuteBlock {
  from: number
  to: number | null
  key: number
}

interface MinuteData {
  blocks: MinuteBlock[]
  key: number
  name: string
  wholesale: boolean
  cap: number | null
}

class TariffFault extends Error {
  readonly fault: Fault

  constructor(reason: Fault) {
    super(reason.message ?? reason.code)
    this.name = 'TariffFault'
    this.fault = reason
  }
}

function faulted(reason: Fault, planChangeInstantMs: number | null): TariffResult {
  return {
    signals: {
      status: 'faulted',
      fault: reason,
      structure: null,
      spotLinked: null,
      peak: null,
      offPeak: null,
      period: null,
      nextChange: null,
      schedule: null,
    },
    planChangeInstantMs,
  }
}

function readPlanDates(value: unknown, label: string): PlanDates | null {
  const plan = readNullableRecord(value, label)
  if (plan === null) return null
  const start = plan.start
  const end = plan.end
  if (typeof start !== 'string' || !isWallText(start)) throw new InvalidResponse(`${label}.start: not text starting YYYY-MM-DDTHH:mm:ss: ${JSON.stringify(start)}`)
  if (typeof end !== 'string' || !isWallText(end)) throw new InvalidResponse(`${label}.end: not text starting YYYY-MM-DDTHH:mm:ss: ${JSON.stringify(end)}`)
  return { plan, start, end, label }
}

function inWindow(start: number, end: number, minute: number): boolean {
  if (start === end) return true
  if (start < end) return start <= minute && minute < end
  return minute >= start || minute < end
}

function readMinute(unit: JsonRecord, key: 'timeOfDayStartMinutes' | 'timeOfDayEndMinutes', id: string): number {
  const value = unit[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MINUTES_PER_DAY) {
    throw new TariffFault(fault('billing_unit_malformed', `unit ${id}: ${key} ${JSON.stringify(value)}`))
  }
  return value
}

function readWindow(unit: JsonRecord, id: string): { start: number; end: number } {
  return { start: readMinute(unit, 'timeOfDayStartMinutes', id), end: readMinute(unit, 'timeOfDayEndMinutes', id) }
}

function readKwhBound(unit: JsonRecord, field: 'kwhStart' | 'kwhEnd', id: string): number | null {
  const value = unit[field]
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TariffFault(fault('billing_unit_malformed', `unit ${id}: ${field} ${JSON.stringify(value)}`))
  return value
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined
}

function readUnits(plan: PlanDates): { fixed: FixedUnit[]; spot: SpotUnit[] } {
  const fixed: FixedUnit[] = []
  const spot: SpotUnit[] = []
  const units = readArray(plan.plan.billingUnits, `${plan.label}.billingUnits`)
  units.forEach((element, index) => {
    const field = `${plan.label}.billingUnits[${index}]`
    const unit = readRecord(element, field)
    const id = readString(unit.billingUnitId, `${field}.billingUnitId`)
    const type = unit.billingUnitType === undefined ? null : readNullableString(unit.billingUnitType, `${field}.billingUnitType`)
    if (type === null || !KNOWN_BILLING_UNIT_TYPES.includes(type)) {
      if (present(unit.timeOfDayStartMinutes) || present(unit.timeOfDayEndMinutes) || present(unit.chargePerKwh) || present(unit.chargePerKwhIncludingGst)) {
        throw new TariffFault(fault('billing_unit_unsupported', `unit ${id} type ${String(type)}`))
      }
      return
    }
    if (type === FIXED_BILLING_UNIT) {
      const window = readWindow(unit, id)
      const charge = unit.chargePerKwhIncludingGst
      if (typeof charge !== 'number' || !Number.isFinite(charge)) throw new TariffFault(fault('billing_unit_malformed', `unit ${id}: chargePerKwhIncludingGst ${JSON.stringify(charge)}`))
      const kwhStart = readKwhBound(unit, 'kwhStart', id)
      const kwhEnd = readKwhBound(unit, 'kwhEnd', id)
      const from = kwhStart === null ? 0 : kwhStart
      const to = kwhEnd === null || kwhEnd === 0 || kwhEnd >= KWH_UNLIMITED ? null : kwhEnd
      if (from < 0 || (kwhEnd !== null && kwhEnd < 0) || (to !== null && to <= from)) {
        throw new TariffFault(fault('billing_unit_malformed', `unit ${id}: kwhStart ${JSON.stringify(kwhStart)} kwhEnd ${JSON.stringify(kwhEnd)}`))
      }
      const name = readNullableString(unit.name, `${field}.name`)
      fixed.push({ id, name: name === null ? '' : name, start: window.start, end: window.end, from, to, key: rateKey(charge) })
      return
    }
    if (type === SPOT_BILLING_UNIT || type === SPOT_WITH_CAP_BILLING_UNIT) {
      const window = readWindow(unit, id)
      const cap = unit.capPerKwhIncludingGst
      if (present(cap) && (typeof cap !== 'number' || !Number.isFinite(cap))) {
        throw new TariffFault(fault('billing_unit_malformed', `unit ${id}: capPerKwhIncludingGst ${JSON.stringify(cap)}`))
      }
      spot.push({ id, start: window.start, end: window.end, capKey: typeof cap === 'number' ? rateKey(cap) : null, withCap: type === SPOT_WITH_CAP_BILLING_UNIT })
    }
  })
  return { fixed, spot }
}

function buildDayTable(fixed: FixedUnit[], spot: SpotUnit[]): MinuteData[] {
  const table: MinuteData[] = []
  for (let minute = 0; minute < MINUTES_PER_DAY; minute++) {
    const f = fixed.filter((unit) => inWindow(unit.start, unit.end, minute)).sort((a, b) => a.from - b.from)
    const s = spot.filter((unit) => inWindow(unit.start, unit.end, minute))
    const first = f[0]
    if (first === undefined && s.length > 0) throw new TariffFault(fault('spot_direction_unknown', `minute ${minute}, units ${s.map((unit) => unit.id).join(', ')}`))
    if (first === undefined) throw new TariffFault(fault('tariff_gap', `minute ${minute}`))
    if (first.from !== 0) throw new TariffFault(fault('tariff_gap', `minute ${minute}, kWh 0`))
    for (let index = 1; index < f.length; index++) {
      const prev = f[index - 1]
      const cur = f[index]
      if (prev === undefined || cur === undefined) throw new Error(`fixed unit list changed while scanning minute ${minute}`)
      if (prev.to === null || cur.from < prev.to) throw new TariffFault(fault('billing_unit_overlap', `minute ${minute}, units ${prev.id} and ${cur.id}`))
      if (cur.from > prev.to) throw new TariffFault(fault('tariff_gap', `minute ${minute}, kWh ${prev.to}`))
    }
    const last = f[f.length - 1]
    if (last !== undefined && last.to !== null) throw new TariffFault(fault('tariff_gap', `minute ${minute}, kWh ${last.to}`))
    const onlySpot = s.length === 1 ? s[0] : undefined
    table.push({
      blocks: f.map((unit) => ({ from: unit.from, to: unit.to, key: unit.key })),
      key: first.key,
      name: first.name,
      wholesale: s.length > 0,
      cap: onlySpot !== undefined && onlySpot.withCap && onlySpot.capKey !== null ? onlySpot.capKey : null,
    })
  }
  return table
}

function toSegment(data: MinuteData, band: Band): Segment {
  const firstBlock = data.blocks[0]
  const secondBlock = data.blocks[1]
  if (firstBlock === undefined) throw new Error('a minute of the day table has no block')
  return {
    band,
    name: data.name,
    rateCentsPerKwh: keyToCents(data.key),
    kwhLimit: firstBlock.to,
    rateAfterLimitCentsPerKwh: secondBlock === undefined ? null : keyToCents(secondBlock.key),
    blocks: data.blocks.map((block) => ({ fromKwh: block.from, toKwh: block.to, rateCentsPerKwh: keyToCents(block.key) })),
    wholesaleLinked: data.wholesale,
    wholesaleCapCentsPerKwh: data.cap === null ? null : keyToCents(data.cap),
  }
}

function computePlanChange(instantMs: number, zone: string, current: PlanDates | null, upcoming: PlanDates | null): { plan: PlanDates | null; planChangeInstantMs: number | null } {
  const local = toLocal(instantMs, zone)
  const inEffect = (p: PlanDates | null): p is PlanDates => p !== null && p.start.slice(0, 19) <= local.wall && local.date <= p.end.slice(0, 10)
  const plan = inEffect(upcoming) ? upcoming : inEffect(current) ? current : null
  const t0 = Math.floor(instantMs / MS_PER_MINUTE) * MS_PER_MINUTE
  const horizonDate = toLocal(t0 + PLAN_CHANGE_HORIZON_DAYS * MS_PER_DAY, zone).date
  const candidates: string[] = []
  if (plan !== null && plan.end.slice(0, 10) < horizonDate) candidates.push(`${nextDate(plan.end.slice(0, 10))}T00:00:00`)
  if (upcoming !== null && plan !== upcoming && upcoming.start.slice(0, 19) > local.wall && upcoming.start.slice(0, 10) <= horizonDate) {
    candidates.push(upcoming.start.slice(0, 19))
  }
  candidates.sort()
  const smallest = candidates[0]
  return { plan, planChangeInstantMs: smallest === undefined ? null : localToInstant(smallest, zone) }
}

function computeTariff(instantMs: number, config: SignalConfig, account: Snapshot): TariffResult {
  const fetchedAtMs = account.fetchedAt === null ? null : parseInstant(account.fetchedAt)
  if (account.body !== null && fetchedAtMs === null) throw new Error(`account snapshot has a body and no valid fetchedAt: ${JSON.stringify(account.fetchedAt)}`)
  const aged = fetchedAtMs !== null && instantMs - fetchedAtMs >= ACCOUNT_MAX_AGE_S * MS_PER_SECOND
  const unusable = unusableFault(account, aged, 'account_data_stale')
  if (unusable !== null) return faulted(unusable, null)
  const selection = selectAccount(account.body, config)
  if ('fault' in selection) return faulted(selection.fault, null)
  const { selected } = selection
  const accountState = readString(selected.account.accountState, 'accountState')
  if (!SUPPLIED_ACCOUNT_STATES.includes(accountState)) return faulted(fault('account_not_supplied', `accountState ${accountState}`), null)
  const zone = readNullableString(selected.product.timeZone, 'product.timeZone')
  if (zone === null) return faulted(fault('timezone_missing', 'product.timeZone is null or absent'), null)
  const unsupported = zoneError(zone)
  if (unsupported !== null) return faulted(fault('timezone_unsupported', `${zone}: ${unsupported}`), null)
  const current = readPlanDates(selected.product.currentPlan, 'currentPlan')
  const upcoming = readPlanDates(selected.product.upcomingPlan, 'upcomingPlan')
  const { plan, planChangeInstantMs } = computePlanChange(instantMs, zone, current, upcoming)
  if (plan === null) return faulted(fault('plan_unavailable', `no plan in effect at ${toLocal(instantMs, zone).wall}`), planChangeInstantMs)
  try {
    return { signals: classify(instantMs, zone, plan, planChangeInstantMs), planChangeInstantMs }
  } catch (error) {
    if (error instanceof TariffFault) return faulted(error.fault, planChangeInstantMs)
    if (error instanceof InvalidResponse) return faulted(fault('invalid_response', error.message), planChangeInstantMs)
    if (error instanceof LocalTimeNonexistent) return faulted(fault('local_time_nonexistent', error.message), planChangeInstantMs)
    throw error
  }
}

function classify(instantMs: number, zone: string, plan: PlanDates, planChangeInstantMs: number | null): TariffSignals {
  const { fixed, spot } = readUnits(plan)
  const table = buildDayTable(fixed, spot)
  const tiers = [...new Set(table.map((data) => data.key))].sort((a, b) => a - b)
  const lowest = tiers[0]
  const highest = tiers[tiers.length - 1]
  const structure: Structure = tiers.length === 1 ? 'flat' : 'timeOfUse'
  const bandOf = (key: number): Band => {
    if (tiers.length === 1) return 'anytime'
    if (key === lowest) return 'offPeak'
    if (key === highest) return 'peak'
    return 'shoulder'
  }
  const segments = table.map((data) => toSegment(data, bandOf(data.key)))
  const signatures = segments.map((segment) => JSON.stringify(segment))
  const segmentAt = (minute: number): Segment => {
    const segment = segments[minute]
    if (segment === undefined) throw new Error(`minute of day out of range: ${minute}`)
    return segment
  }
  const signatureAt = (minute: number): string => {
    const signature = signatures[minute]
    if (signature === undefined) throw new Error(`minute of day out of range: ${minute}`)
    return signature
  }
  const t0 = Math.floor(instantMs / MS_PER_MINUTE) * MS_PER_MINUTE
  const now = toLocal(t0, zone).minuteOfDay
  const nowSignature = signatureAt(now)
  let end: number | null = null
  for (let k = 1; k <= SCAN_LIMIT_MIN; k++) {
    const candidate = t0 + k * MS_PER_MINUTE
    if (signatureAt(toLocal(candidate, zone).minuteOfDay) !== nowSignature) {
      end = candidate
      break
    }
  }
  if (end !== null && planChangeInstantMs !== null) end = Math.min(end, planChangeInstantMs)
  let start: number | null = null
  for (let k = 0; k <= SCAN_LIMIT_MIN; k++) {
    const candidate = t0 - k * MS_PER_MINUTE
    if (signatureAt(toLocal(candidate - MS_PER_MINUTE, zone).minuteOfDay) !== nowSignature) {
      start = candidate
      break
    }
  }
  const planStartInstantMs = plan.start.slice(0, 10) >= toLocal(t0 - SCAN_LIMIT_MIN * MS_PER_MINUTE, zone).date ? localToInstant(plan.start.slice(0, 19), zone) : null
  if (start !== null && planStartInstantMs !== null) start = Math.max(start, planStartInstantMs)
  const nextChangeCandidates = [end, planChangeInstantMs].filter((value): value is number => value !== null)
  const nextChange = nextChangeCandidates.length === 0 ? null : Math.min(...nextChangeCandidates)
  const schedule: ScheduleEntry[] = []
  let runStart = 0
  for (let minute = 1; minute <= MINUTES_PER_DAY; minute++) {
    if (minute < MINUTES_PER_DAY && signatureAt(minute) === signatureAt(runStart)) continue
    schedule.push({ ...segmentAt(runStart), startMinute: runStart, endMinute: minute })
    runStart = minute
  }
  const current = segmentAt(now)
  return {
    status: 'ok',
    fault: null,
    structure,
    spotLinked: spot.length > 0,
    peak: current.band === 'peak',
    offPeak: current.band === 'offPeak',
    period: { ...current, start: start === null ? null : formatInstant(start), end: end === null ? null : formatInstant(end) },
    nextChange: nextChange === null ? null : formatInstant(nextChange),
    schedule,
  }
}

export function tariffGroup(instantMs: number, config: SignalConfig, account: Snapshot): TariffResult {
  try {
    return computeTariff(instantMs, config, account)
  } catch (error) {
    if (error instanceof InvalidResponse) return faulted(fault('invalid_response', error.message), null)
    if (error instanceof LocalTimeNonexistent) return faulted(fault('local_time_nonexistent', error.message), null)
    throw error
  }
}
