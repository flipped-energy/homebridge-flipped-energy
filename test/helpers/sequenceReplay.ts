import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MS_PER_SECOND } from '../../src/core/constants.ts'
import { formatInstant } from '../../src/core/time.ts'
import type { Fault, Signals } from '../../src/core/types.ts'
import { Instance, type InstanceConfig } from '../../src/runtime/instance.ts'
import type { RuntimeLog } from '../../src/runtime/requestGate.ts'
import { type ArmEvent, type TimerName, createScheduler } from '../../src/runtime/scheduler.ts'
import { StateStore } from '../../src/runtime/stateStore.ts'
import { FakeClock } from './fakeClock.ts'
import { Script, type ScriptedResponse } from './scriptedTransport.ts'

export const SEQUENCES_DIR = new URL('../sequences/', import.meta.url)

export const SEQUENCE_SETS = {
  priceLoop: ['price-loop-basics', 'feed-503-hour', 'late-price-hour', 'outlook-failure-after-release', 'redirect-not-followed'],
  sync: ['account-sync-failure-retried-at-usage-sync', 'non-gateway-401-account-sync', 'evaluation-timer-30h', 'long-plan-timer-cap'],
  instance: ['first-run-account-pinning'],
} as const

export interface ExpectedRequest {
  sendAt: string
  path: string
  query: Record<string, string>
}

export interface ExpectedTimer {
  armedAt: string
  timer: TimerName
  target: string
  delaySeconds: number
}

export interface ExpectedGroup {
  status: 'ok' | 'faulted'
  fault: Partial<Fault> | null
}

export interface Sequence {
  name: string
  description: string
  start: string
  end: string
  restarts: string[]
  config: InstanceConfig
  responses: ScriptedResponse[]
  expected: {
    requests: ExpectedRequest[]
    timers: ExpectedTimer[]
    groups: Record<'account' | 'tariff' | 'price' | 'energy', ExpectedGroup>
    storedAccountNumber: string | null
  }
}

export interface IndexEntry {
  path: string
  sha256: string
}

export interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
}

export interface Replay {
  requests: ExpectedRequest[]
  methods: string[]
  timers: ExpectedTimer[]
  signals: Signals
  accountNumber: string | null
  routineFailures: unknown[]
  log: LogLine[]
  stateDirectory: string
  answered: number
  transportStops: number
  pendingAfterStop: number
}

export function readIndex(): IndexEntry[] {
  const parsed: IndexEntry[] = JSON.parse(readFileSync(new URL('index.json', SEQUENCES_DIR), 'utf8'))
  return parsed
}

export function loadSequence(name: string): Sequence {
  const bytes = readFileSync(new URL(`${name}.json`, SEQUENCES_DIR))
  const entry = readIndex().find((candidate) => candidate.path === `${name}.json`)
  assert.ok(entry !== undefined, `${name}.json is not listed in test/sequences/index.json`)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${name}.json: SHA-256 differs from index.json`)
  const sequence: Sequence = JSON.parse(bytes.toString('utf8'))
  return sequence
}

export function recordingLog(lines: LogLine[]): RuntimeLog {
  return {
    debug: (message) => lines.push({ level: 'debug', message }),
    info: (message) => lines.push({ level: 'info', message }),
    warn: (message) => lines.push({ level: 'warn', message }),
    error: (message) => lines.push({ level: 'error', message }),
  }
}

function timerOf(event: ArmEvent): ExpectedTimer {
  return {
    armedAt: formatInstant(event.armedAtMs),
    timer: event.timer,
    target: formatInstant(event.targetMs),
    delaySeconds: event.delayMs / MS_PER_SECOND,
  }
}

function byArmedAtThenTimer(a: ExpectedTimer, b: ExpectedTimer): number {
  if (a.armedAt !== b.armedAt) return a.armedAt < b.armedAt ? -1 : 1
  if (a.timer !== b.timer) return a.timer < b.timer ? -1 : 1
  return 0
}

export async function replay(sequence: Sequence, stateDirectory: string): Promise<Replay> {
  const clock = new FakeClock(Date.parse(sequence.start))
  const arms: ArmEvent[] = []
  const scheduler = createScheduler(clock, (event) => arms.push(event))
  const script = new Script(clock, sequence.responses)
  const log: LogLine[] = []
  const routineFailures: unknown[] = []
  const store = new StateStore(stateDirectory)
  const create = (): Instance =>
    new Instance({
      config: sequence.config,
      transport: script.transport(),
      scheduler,
      store,
      log: recordingLog(log),
      signalsChanged: () => undefined,
      routineFailed: (error) => routineFailures.push(error),
    })
  let instance = create()
  for (const restart of sequence.restarts) {
    clock.setTimeout(() => {
      instance.stop()
      instance = create()
      instance.start()
    }, Date.parse(restart) - clock.now())
  }
  instance.start()
  await clock.runUntil(Date.parse(sequence.end))
  const result: Replay = {
    requests: script.sent.map((sent) => ({ sendAt: formatInstant(sent.sendAtMs), path: sent.path, query: sent.query })),
    methods: script.sent.map((sent) => sent.method),
    timers: arms.map(timerOf).sort(byArmedAtThenTimer),
    signals: instance.signals,
    accountNumber: instance.accountNumber,
    routineFailures,
    log,
    stateDirectory,
    answered: script.answered,
    transportStops: script.stops,
    pendingAfterStop: 0,
  }
  instance.stop()
  result.transportStops = script.stops
  result.pendingAfterStop = clock.pendingCount
  return result
}

export function assertGroups(signals: Signals, expected: Sequence['expected']['groups']): void {
  for (const group of ['account', 'tariff', 'price', 'energy'] as const) {
    const actual = signals[group]
    const wanted = expected[group]
    assert.equal(actual.status, wanted.status, `${group}.status (fault ${JSON.stringify(actual.fault)})`)
    if (wanted.fault === null) {
      assert.equal(actual.fault, null, `${group}.fault`)
      continue
    }
    assert.notEqual(actual.fault, null, `${group}.fault`)
    for (const [key, value] of Object.entries(wanted.fault)) {
      const fields: Record<string, unknown> = { ...actual.fault }
      assert.deepEqual(fields[key], value, `${group}.fault.${key}`)
    }
  }
}

export function assertReplay(sequence: Sequence, result: Replay): void {
  assert.deepEqual(result.routineFailures, [])
  assert.deepEqual(result.requests, sequence.expected.requests)
  assert.deepEqual(result.methods, sequence.responses.map((response) => response.method))
  assert.equal(result.answered, sequence.responses.length)
  assert.deepEqual(result.timers, [...sequence.expected.timers].sort(byArmedAtThenTimer))
  assertGroups(result.signals, sequence.expected.groups)
  assert.equal(result.accountNumber, sequence.expected.storedAccountNumber)
}

export async function replayFile(name: string): Promise<Replay> {
  const sequence = loadSequence(name)
  const directory = mkdtempSync(join(tmpdir(), `flipped-${name}-`))
  try {
    const result = await replay(sequence, directory)
    assertReplay(sequence, result)
    return result
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
