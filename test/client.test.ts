import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { ApiClient, type ApiResult, type OkResult, USER_AGENT, networkMessage } from '../src/api/client.ts'
import { PATHS, accountData, meters, outlook, tokens, usageDaily, usageHalfHourly, usageWindow, wait } from '../src/api/endpoints.ts'
import { validateBody } from '../src/api/validate.ts'
import { startStub } from './helpers/stubServer.ts'

const TOKEN = 'fdk_CLIENTTEST0000000000000000000000wXyZ'
const BASE_PATH = '/developer/v1'

function clientFor(url: string, httpTimeoutS = 30, waitHttpTimeoutS = 30): ApiClient {
  return new ApiClient({ baseUrl: `${url}${BASE_PATH}`, token: TOKEN, httpTimeoutS, waitHttpTimeoutS })
}

function packageVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || typeof parsed.version !== 'string') throw new Error('package.json has no version')
  return parsed.version
}

function ok(body: string): OkResult {
  return { kind: 'ok', status: 200, body, headers: new Headers() }
}

test('sends Authorization, Accept */* and the package User-Agent, and no Origin', async () => {
  const stub = await startStub((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end('[]')
  })
  try {
    const request = wait('Ausgrid', Date.parse('2026-10-01T02:25:00Z'))
    const result = await clientFor(stub.url).get(request)
    assert.equal(result.kind, 'ok')
    const [recorded] = stub.requests
    assert.ok(recorded !== undefined)
    assert.equal(stub.requests.length, 1)
    assert.equal(recorded.method, 'GET')
    const url = new URL(recorded.url, stub.url)
    assert.equal(url.pathname, `${BASE_PATH}/api/Live/nempricing/wait`)
    assert.deepEqual(Object.fromEntries(url.searchParams), { region: 'Ausgrid', since: '2026-10-01T12:25:00', timeoutSeconds: '55' })
    assert.equal(recorded.headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(recorded.headers.accept, '*/*')
    assert.equal(recorded.headers['user-agent'], `homebridge-flipped-energy/${packageVersion()}`)
    assert.equal(USER_AGENT, `homebridge-flipped-energy/${packageVersion()}`)
    assert.equal(recorded.headers.origin, undefined)
  } finally {
    await stub.close()
  }
})

test('a 2xx answer returns the body text, status and headers', async () => {
  const stub = await startStub((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-DailyLimit-Remaining': '4870' })
    response.end('{"accounts":[]}')
  })
  try {
    const result = await clientFor(stub.url).get(accountData())
    assert.equal(result.kind, 'ok')
    if (result.kind !== 'ok') return
    assert.equal(result.status, 200)
    assert.equal(result.body, '{"accounts":[]}')
    assert.equal(result.headers.get('x-dailylimit-remaining'), '4870')
  } finally {
    await stub.close()
  }
})

test('a 302 is returned with its Location and body and is not followed', async () => {
  const target = await startStub((_request, response) => {
    response.writeHead(200)
    response.end('{}')
  })
  const location = `${target.url}/elsewhere`
  const stub = await startStub((_request, response) => {
    response.writeHead(302, { Location: location, 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Found. Redirecting')
  })
  try {
    const result = await clientFor(stub.url).get(outlook('Ausgrid'))
    assert.deepEqual(result, { kind: 'http', status: 302, body: 'Found. Redirecting', bodyBytes: 18, location })
    assert.equal(target.requests.length, 0)
  } finally {
    await stub.close()
    await target.close()
  }
})

test('a multi-line 503 body arrives byte-identical with its byte length', async () => {
  const text =
    '﻿Live price feed is Failed: System.Net.WebSockets.WebSocketException (0x80004005): café … closed\r\n' +
    '   at Flipped.Home.Services.NemPriceFeed.ListenAsync(CancellationToken ct)\n' +
    '   at Flipped.Home.Services.NemPriceFeed.ExecuteAsync(CancellationToken stoppingToken)\n\n'
  const bytes = Buffer.from(text, 'utf8')
  const stub = await startStub((_request, response) => {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end(bytes)
  })
  try {
    const result = await clientFor(stub.url).get(wait('Ausgrid', Date.parse('2026-10-01T03:55:00Z')))
    assert.equal(result.kind, 'http')
    if (result.kind !== 'http') return
    assert.equal(result.status, 503)
    assert.equal(result.bodyBytes, bytes.byteLength)
    assert.ok(Buffer.from(result.body, 'utf8').equals(bytes))
    assert.equal(result.body, text)
    assert.equal(result.retryAfterS, undefined)
    assert.equal(result.location, undefined)
  } finally {
    await stub.close()
  }
})

test('a 204 is noContent', async () => {
  const stub = await startStub((_request, response) => {
    response.writeHead(204)
    response.end()
  })
  try {
    assert.deepEqual(await clientFor(stub.url).get(wait('Ausgrid', Date.parse('2026-10-01T02:25:00Z'))), { kind: 'noContent' })
  } finally {
    await stub.close()
  }
})

const RATE_LIMITED = '{"error":"rate_limited","message":"Over 60 calls this minute."}'

async function answer429(retryAfter: string | null): Promise<ApiResult> {
  const stub = await startStub((_request, response) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' }
    if (retryAfter !== null) headers['Retry-After'] = retryAfter
    response.writeHead(429, headers)
    response.end(RATE_LIMITED)
  })
  try {
    return await clientFor(stub.url).get(meters())
  } finally {
    await stub.close()
  }
}

test('a 429 with an integer Retry-After carries retryAfterS and the body', async () => {
  assert.deepEqual(await answer429('17'), { kind: 'http', status: 429, body: RATE_LIMITED, bodyBytes: 63, retryAfterS: 17 })
})

test('a 429 whose Retry-After is missing or not an integer carries the invalid_response message instead', async () => {
  assert.deepEqual(await answer429(null), {
    kind: 'http',
    status: 429,
    body: RATE_LIMITED,
    bodyBytes: 63,
    retryAfterError: 'Retry-After: expected an integer number of seconds, got missing',
  })
  assert.deepEqual(await answer429('1.5'), {
    kind: 'http',
    status: 429,
    body: RATE_LIMITED,
    bodyBytes: 63,
    retryAfterError: 'Retry-After: expected an integer number of seconds, got "1.5"',
  })
})

test('a stub that never answers gives network with the platform timeout text, E3 on the wait timeout', { timeout: 10000 }, async () => {
  const stub = await startStub(() => undefined)
  try {
    const plain = await clientFor(stub.url, 0.2, 30).get(tokens())
    assert.equal(plain.kind, 'network')
    if (plain.kind !== 'network') return
    assert.equal(plain.message, 'The operation was aborted due to timeout')
    assert.ok(plain.error instanceof Error)
    const held = await clientFor(stub.url, 30, 0.2).get(wait('Ausgrid', Date.parse('2026-10-01T02:25:00Z')))
    assert.equal(held.kind, 'network')
    if (held.kind !== 'network') return
    assert.equal(held.message, 'The operation was aborted due to timeout')
  } finally {
    await stub.close()
  }
})

test('stop aborts the request in flight', { timeout: 10000 }, async () => {
  let markArrived: () => void = () => undefined
  const arrived = new Promise<void>((resolve) => {
    markArrived = resolve
  })
  const stub = await startStub(() => markArrived())
  try {
    const client = clientFor(stub.url)
    const pending = client.get(accountData())
    await arrived
    client.stop()
    const result = await pending
    assert.equal(result.kind, 'network')
    if (result.kind !== 'network') return
    assert.equal(result.message, 'This operation was aborted')
  } finally {
    await stub.close()
  }
})

test('a refused connection gives the innermost cause text', async () => {
  const stub = await startStub(() => undefined)
  await stub.close()
  const port = new URL(stub.url).port
  const result = await clientFor(stub.url).get(accountData())
  assert.equal(result.kind, 'network')
  if (result.kind !== 'network') return
  assert.equal(result.message, `connect ECONNREFUSED 127.0.0.1:${port}`)
})

test('networkMessage reads the innermost cause of fetch failed, and an AggregateError by its errors', () => {
  const dns = new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND example.invalid') })
  assert.equal(networkMessage(dns), 'getaddrinfo ENOTFOUND example.invalid')
  const both = new TypeError('fetch failed', {
    cause: new AggregateError([new Error('connect ECONNREFUSED ::1:47811'), new Error('connect ECONNREFUSED 127.0.0.1:47811')], ''),
  })
  assert.equal(networkMessage(both), 'connect ECONNREFUSED ::1:47811\nconnect ECONNREFUSED 127.0.0.1:47811')
  assert.equal(networkMessage(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 'The operation was aborted due to timeout')
})

test('endpoints format since as NEM wall clock and the usage window as local midnights', () => {
  assert.deepEqual(wait('Ausgrid', Date.parse('2026-10-01T02:25:00Z')).query, { region: 'Ausgrid', since: '2026-10-01T12:25:00', timeoutSeconds: '55' })
  assert.deepEqual(wait('SAPN', Date.parse('2026-12-31T14:00:00Z')).query.since, '2027-01-01T00:00:00')
  const window = usageWindow(Date.parse('2026-09-30T14:30:00Z'), 'Australia/Sydney')
  assert.deepEqual(window, { start: '2026-09-24T00:00:00', end: '2026-10-02T00:00:00' })
  assert.deepEqual(usageHalfHourly(window, '4102000000'), {
    endpoint: 'E4',
    path: '/api/Usage/usage/projectreads/halfhourly',
    query: { start: '2026-09-24T00:00:00', end: '2026-10-02T00:00:00', nmi: '4102000000' },
  })
  assert.deepEqual(usageDaily(usageWindow(Date.parse('2027-03-01T05:00:00Z'), 'Australia/Adelaide'), '4102000000').query, {
    start: '2027-02-22T00:00:00',
    end: '2027-03-02T00:00:00',
    nmi: '4102000000',
  })
})

test('every request path of the shared sequences is one of the endpoint paths', () => {
  const directory = new URL('./sequences/', import.meta.url)
  const known: string[] = Object.values(PATHS)
  const seen = new Set<string>()
  for (const name of readdirSync(directory).filter((file) => file.endsWith('.json') && file !== 'index.json')) {
    const parsed: unknown = JSON.parse(readFileSync(new URL(name, directory), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || !('responses' in parsed) || !Array.isArray(parsed.responses)) throw new Error(`${name}: no responses array`)
    for (const response of parsed.responses) {
      if (typeof response !== 'object' || response === null || !('path' in response) || typeof response.path !== 'string') throw new Error(`${name}: response without path`)
      seen.add(response.path)
    }
  }
  assert.ok(seen.size > 0)
  for (const path of seen) assert.ok(known.includes(path), path)
})

test('validate accepts JSON of the expected top-level type and names what it found otherwise', () => {
  assert.deepEqual(validateBody('E1', ok('{"accounts":null}')), { kind: 'valid', body: { accounts: null } })
  assert.deepEqual(validateBody('E3', ok('[]')), { kind: 'valid', body: [] })
  assert.deepEqual(validateBody('E4', ok('{}')), { kind: 'invalid', message: 'body: expected an array, got an object' })
  assert.deepEqual(validateBody('E6', ok('[]')), { kind: 'invalid', message: 'body: expected an object, got an array' })
  assert.deepEqual(validateBody('E7', ok('null')), { kind: 'invalid', message: 'body: expected an object, got null' })
  assert.deepEqual(validateBody('E2', { kind: 'noContent' }), { kind: 'invalid', message: 'body: expected an object, got HTTP 204 with no body' })
  let syntax = ''
  try {
    JSON.parse('<html>')
  } catch (error: unknown) {
    if (error instanceof SyntaxError) syntax = error.message
  }
  assert.notEqual(syntax, '')
  assert.deepEqual(validateBody('E5', ok('<html>')), { kind: 'invalid', message: `body: HTTP 200 body is not JSON: ${syntax}` })
})
