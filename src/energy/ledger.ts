import { formatInstant, parseInstant } from '../core/time.ts'
import type { EnergyEntry, JsonRecord } from '../core/types.ts'
import { type HistoryState, readHistoryState } from '../eve/history.ts'
import { CHANNEL_NAMES, type ChannelName } from '../runtime/stateStore.ts'

export const SLOT_MINUTES = 10
export const SLOT_SECONDS = SLOT_MINUTES * 60
export const MAX_DECIWATTS = 0xffff
export const DECIWATT_MINUTES_PER_KWH = 600000

const MS_PER_SECOND = 1000
const MS_PER_MINUTE = 60000

export type EnergyPick = (entry: EnergyEntry) => number

export const CHANNEL_PICKS: Readonly<Record<ChannelName, EnergyPick>> = {
  grid_import: (entry) => entry.gridImportKwh,
  solar_export: (entry) => entry.solarExportKwh,
  controlled_load: (entry) => entry.controlledLoadKwh,
}

export interface LedgerChannel {
  seen: boolean
  totalKwh: number
  through: string | null
}

export interface ChannelState extends LedgerChannel {
  history: HistoryState
}

export interface HistoryEntry {
  time: number
  deciwatts: number
}

export interface Overflow {
  start: string
  durationMinutes: number
  kwh: number
  deciwatts: number
}

export interface Taken {
  firstStart: string
  lastEnd: string
  deltaKwh: number
}

export interface Advance {
  channel: LedgerChannel
  entries: HistoryEntry[]
  overflow: Overflow[]
  taken: Taken | null
}

export function emptyLedger(): LedgerChannel {
  return { seen: false, totalKwh: 0, through: null }
}

export function channelExists(name: ChannelName, channel: LedgerChannel): boolean {
  return name === 'grid_import' || channel.seen
}

function instantOf(text: string, where: string): number {
  const ms = parseInstant(text)
  if (ms === null) throw new Error(`${where}: ${JSON.stringify(text)} is not an instant`)
  return ms
}

export function advance(channel: LedgerChannel, intervals: readonly EnergyEntry[], pick: EnergyPick): Advance {
  const throughMs = channel.through === null ? null : instantOf(channel.through, 'ledger through')
  const fresh = intervals
    .map((interval) => ({ interval, startMs: instantOf(interval.start, 'interval start') }))
    .filter((item) => throughMs === null || item.startMs >= throughMs)
    .sort((a, b) => a.startMs - b.startMs)
  const entries: HistoryEntry[] = []
  const overflow: Overflow[] = []
  let { seen, totalKwh } = channel
  let cursorMs = throughMs
  let firstStartMs: number | null = null
  let deltaKwh = 0
  for (const { interval, startMs } of fresh) {
    const kwh = pick(interval)
    const minutes = interval.durationMinutes
    if (!Number.isFinite(kwh) || kwh < 0) throw new Error(`ledger: interval ${interval.start} has ${kwh} kWh`)
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes % SLOT_MINUTES !== 0) throw new Error(`ledger: interval ${interval.start} lasts ${minutes} minutes, not a positive multiple of ${SLOT_MINUTES}`)
    if (cursorMs !== null && startMs < cursorMs) throw new Error(`ledger: interval ${interval.start} starts before ${formatInstant(cursorMs)}, the end of the interval taken before it`)
    const deciwatts = Math.round((kwh * DECIWATT_MINUTES_PER_KWH) / minutes)
    if (deciwatts > MAX_DECIWATTS) {
      overflow.push({ start: interval.start, durationMinutes: minutes, kwh, deciwatts })
    } else {
      const startS = startMs / MS_PER_SECOND
      for (let k = 1; k <= minutes / SLOT_MINUTES; k++) entries.push({ time: startS + SLOT_SECONDS * k, deciwatts })
    }
    totalKwh += kwh
    deltaKwh += kwh
    if (kwh > 0) seen = true
    if (firstStartMs === null) firstStartMs = startMs
    cursorMs = startMs + minutes * MS_PER_MINUTE
  }
  const through = cursorMs === null ? null : formatInstant(cursorMs)
  const taken = firstStartMs === null || cursorMs === null ? null : { firstStart: formatInstant(firstStartMs), lastEnd: formatInstant(cursorMs), deltaKwh }
  return { channel: { seen, totalKwh, through }, entries, overflow, taken }
}

export function overflowLine(name: ChannelName, overflow: readonly Overflow[]): string {
  const kwh = overflow.reduce((sum, item) => sum + item.kwh, 0)
  const starts = overflow.map((item) => item.start).join(', ')
  return `${name}: ${overflow.length} intervals with ${kwh} kWh average above ${MAX_DECIWATTS / 10} W have no Eve history entries (${starts})`
}

function field(record: JsonRecord, key: string, where: string): unknown {
  if (!(key in record)) throw new Error(`${where}.${key}: missing`)
  return record[key]
}

export function readChannelState(record: JsonRecord, where: string): ChannelState {
  const seen = field(record, 'seen', where)
  const totalKwh = field(record, 'totalKwh', where)
  const through = field(record, 'through', where)
  if (typeof seen !== 'boolean') throw new Error(`${where}.seen: ${JSON.stringify(seen)}, expected a boolean`)
  if (typeof totalKwh !== 'number' || !Number.isFinite(totalKwh) || totalKwh < 0) throw new Error(`${where}.totalKwh: ${JSON.stringify(totalKwh)}, expected a number >= 0`)
  if (through !== null && (typeof through !== 'string' || parseInstant(through) === null)) throw new Error(`${where}.through: ${JSON.stringify(through)}, expected null or an instant`)
  return { seen, totalKwh, through, history: readHistoryState(field(record, 'history', where), `${where}.history`) }
}

export function channelRecord(state: ChannelState): JsonRecord {
  return { seen: state.seen, totalKwh: state.totalKwh, through: state.through, history: state.history }
}

export function readChannelStates(channels: Partial<Record<ChannelName, JsonRecord>>, where: string): Partial<Record<ChannelName, ChannelState>> {
  const states: Partial<Record<ChannelName, ChannelState>> = {}
  for (const name of CHANNEL_NAMES) {
    const record = channels[name]
    if (record !== undefined) states[name] = readChannelState(record, `${where}.channels.${name}`)
  }
  return states
}
