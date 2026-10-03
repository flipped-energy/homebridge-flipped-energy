import { tariffGroup } from '../core/tariff.ts'
import { selectAccount } from '../core/account.ts'
import { formatInstant, toLocal } from '../core/time.ts'
import type { EnergyEntry, ScheduleEntry, SignalConfig, Snapshot } from '../core/types.ts'

export type TariffChannel = 'peak' | 'off_peak' | 'shoulder'

export function tariffHistoryIntervals(intervals: readonly EnergyEntry[], config: SignalConfig, account: Snapshot): EnergyEntry[] {
  const selection = selectAccount(account.body, config)
  const zone = 'fault' in selection ? null : selection.selected.product.timeZone
  if (typeof zone !== 'string') return []
  return intervals.flatMap((entry) => {
    if (entry.durationMinutes <= 0 || entry.durationMinutes % 10 !== 0) throw new Error(`Invalid tariff history interval duration: ${entry.durationMinutes}`)
    return Array.from({ length: entry.durationMinutes / 10 }, (_, slot) => {
      const instant = Date.parse(entry.start) + slot * 600000
      return { ...entry, start: formatInstant(instant), local: toLocal(instant, zone).wall, durationMinutes: 10, gridImportKwh: entry.gridImportKwh * 10 / entry.durationMinutes }
    })
  })
}

export function tariffEnergy(config: SignalConfig, account: Snapshot): (entry: EnergyEntry, channel: TariffChannel) => number | null {
  const schedules = new Map<string, readonly ScheduleEntry[] | null>()
  return (entry, channel) => {
    const date = entry.local.slice(0, 10)
    let schedule = schedules.get(date)
    if (schedule === undefined) {
      const tariff = tariffGroup(Date.parse(entry.start), config, account).signals
      schedule = tariff.status === 'ok' ? tariff.schedule : null
      schedules.set(date, schedule)
    }
    if (schedule === null) return null
    const selection = selectAccount(account.body, config)
    const zone = 'fault' in selection ? null : selection.selected.product.timeZone
    if (typeof zone !== 'string') return null
    const band = channel === 'off_peak' ? 'offPeak' : channel
    const localMinute = Number(entry.local.slice(11, 13)) * 60 + Number(entry.local.slice(14, 16))
    const start = Date.parse(entry.start)
    const lastMinute = toLocal(start + (entry.durationMinutes - 1) * 60000, zone).minuteOfDay
    const clockChanges = lastMinute !== (localMinute + entry.durationMinutes - 1) % 1440
    let minutes = 0
    for (let offset = 0; offset < entry.durationMinutes; offset++) {
      const minute = clockChanges ? toLocal(start + offset * 60000, zone).minuteOfDay : (localMinute + offset) % 1440
      if (schedule.some((period) => period.band === band && minute >= period.startMinute && minute < period.endMinute)) minutes++
    }
    return entry.gridImportKwh * minutes / entry.durationMinutes
  }
}
