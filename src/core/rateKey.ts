import { RATE_KEY_SCALE, RATE_OUTPUT_DIVISOR } from './constants.ts'

export function rateKey(dollarsPerKwh: number): number {
  const magnitude = Math.floor(Math.abs(dollarsPerKwh) * RATE_KEY_SCALE + 0.5)
  return dollarsPerKwh < 0 ? -magnitude : magnitude
}

export function keyToCents(key: number): number {
  return key / RATE_OUTPUT_DIVISOR
}
