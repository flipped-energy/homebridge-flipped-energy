import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PATHS } from '../src/api/endpoints.ts'
import { type Replay, SEQUENCE_SETS, type Sequence, replay, replayFile } from './helpers/sequenceReplay.ts'
import type { HttpAnswer } from './helpers/scriptedTransport.ts'

for (const name of SEQUENCE_SETS.sync) {
  test(`sequence ${name}`, async () => {
    await replayFile(name)
  })
}

const START = '2026-10-01T02:21:10Z'

function e1(answer: HttpAnswer): Sequence['responses'][number] {
  return { method: 'GET', path: PATHS.E1, query: {}, answer }
}

async function startUp(end: string, answers: HttpAnswer[]): Promise<Replay> {
  const sequence: Sequence = {
    name: 'start-up E1 failure',
    description: '',
    start: START,
    end,
    restarts: [],
    config: { token: 'fdk_SEQUENCEFIXTURE000000000000000000wXyZ', accountNumber: null, nmi: null, priceHighThresholdCentsPerKwh: null, priceLowThresholdCentsPerKwh: null },
    responses: answers.map(e1),
    expected: { requests: [], timers: [], groups: { account: { status: 'faulted', fault: null }, tariff: { status: 'faulted', fault: null }, price: { status: 'faulted', fault: null }, energy: { status: 'faulted', fault: null } }, storedAccountNumber: null },
  }
  const directory = mkdtempSync(join(tmpdir(), 'flipped-startup-'))
  try {
    const result = await replay(sequence, directory)
    assert.deepEqual(result.routineFailures, [])
    return result
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const json = { 'Content-Type': 'application/json; charset=utf-8' }
const unavailable: HttpAnswer = { status: 503, headers: { 'Content-Type': 'text/plain' }, body: 'upstream connect error or disconnect/reset before headers. reset reason: connection termination' }

test('start-up E1 answering 503: next E1 at each 5-minute UTC boundary', async () => {
  const result = await startUp('2026-10-01T02:26:00Z', [unavailable, unavailable])
  assert.deepEqual(result.requests.map((request) => request.sendAt), [START, '2026-10-01T02:25:00Z'])
  assert.deepEqual(result.timers, [
    { armedAt: START, timer: 'startup', target: '2026-10-01T02:25:00Z', delaySeconds: 230 },
    { armedAt: '2026-10-01T02:25:00Z', timer: 'startup', target: '2026-10-01T02:30:00Z', delaySeconds: 300 },
  ])
  assert.deepEqual(result.signals.account.fault, { code: 'http_error', httpStatus: 503, body: unavailable.body, bodyBytes: Buffer.byteLength(String(unavailable.body)) })
})

test('start-up E1 answering 403: next E1 at the next 00:01:00 UTC', async () => {
  const refused: HttpAnswer = { status: 403, headers: json, body: '{"error":"developer_mode_disabled","message":"Developer access is turned off for this account."}' }
  const result = await startUp('2026-10-02T00:02:00Z', [refused, refused])
  assert.deepEqual(result.requests.map((request) => request.sendAt), [START, '2026-10-02T00:01:00Z'])
  assert.deepEqual(result.timers, [
    { armedAt: START, timer: 'startup', target: '2026-10-02T00:01:00Z', delaySeconds: 77990 },
    { armedAt: '2026-10-02T00:01:00Z', timer: 'startup', target: '2026-10-03T00:01:00Z', delaySeconds: 86400 },
  ])
})

test('start-up E1 answering 401 with the gateway body or 400: nothing further', async () => {
  for (const answer of [
    { status: 401, headers: json, body: '{"error":"unauthorized","message":"Token is invalid, expired or revoked."}' },
    { status: 400, headers: { 'Content-Type': 'text/plain' }, body: 'Region is required' },
  ]) {
    const result = await startUp('2026-10-03T00:00:00Z', [answer])
    assert.equal(result.requests.length, 1)
    assert.deepEqual(result.timers, [])
  }
})

test('start-up E1 answering 429: the same E1 once after Retry-After, nothing else before it', async () => {
  const limited: HttpAnswer = { status: 429, headers: { ...json, 'Retry-After': '17' }, body: '{"error":"rate_limited","message":"Over 60 calls this minute."}' }
  const result = await startUp('2026-10-01T02:24:00Z', [limited, unavailable])
  assert.deepEqual(result.requests.map((request) => request.sendAt), [START, '2026-10-01T02:21:27Z'])
  assert.deepEqual(result.timers, [
    { armedAt: START, timer: 'retryAfter', target: '2026-10-01T02:21:27Z', delaySeconds: 17 },
    { armedAt: '2026-10-01T02:21:27Z', timer: 'startup', target: '2026-10-01T02:25:00Z', delaySeconds: 213 },
  ])
})

test('429 without Retry-After is invalid_response', async () => {
  const limited: HttpAnswer = { status: 429, headers: json, body: '{"error":"rate_limited","message":"Over 60 calls this minute."}' }
  const result = await startUp('2026-10-01T02:24:00Z', [limited])
  assert.deepEqual(result.signals.account.fault, { code: 'invalid_response', message: 'Retry-After: expected an integer number of seconds, got missing' })
  assert.deepEqual(result.timers, [{ armedAt: START, timer: 'startup', target: '2026-10-01T02:25:00Z', delaySeconds: 230 }])
})
