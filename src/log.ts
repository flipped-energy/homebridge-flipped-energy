import { inspect } from 'node:util'
import type { AccountOk } from './core/types.ts'
import type { RuntimeLog } from './runtime/requestGate.ts'
import type { ArmEvent } from './runtime/scheduler.ts'

export function logErrors(log: RuntimeLog, lines: readonly string[]): void {
  for (const line of lines) log.error(line)
}

export function logThrown(log: RuntimeLog, step: string, error: unknown): void {
  log.error(step)
  log.error(inspect(error))
}

export function armedLine(event: ArmEvent): string {
  return `timer ${event.timer} armed for ${new Date(event.targetMs).toISOString()}, in ${event.delayMs} ms`
}

export function dailyLimitLine(remaining: number): string {
  return `X-DailyLimit-Remaining: ${remaining}`
}

export function tokenExpiringLine(account: AccountOk): string {
  return `token_expiring: true, tokenExpiresAt ${JSON.stringify(account.tokenExpiresAt)}`
}
