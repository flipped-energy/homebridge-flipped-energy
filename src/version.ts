import { readFileSync } from 'node:fs'

function readVersion(): string {
  const location = new URL('../package.json', import.meta.url)
  const parsed: unknown = JSON.parse(readFileSync(location, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || typeof parsed.version !== 'string') {
    throw new Error(`${location.pathname} has no string "version"`)
  }
  return parsed.version
}

export const VERSION = readVersion()
