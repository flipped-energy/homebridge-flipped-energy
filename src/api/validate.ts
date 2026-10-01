import { type JsonRecord, isRecord } from '../core/types.ts'
import type { NoContentResult, OkResult } from './client.ts'
import type { EndpointId } from './endpoints.ts'

export type BodyShape = 'object' | 'array'

export type Validated<T> = { kind: 'valid'; body: T } | { kind: 'invalid'; message: string }

export const BODY_SHAPES: Readonly<Record<EndpointId, BodyShape>> = {
  E1: 'object',
  E2: 'object',
  E3: 'array',
  E4: 'array',
  E5: 'array',
  E6: 'object',
  E7: 'object',
}

function found(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

function parse(result: OkResult | NoContentResult, shape: BodyShape): Validated<unknown> {
  if (result.kind === 'noContent') return { kind: 'invalid', message: `body: expected ${shape === 'array' ? 'an array' : 'an object'}, got HTTP 204 with no body` }
  try {
    const body: unknown = JSON.parse(result.body)
    return { kind: 'valid', body }
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error
    return { kind: 'invalid', message: `body: HTTP ${result.status} body is not JSON: ${error.message}` }
  }
}

export function validateObject(result: OkResult | NoContentResult): Validated<JsonRecord> {
  const parsed = parse(result, 'object')
  if (parsed.kind === 'invalid') return parsed
  if (!isRecord(parsed.body)) return { kind: 'invalid', message: `body: expected an object, got ${found(parsed.body)}` }
  return { kind: 'valid', body: parsed.body }
}

export function validateArray(result: OkResult | NoContentResult): Validated<unknown[]> {
  const parsed = parse(result, 'array')
  if (parsed.kind === 'invalid') return parsed
  if (!Array.isArray(parsed.body)) return { kind: 'invalid', message: `body: expected an array, got ${found(parsed.body)}` }
  return { kind: 'valid', body: parsed.body }
}

export function validateBody(endpoint: EndpointId, result: OkResult | NoContentResult): Validated<JsonRecord | unknown[]> {
  return BODY_SHAPES[endpoint] === 'array' ? validateArray(result) : validateObject(result)
}
