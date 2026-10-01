import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { describe, test } from 'node:test'
import { computeSignals } from '../src/core/computeSignals.ts'
import { VECTOR_TOLERANCE } from '../src/core/constants.ts'
import type { SignalConfig, Snapshot } from '../src/core/types.ts'

interface IndexEntry {
  path: string
  sha256: string
}

interface VectorInput {
  instant: string | null
  config: SignalConfig
  account: Snapshot
  meters: Snapshot
  tokens: Snapshot
  outlook: Snapshot
  usageHalfHourly: Snapshot
  usageDaily: Snapshot
}

interface Vector {
  name: string
  input: VectorInput
  expected: unknown
}

const vectorsDirectory = new URL('./vectors/', import.meta.url)
const specDirectory = new URL('../../spec/vectors/', import.meta.url)
const faultOptional = ['httpStatus', 'body', 'bodyBytes']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function differences(expected: unknown, actual: unknown, path: string, out: string[]): void {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !(Math.abs(expected - actual) <= VECTOR_TOLERANCE)) out.push(`${path}: expected ${expected}, got ${JSON.stringify(actual)}`)
    return
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      out.push(`${path}: expected an array, got ${JSON.stringify(actual)}`)
      return
    }
    if (expected.length !== actual.length) out.push(`${path}: expected ${expected.length} elements, got ${actual.length}`)
    expected.forEach((item, index) => differences(item, actual[index], `${path}[${index}]`, out))
    return
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      out.push(`${path}: expected an object, got ${JSON.stringify(actual)}`)
      return
    }
    const isFault = path.endsWith('.fault')
    for (const key of Object.keys(expected)) {
      if (isFault && key === 'message') continue
      differences(expected[key], actual[key], `${path}.${key}`, out)
    }
    for (const key of Object.keys(actual)) {
      if (key in expected) continue
      if (isFault && (key === 'message' || faultOptional.includes(key))) continue
      out.push(`${path}.${key}: unexpected member ${JSON.stringify(actual[key])}`)
    }
    return
  }
  if (expected !== actual) out.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const indexBytes = readFileSync(new URL('index.json', vectorsDirectory))
const index: IndexEntry[] = JSON.parse(indexBytes.toString('utf8'))

function listedFiles(directory: URL, prefix: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...listedFiles(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`))
    else if (prefix !== '') found.push(`${prefix}${entry.name}`)
  }
  return found
}

test('test/vectors holds exactly the files of index.json', () => {
  assert.deepEqual(listedFiles(vectorsDirectory, '').sort(), index.map((entry) => entry.path).sort())
})

test('test/vectors/index.json is byte-identical with spec/vectors/index.json', { skip: !existsSync(specDirectory) }, () => {
  assert.equal(sha256(indexBytes), sha256(readFileSync(new URL('index.json', specDirectory))))
})

describe('conformance vectors', () => {
  for (const entry of index) {
    test(entry.path, () => {
      const bytes = readFileSync(new URL(entry.path, vectorsDirectory))
      assert.equal(sha256(bytes), entry.sha256, `${entry.path}: SHA-256 differs from index.json`)
      if (existsSync(specDirectory)) assert.ok(bytes.equals(readFileSync(new URL(entry.path, specDirectory))), `${entry.path}: differs from spec/vectors`)
      const vector: Vector = JSON.parse(bytes.toString('utf8'))
      const { input } = vector
      const actual = computeSignals(input.instant, input.config, input.account, input.meters, input.tokens, input.outlook, input.usageHalfHourly, input.usageDaily)
      const found: string[] = []
      differences(vector.expected, actual, 'expected', found)
      assert.deepEqual(found, [], `${vector.name}:\n${found.join('\n')}`)
    })
  }
})
