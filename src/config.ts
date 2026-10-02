import { readFileSync } from 'node:fs'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.ts'

export type SignalService = 'switch' | 'occupancySensor' | 'contactSensor'

export const SIGNAL_SERVICES: readonly SignalService[] = ['switch', 'occupancySensor', 'contactSensor']

export const TOKEN_PREFIX = 'fdk_'

export interface Config {
  name: string
  token: string
  accountNumber: string | null
  nmi: string | null
  priceHighThresholdCentsPerKwh: number | null
  priceLowThresholdCentsPerKwh: number | null
  signalService: SignalService
  availabilitySensors: boolean
  tokenExpiringSensor: boolean
  wholesalePriceSensor: boolean
  wholesalePriceLevelSensor: boolean
  eveHistory: boolean
  matterEnergy: boolean
}

export type ParsedConfig = { kind: 'ok'; config: Config } | { kind: 'error'; errors: string[] }

type BooleanKey = 'availabilitySensors' | 'tokenExpiringSensor' | 'wholesalePriceSensor' | 'wholesalePriceLevelSensor' | 'eveHistory' | 'matterEnergy'

const BOOLEAN_DEFAULTS: Readonly<Record<BooleanKey, boolean>> = {
  availabilitySensors: true,
  tokenExpiringSensor: false,
  wholesalePriceSensor: true,
  wholesalePriceLevelSensor: false,
  eveHistory: true,
  matterEnergy: false,
}

const DEFAULT_NAME = 'Flipped Energy'
const DEFAULT_SIGNAL_SERVICE: SignalService = 'switch'

const PLATFORM_IDS: readonly string[] = [PLATFORM_NAME, `${PLUGIN_NAME}.${PLATFORM_NAME}`]

type Fields = Record<string, unknown>

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === undefined) return 'missing'
  if (typeof value === 'number') return String(value)
  return JSON.stringify(value)
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

function isSignalService(value: unknown): value is SignalService {
  return typeof value === 'string' && SIGNAL_SERVICES.some((service) => service === value)
}

function readToken(value: unknown, errors: string[]): string {
  if (typeof value !== 'string') {
    errors.push(`token: expected a string starting with "${TOKEN_PREFIX}", got ${value === undefined ? 'missing' : typeName(value)}`)
    return ''
  }
  if (!value.startsWith(TOKEN_PREFIX)) {
    errors.push(`token: expected a string starting with "${TOKEN_PREFIX}", got a string of ${value.length} characters that does not`)
    return ''
  }
  return value
}

function readOptionalText(raw: Fields, key: 'accountNumber' | 'nmi', errors: string[]): string | null {
  const value = raw[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${key}: expected a non-empty string, got ${describe(value)}`)
    return null
  }
  return value
}

function readThreshold(raw: Fields, key: 'priceHighThresholdCentsPerKwh' | 'priceLowThresholdCentsPerKwh', errors: string[]): number | null {
  const value = raw[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${key}: expected a finite number, got ${describe(value)}`)
    return null
  }
  return value
}

function readBoolean(raw: Fields, key: BooleanKey, errors: string[]): boolean {
  const value = raw[key]
  if (value === undefined) return BOOLEAN_DEFAULTS[key]
  if (typeof value !== 'boolean') {
    errors.push(`${key}: expected a boolean, got ${describe(value)}`)
    return BOOLEAN_DEFAULTS[key]
  }
  return value
}

function readName(raw: Fields, errors: string[]): string {
  const value = raw.name
  if (value === undefined) return DEFAULT_NAME
  if (typeof value !== 'string') {
    errors.push(`name: expected a string, got ${describe(value)}`)
    return DEFAULT_NAME
  }
  return value
}

function readSignalService(raw: Fields, errors: string[]): SignalService {
  const value = raw.signalService
  if (value === undefined) return DEFAULT_SIGNAL_SERVICE
  if (!isSignalService(value)) {
    errors.push(`signalService: expected ${SIGNAL_SERVICES.map((service) => JSON.stringify(service)).join(', ')}, got ${describe(value)}`)
    return DEFAULT_SIGNAL_SERVICE
  }
  return value
}

function hasMatterBridge(raw: Fields): boolean {
  const bridge = raw._bridge
  return isObject(bridge) && isObject(bridge.matter)
}

export function parseConfig(raw: unknown): ParsedConfig {
  if (!isObject(raw)) return { kind: 'error', errors: [`config: expected an object, got ${describe(raw)}`] }
  const errors: string[] = []
  const config: Config = {
    name: readName(raw, errors),
    token: readToken(raw.token, errors),
    accountNumber: readOptionalText(raw, 'accountNumber', errors),
    nmi: readOptionalText(raw, 'nmi', errors),
    priceHighThresholdCentsPerKwh: readThreshold(raw, 'priceHighThresholdCentsPerKwh', errors),
    priceLowThresholdCentsPerKwh: readThreshold(raw, 'priceLowThresholdCentsPerKwh', errors),
    signalService: readSignalService(raw, errors),
    availabilitySensors: readBoolean(raw, 'availabilitySensors', errors),
    tokenExpiringSensor: readBoolean(raw, 'tokenExpiringSensor', errors),
    wholesalePriceSensor: readBoolean(raw, 'wholesalePriceSensor', errors),
    wholesalePriceLevelSensor: readBoolean(raw, 'wholesalePriceLevelSensor', errors),
    eveHistory: readBoolean(raw, 'eveHistory', errors),
    matterEnergy: readBoolean(raw, 'matterEnergy', errors),
  }
  const high = config.priceHighThresholdCentsPerKwh
  const low = config.priceLowThresholdCentsPerKwh
  if (high !== null && low !== null && low >= high) {
    errors.push(`priceLowThresholdCentsPerKwh (${low}) must be less than priceHighThresholdCentsPerKwh (${high})`)
  }
  return errors.length > 0 ? { kind: 'error', errors } : { kind: 'ok', config }
}

export function tokenPreview(token: string): string {
  return `${token.slice(0, 8)}…${token.slice(-4)}`
}

export function isFlippedBlock(block: unknown): boolean {
  return isObject(block) && typeof block.platform === 'string' && PLATFORM_IDS.includes(block.platform)
}

function settingOf(value: unknown): string {
  return value === undefined || value === null ? 'not set' : JSON.stringify(value)
}

export interface FileBlock {
  index: number
  block: Fields
}

export interface OwnBlock extends FileBlock {
  first: boolean
}

function fileBlocks(file: unknown, source: string): FileBlock[] {
  if (!isObject(file)) throw new Error(`${source}: expected a JSON object, got ${typeName(file)}`)
  const platforms = file.platforms
  if (!Array.isArray(platforms)) throw new Error(`${source}: "platforms" is not an array, got ${platforms === undefined ? 'missing' : typeName(platforms)}`)
  const blocks: FileBlock[] = []
  platforms.forEach((block: unknown, index) => {
    if (isObject(block) && isFlippedBlock(block)) blocks.push({ index, block })
  })
  return blocks
}

export function blockRuleErrors(file: unknown, source: string): string[] {
  const blocks = fileBlocks(file, source)
  const errors: string[] = []
  if (blocks.length > 1) {
    for (const { index, block } of blocks) {
      const accountNumber = block.accountNumber
      if (typeof accountNumber !== 'string' || accountNumber.length === 0) {
        errors.push(
          `${source} platforms[${index}]: accountNumber is ${settingOf(accountNumber)}; with ${blocks.length} ${PLATFORM_NAME} blocks every block must set accountNumber`,
        )
      }
    }
  }
  for (let first = 0; first < blocks.length; first += 1) {
    const a = blocks[first]
    if (a === undefined || typeof a.block.accountNumber !== 'string' || a.block.accountNumber.length === 0) continue
    for (let second = first + 1; second < blocks.length; second += 1) {
      const b = blocks[second]
      if (b === undefined || b.block.accountNumber !== a.block.accountNumber) continue
      if (settingOf(a.block.nmi) !== settingOf(b.block.nmi)) continue
      errors.push(
        `${source} platforms[${a.index}] and platforms[${b.index}]: same accountNumber ${JSON.stringify(a.block.accountNumber)} and same nmi (${settingOf(a.block.nmi)}); two ${PLATFORM_NAME} blocks may not serve the same account and nmi`,
      )
    }
  }
  return errors
}

export function ownBlock(file: unknown, source: string, config: Config): OwnBlock {
  const blocks = fileBlocks(file, source)
  const matching = blocks.length === 1 ? blocks : blocks.filter(({ block }) => block.accountNumber === config.accountNumber && (block.nmi ?? null) === config.nmi)
  const [own, other] = matching
  if (own === undefined || other !== undefined) {
    throw new Error(`${source}: ${matching.length} ${PLATFORM_NAME} blocks have accountNumber ${settingOf(config.accountNumber)} and nmi ${settingOf(config.nmi)}; expected exactly 1`)
  }
  return { ...own, first: own === blocks[0] }
}

export function matterBridgeErrors(own: OwnBlock, source: string, config: Config): string[] {
  if (!config.matterEnergy || hasMatterBridge(own.block)) return []
  return [`${source} platforms[${own.index}]: matterEnergy: true needs this block on a child bridge with Matter enabled, and the block has no "_bridge" object with a "matter" object in it`]
}

export function readBlockRuleErrors(configPath: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
  return blockRuleErrors(parsed, configPath)
}
