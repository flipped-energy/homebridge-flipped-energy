import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type ArmEvent, TIMER_MAX_AHEAD_MS, type TimerApi, createScheduler } from '../src/runtime/scheduler.ts'

test('armAt never hands the platform more than 24 h and an early wake-up re-arms without running the action', () => {
  let nowMs = 0
  const callbacks: (() => void)[] = []
  const api: TimerApi<number> = {
    now: () => nowMs,
    setTimeout: (callback) => callbacks.push(callback),
    clearTimeout: () => undefined,
  }
  const arms: ArmEvent[] = []
  let runs = 0
  const target = 30 * 3600 * 1000
  createScheduler(api, (event) => arms.push(event)).armAt('evaluation', target, () => {
    runs += 1
  })
  nowMs = TIMER_MAX_AHEAD_MS - 1000
  callbacks.shift()?.()
  nowMs = target - 1
  callbacks.shift()?.()
  assert.equal(runs, 0)
  nowMs = target
  callbacks.shift()?.()
  assert.equal(runs, 1)
  assert.deepEqual(
    arms.map((event) => event.delayMs),
    [TIMER_MAX_AHEAD_MS, target - (TIMER_MAX_AHEAD_MS - 1000), 1],
  )
})
