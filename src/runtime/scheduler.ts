import { MS_PER_SECOND, TIMER_MAX_AHEAD_S } from '../core/constants.ts'

export type TimerName = 'startup' | 'accountSync' | 'usageSync' | 'price' | 'retryAfter' | 'evaluation'

export interface TimerApi<Handle> {
  now(): number
  setTimeout(callback: () => void, delayMs: number): Handle
  clearTimeout(handle: Handle): void
}

export interface ArmEvent {
  timer: TimerName
  armedAtMs: number
  targetMs: number
  delayMs: number
}

export interface ArmedTimer {
  readonly timer: TimerName
  readonly targetMs: number
  cancel(): void
}

export interface Scheduler {
  now(): number
  armAt(timer: TimerName, targetMs: number, action: () => void): ArmedTimer
  until(timer: TimerName, targetMs: number, signal: AbortSignal): Promise<boolean>
}

export const TIMER_MAX_AHEAD_MS = TIMER_MAX_AHEAD_S * MS_PER_SECOND

export const systemTimers: TimerApi<ReturnType<typeof setTimeout>> = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
}

export function createScheduler<Handle>(api: TimerApi<Handle>, armed: (event: ArmEvent) => void): Scheduler {
  const armAt = (timer: TimerName, targetMs: number, action: () => void): ArmedTimer => {
    if (!Number.isFinite(targetMs)) throw new Error(`armAt ${timer}: target ${targetMs} is not a finite instant`)
    let handle: { value: Handle } | null = null
    let cancelled = false
    const fire = (): void => {
      handle = null
      if (cancelled) return
      if (api.now() >= targetMs) action()
      else arm()
    }
    const arm = (): void => {
      const armedAtMs = api.now()
      const delayMs = Math.max(0, Math.min(targetMs - armedAtMs, TIMER_MAX_AHEAD_MS))
      armed({ timer, armedAtMs, targetMs, delayMs })
      handle = { value: api.setTimeout(fire, delayMs) }
    }
    arm()
    return {
      timer,
      targetMs,
      cancel: () => {
        cancelled = true
        if (handle !== null) api.clearTimeout(handle.value)
        handle = null
      },
    }
  }
  const until = (timer: TimerName, targetMs: number, signal: AbortSignal): Promise<boolean> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve(false)
        return
      }
      const abort = (): void => {
        pending.cancel()
        resolve(false)
      }
      const pending = armAt(timer, targetMs, () => {
        signal.removeEventListener('abort', abort)
        resolve(true)
      })
      signal.addEventListener('abort', abort, { once: true })
    })
  return { now: () => api.now(), armAt, until }
}
