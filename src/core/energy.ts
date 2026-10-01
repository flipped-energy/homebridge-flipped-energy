import { MS_PER_MINUTE } from './constants.ts'
import { type SelectedAccount, selectAccount } from './account.ts'
import { LocalTimeNonexistent, formatInstant, isWallText, localOccurrences, localToInstant, nextDate, zoneError } from './time.ts'
import {
  type EnergyEntry,
  type EnergySignals,
  type Fault,
  type SignalConfig,
  type Snapshot,
  InvalidResponse,
  fault,
  noBodyFault,
  readArray,
  readBoolean,
  readNullableNumber,
  readNullableString,
  readNumber,
  readRecord,
  readString,
} from './types.ts'

interface Bucket {
  time: string
  gridImportKwh: number
  controlledLoadKwh: number
  solarExportKwh: number
  costAud: number | null
  feedInCreditAud: number | null
}

interface TimedEntry {
  startMs: number
  entry: EnergyEntry
}

function faulted(reason: Fault): EnergySignals {
  return { status: 'faulted', fault: reason, nmi: null, intervals: null, days: null, latestIntervalEnd: null }
}

function selectNmi(meters: unknown, selected: SelectedAccount, configured: string | null): { nmi: string } | { fault: Fault } {
  const root = readRecord(meters, 'meters body')
  const list = readArray(root.meters, 'meters')
  const siteAddress = readString(selected.account.siteAddress, 'siteAddress')
  const all: string[] = []
  const candidates: string[] = []
  list.forEach((element, index) => {
    const meter = readRecord(element, `meters[${index}]`)
    const nmi = readString(meter.nmi, `meters[${index}].nmi`)
    const address = readString(meter.address, `meters[${index}].address`)
    if (!all.includes(nmi)) all.push(nmi)
    if (address === siteAddress && !candidates.includes(nmi)) candidates.push(nmi)
  })
  if (configured !== null) {
    if (all.includes(configured)) return { nmi: configured }
    return { fault: fault('nmi_not_found', `nmi ${configured} not in ${all.join(', ')}`) }
  }
  const only = candidates[0]
  if (candidates.length === 1 && only !== undefined) return { nmi: only }
  return { fault: fault('nmi_selection_required', (candidates.length === 0 ? all : candidates).join(', ')) }
}

function buckets(body: unknown, nmi: string, label: string): Bucket[] {
  const rows = readArray(body, label)
  const byTime = new Map<string, { grid: number; controlled: number; solar: number; keys: Map<string, number | null> }>()
  rows.forEach((element, index) => {
    const field = `${label}[${index}]`
    const row = readRecord(element, field)
    if (readString(row.nmi, `${field}.nmi`) !== nmi) return
    const usageType = readString(row.usageType, `${field}.usageType`)
    if (usageType !== 'Export' && usageType !== 'Import') return
    const time = readString(row.time, `${field}.time`)
    if (!isWallText(time)) throw new InvalidResponse(`${field}.time: not text starting YYYY-MM-DDTHH:mm:ss: ${JSON.stringify(time)}`)
    const local = time.slice(0, 19)
    const value = readNumber(row.value, `${field}.value`)
    const controlledLoad = readBoolean(row.controlledLoad, `${field}.controlledLoad`)
    let bucket = byTime.get(local)
    if (bucket === undefined) {
      bucket = { grid: 0, controlled: 0, solar: 0, keys: new Map() }
      byTime.set(local, bucket)
    }
    if (usageType === 'Import') bucket.solar += value
    else if (controlledLoad) bucket.controlled += value
    else bucket.grid += value
    if (usageType === 'Import' && controlledLoad) return
    const key = `${usageType}:${controlledLoad}`
    const cost = readNullableNumber(row.cost, `${field}.cost`)
    if (!bucket.keys.has(key)) {
      bucket.keys.set(key, cost)
      return
    }
    const known = bucket.keys.get(key)
    if (known !== cost) throw new InvalidResponse(`${field}.cost: ${JSON.stringify(cost)} differs from ${JSON.stringify(known)} on another row with time ${local}, usageType ${usageType}, controlledLoad ${controlledLoad}`)
  })
  return [...byTime.entries()].map(([time, bucket]) => {
    const exportCosts: (number | null)[] = []
    for (const key of ['Export:false', 'Export:true']) {
      const cost = bucket.keys.get(key)
      if (cost !== undefined) exportCosts.push(cost)
    }
    const feedIn = bucket.keys.get('Import:false')
    return {
      time,
      gridImportKwh: bucket.grid,
      controlledLoadKwh: bucket.controlled,
      solarExportKwh: bucket.solar,
      costAud: exportCosts.length === 0 ? null : sumNullable(exportCosts),
      feedInCreditAud: feedIn === undefined || feedIn === null ? null : 0 - feedIn,
    }
  })
}

function entryOf(bucket: Bucket, local: string, startMs: number, durationMinutes: number): TimedEntry {
  return {
    startMs,
    entry: {
      local,
      start: formatInstant(startMs),
      durationMinutes,
      gridImportKwh: bucket.gridImportKwh,
      controlledLoadKwh: bucket.controlledLoadKwh,
      solarExportKwh: bucket.solarExportKwh,
      costAud: bucket.costAud,
      feedInCreditAud: bucket.feedInCreditAud,
    },
  }
}

function sumNullable(values: (number | null)[]): number | null {
  let total = 0
  for (const value of values) {
    if (value === null) return null
    total += value
  }
  return total
}

function intervalsOf(list: Bucket[], zone: string): TimedEntry[] {
  const single: TimedEntry[] = []
  const repeated = new Map<string, { bucket: Bucket; first: number; second: number }[]>()
  for (const bucket of list) {
    const occurrences = localOccurrences(bucket.time, zone)
    const first = occurrences[0]
    const second = occurrences[1]
    if (first === undefined) throw new LocalTimeNonexistent(bucket.time, zone)
    if (second === undefined) {
      single.push(entryOf(bucket, bucket.time, first, 30))
      continue
    }
    const date = bucket.time.slice(0, 10)
    const group = repeated.get(date)
    if (group === undefined) repeated.set(date, [{ bucket, first, second }])
    else group.push({ bucket, first, second })
  }
  for (const group of repeated.values()) {
    const ordered = [...group].sort((a, b) => (a.bucket.time < b.bucket.time ? -1 : a.bucket.time > b.bucket.time ? 1 : 0))
    const earliest = ordered[0]
    const latest = ordered[ordered.length - 1]
    if (earliest === undefined || latest === undefined) throw new Error('empty repeated-hour group')
    const endMs = latest.second + 30 * MS_PER_MINUTE
    const merged: Bucket = {
      time: earliest.bucket.time,
      gridImportKwh: ordered.reduce((sum, item) => sum + item.bucket.gridImportKwh, 0),
      controlledLoadKwh: ordered.reduce((sum, item) => sum + item.bucket.controlledLoadKwh, 0),
      solarExportKwh: ordered.reduce((sum, item) => sum + item.bucket.solarExportKwh, 0),
      costAud: sumNullable(ordered.map((item) => item.bucket.costAud)),
      feedInCreditAud: sumNullable(ordered.map((item) => item.bucket.feedInCreditAud)),
    }
    single.push(entryOf(merged, merged.time, earliest.first, (endMs - earliest.first) / MS_PER_MINUTE))
  }
  return single.sort((a, b) => a.startMs - b.startMs)
}

function daysOf(list: Bucket[], zone: string): TimedEntry[] {
  return list
    .map((bucket) => {
      const date = bucket.time.slice(0, 10)
      const startMs = localToInstant(`${date}T00:00:00`, zone)
      const endMs = localToInstant(`${nextDate(date)}T00:00:00`, zone)
      return entryOf(bucket, bucket.time, startMs, (endMs - startMs) / MS_PER_MINUTE)
    })
    .sort((a, b) => a.startMs - b.startMs)
}

export interface UsageSource {
  nmi: string
  zone: string
}

function findUsageSource(config: SignalConfig, account: Snapshot, meters: Snapshot): UsageSource | { fault: Fault } {
  const missingAccount = noBodyFault(account)
  if (missingAccount !== null) return { fault: missingAccount }
  const selection = selectAccount(account.body, config)
  if ('fault' in selection) return { fault: selection.fault }
  const { selected } = selection
  const zone = readNullableString(selected.product.timeZone, 'product.timeZone')
  if (zone === null) return { fault: fault('timezone_missing', 'product.timeZone is null or absent') }
  const unsupported = zoneError(zone)
  if (unsupported !== null) return { fault: fault('timezone_unsupported', `${zone}: ${unsupported}`) }
  const zones = selected.eligible.map((eligible, index) => readNullableString(readRecord(eligible.product, `eligible[${index}].product`).timeZone, `eligible[${index}].product.timeZone`))
  if (zones.some((other) => other !== zone)) return { fault: fault('usage_timezone_ambiguous', `time zones ${zones.map((other) => String(other)).join(', ')}`) }
  const missingMeters = noBodyFault(meters)
  if (missingMeters !== null) return { fault: missingMeters }
  const chosen = selectNmi(meters.body, selected, config.nmi)
  if ('fault' in chosen) return { fault: chosen.fault }
  return { nmi: chosen.nmi, zone }
}

function computeEnergy(config: SignalConfig, account: Snapshot, meters: Snapshot, usageHalfHourly: Snapshot, usageDaily: Snapshot): EnergySignals {
  const source = findUsageSource(config, account, meters)
  if ('fault' in source) return faulted(source.fault)
  const { nmi, zone } = source
  const missingHalfHourly = noBodyFault(usageHalfHourly)
  if (missingHalfHourly !== null) return faulted(missingHalfHourly)
  const missingDaily = noBodyFault(usageDaily)
  if (missingDaily !== null) return faulted(missingDaily)
  const intervals = intervalsOf(buckets(usageHalfHourly.body, nmi, 'usageHalfHourly'), zone)
  const days = daysOf(buckets(usageDaily.body, nmi, 'usageDaily'), zone)
  const last = intervals[intervals.length - 1]
  return {
    status: 'ok',
    fault: null,
    nmi,
    intervals: intervals.map((item) => item.entry),
    days: days.map((item) => item.entry),
    latestIntervalEnd: last === undefined ? null : formatInstant(last.startMs + last.entry.durationMinutes * MS_PER_MINUTE),
  }
}

export function usageSource(config: SignalConfig, account: Snapshot, meters: Snapshot): UsageSource | { fault: Fault } {
  try {
    return findUsageSource(config, account, meters)
  } catch (error) {
    if (error instanceof InvalidResponse) return { fault: fault('invalid_response', error.message) }
    throw error
  }
}

export function energyGroup(config: SignalConfig, account: Snapshot, meters: Snapshot, usageHalfHourly: Snapshot, usageDaily: Snapshot): EnergySignals {
  try {
    return computeEnergy(config, account, meters, usageHalfHourly, usageDaily)
  } catch (error) {
    if (error instanceof InvalidResponse) return faulted(fault('invalid_response', error.message))
    if (error instanceof LocalTimeNonexistent) return faulted(fault('local_time_nonexistent', error.message))
    throw error
  }
}
