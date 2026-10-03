import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { type Config, blockRuleErrors, matterBridgeErrors, ownBlock, parseConfig, readBlockRuleErrors, tokenPreview } from '../src/config.ts'

const TOKEN = 'fdk_Ab12CONFIGTEST000000000000000000wXyZ'
const SOURCE = '/homebridge/config.json'

function errorsOf(raw: unknown): string[] {
  const parsed = parseConfig(raw)
  if (parsed.kind === 'ok') throw new Error(`expected configuration errors, got ${JSON.stringify(parsed.config)}`)
  return parsed.errors
}

function block(fields: Record<string, unknown>): Record<string, unknown> {
  return { platform: 'FlippedEnergy', name: 'Flipped Energy', token: TOKEN, ...fields }
}

function configOf(raw: Record<string, unknown>): Config {
  const parsed = parseConfig(raw)
  if (parsed.kind === 'error') throw new Error(parsed.errors.join('\n'))
  return parsed.config
}

const CHILD = { username: '0E:12:34:56:78:9A', port: 51234 }

test('a block with only a token parses with the schema defaults', () => {
  const expected: Config = {
    name: 'Flipped Energy',
    virtualDevices: true,
    token: TOKEN,
    accountNumber: null,
    nmi: null,
    priceHighThresholdCentsPerKwh: null,
    priceLowThresholdCentsPerKwh: null,
    signalService: 'switch',
    availabilitySensors: true,
    tokenExpiringSensor: false,
    wholesalePriceSensor: true,
    wholesalePriceLevelSensor: false,
    eveHistory: true,
    matterEnergy: false,
  }
  assert.deepEqual(parseConfig({ platform: 'FlippedEnergy', token: TOKEN }), { kind: 'ok', config: expected })
})

test('every option is read as given', () => {
  const raw = block({
    name: 'Home',
    virtualDevices: true,
    accountNumber: '36200000000001',
    nmi: '4102000000',
    priceHighThresholdCentsPerKwh: 30,
    priceLowThresholdCentsPerKwh: -2.5,
    signalService: 'contactSensor',
    availabilitySensors: false,
    tokenExpiringSensor: true,
    wholesalePriceSensor: false,
    wholesalePriceLevelSensor: true,
    eveHistory: false,
    matterEnergy: true,
  })
  assert.deepEqual(parseConfig(raw), {
    kind: 'ok',
    config: {
      name: 'Home',
    virtualDevices: true,
      token: TOKEN,
      accountNumber: '36200000000001',
      nmi: '4102000000',
      priceHighThresholdCentsPerKwh: 30,
      priceLowThresholdCentsPerKwh: -2.5,
      signalService: 'contactSensor',
      availabilitySensors: false,
      tokenExpiringSensor: true,
      wholesalePriceSensor: false,
      wholesalePriceLevelSensor: true,
      eveHistory: false,
      matterEnergy: true,
    },
  })
})

test('a missing token is an error', () => {
  assert.deepEqual(errorsOf({ platform: 'FlippedEnergy' }), ['token: expected a string starting with "fdk_", got missing'])
})

test('a token not starting with fdk_ is an error that does not print the token', () => {
  const errors = errorsOf(block({ token: 'abc_secretvalue1234' }))
  assert.deepEqual(errors, ['token: expected a string starting with "fdk_", got a string of 19 characters that does not'])
  assert.deepEqual(errorsOf(block({ token: 1234 })), ['token: expected a string starting with "fdk_", got a number'])
})

test('a threshold that is not a finite number is an error', () => {
  assert.deepEqual(errorsOf(block({ priceHighThresholdCentsPerKwh: '30' })), ['priceHighThresholdCentsPerKwh: expected a finite number, got "30"'])
  assert.deepEqual(errorsOf(block({ priceLowThresholdCentsPerKwh: Number.NaN })), ['priceLowThresholdCentsPerKwh: expected a finite number, got NaN'])
})

test('both thresholds set with low not below high is an error', () => {
  assert.deepEqual(errorsOf(block({ priceHighThresholdCentsPerKwh: 20, priceLowThresholdCentsPerKwh: 20 })), [
    'priceLowThresholdCentsPerKwh (20) must be less than priceHighThresholdCentsPerKwh (20)',
  ])
  assert.equal(parseConfig(block({ priceHighThresholdCentsPerKwh: 20, priceLowThresholdCentsPerKwh: 19.99 })).kind, 'ok')
})

test('a signalService outside the three values is an error', () => {
  assert.deepEqual(errorsOf(block({ signalService: 'lightbulb' })), ['signalService: expected "switch", "occupancySensor", "contactSensor", got "lightbulb"'])
})

test('a boolean option that is not a boolean is an error', () => {
  const keys = ['availabilitySensors', 'tokenExpiringSensor', 'wholesalePriceSensor', 'wholesalePriceLevelSensor', 'eveHistory', 'matterEnergy']
  for (const key of keys) assert.deepEqual(errorsOf(block({ [key]: 'true' })), [`${key}: expected a boolean, got "true"`])
})

test('matterEnergy parses without a _bridge object, as Homebridge deletes _bridge before it builds the platform', () => {
  assert.equal(parseConfig(block({ matterEnergy: true })).kind, 'ok')
})

test('matterEnergy whose block in config.json has no _bridge object holding a matter object is an error', () => {
  const config = configOf(block({ matterEnergy: true }))
  const message = `${SOURCE} platforms[1]: matterEnergy: true needs this block on a child bridge with Matter enabled, and the block has no "_bridge" object with a "matter" object in it`
  const file = (fields: Record<string, unknown>): unknown => ({ platforms: [{ platform: 'Other' }, block({ matterEnergy: true, ...fields })] })
  assert.deepEqual(matterBridgeErrors(ownBlock(file({}), SOURCE, config), SOURCE, config), [message])
  assert.deepEqual(matterBridgeErrors(ownBlock(file({ _bridge: CHILD }), SOURCE, config), SOURCE, config), [message])
  assert.deepEqual(matterBridgeErrors(ownBlock(file({ _bridge: { ...CHILD, matter: {} } }), SOURCE, config), SOURCE, config), [])
  const off = configOf(block({}))
  assert.deepEqual(matterBridgeErrors(ownBlock({ platforms: [block({})] }, SOURCE, off), SOURCE, off), [])
})

test('the own block in config.json is the single block, or the one with the same accountNumber and nmi', () => {
  const first = block({ accountNumber: '36200000000001', nmi: '4102000000', _bridge: CHILD })
  const second = block({ accountNumber: '36200000000001', _bridge: CHILD })
  const third = block({ accountNumber: '36200000000002', _bridge: CHILD })
  const file = { platforms: [first, { platform: 'Other' }, second, third] }
  assert.deepEqual(ownBlock(file, SOURCE, configOf(block({ accountNumber: '36200000000001', nmi: '4102000000' }))), { index: 0, block: first, first: true })
  assert.deepEqual(ownBlock(file, SOURCE, configOf(block({ accountNumber: '36200000000001' }))), { index: 2, block: second, first: false })
  assert.deepEqual(ownBlock(file, SOURCE, configOf(block({ accountNumber: '36200000000002' }))), { index: 3, block: third, first: false })
  assert.deepEqual(ownBlock({ platforms: [first] }, SOURCE, configOf(block({}))), { index: 0, block: first, first: true })
  assert.throws(() => ownBlock(file, SOURCE, configOf(block({ accountNumber: '36200000000003' }))), {
    message: `${SOURCE}: 0 FlippedEnergy blocks have accountNumber "36200000000003" and nmi not set; expected exactly 1`,
  })
})

test('accountNumber, nmi and name of the wrong type are errors, and every error is listed', () => {
  assert.deepEqual(errorsOf(block({ accountNumber: 36200000000001, nmi: '', name: 7, signalService: 'switches' })), [
    'name: expected a string, got 7',
    'accountNumber: expected a non-empty string, got 36200000000001',
    'nmi: expected a non-empty string, got ""',
    'signalService: expected "switch", "occupancySensor", "contactSensor", got "switches"',
  ])
})

test('a configuration that is not an object is an error', () => {
  assert.deepEqual(errorsOf(null), ['config: expected an object, got null'])
})

test('tokenPreview is the first 8 characters, an ellipsis and the last 4', () => {
  assert.equal(tokenPreview(TOKEN), 'fdk_Ab12…wXyZ')
})

test('one block without accountNumber passes the block rules', () => {
  assert.deepEqual(blockRuleErrors({ platforms: [{ platform: 'Other' }, block({})] }, SOURCE), [])
})

test('with more than one block every block must set accountNumber, counting the plugin-qualified platform name', () => {
  const file = {
    platforms: [
      block({ accountNumber: '36200000000001', _bridge: { username: '0E:00:00:00:00:01' } }),
      { platform: 'Other', name: 'Other' },
      { ...block({}), platform: '@flipped-energy/homebridge-flipped-energy.FlippedEnergy' },
    ],
  }
  assert.deepEqual(blockRuleErrors(file, SOURCE), [
    `${SOURCE} platforms[2]: accountNumber is not set; with 2 FlippedEnergy blocks every block must set accountNumber`,
  ])
})

test('two blocks with the same accountNumber and the same nmi setting are an error', () => {
  const same = { platforms: [block({ accountNumber: '36200000000001' }), block({ accountNumber: '36200000000001' })] }
  assert.deepEqual(blockRuleErrors(same, SOURCE), [
    `${SOURCE} platforms[0] and platforms[1]: same accountNumber "36200000000001" and same nmi (not set); two FlippedEnergy blocks may not serve the same account and nmi`,
  ])
  const sameNmi = { platforms: [block({ accountNumber: '36200000000001', nmi: '4102000000' }), block({ accountNumber: '36200000000001', nmi: '4102000000' })] }
  assert.deepEqual(blockRuleErrors(sameNmi, SOURCE), [
    `${SOURCE} platforms[0] and platforms[1]: same accountNumber "36200000000001" and same nmi ("4102000000"); two FlippedEnergy blocks may not serve the same account and nmi`,
  ])
  const split = { platforms: [block({ accountNumber: '36200000000001', nmi: '4102000000' }), block({ accountNumber: '36200000000001' })] }
  assert.deepEqual(blockRuleErrors(split, SOURCE), [])
})

test('the block rules are read from the Homebridge config file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hb-config-test-'))
  try {
    const path = join(directory, 'config.json')
    writeFileSync(path, JSON.stringify({ bridge: {}, platforms: [block({}), block({})] }))
    assert.deepEqual(readBlockRuleErrors(path), [
      `${path} platforms[0]: accountNumber is not set; with 2 FlippedEnergy blocks every block must set accountNumber`,
      `${path} platforms[1]: accountNumber is not set; with 2 FlippedEnergy blocks every block must set accountNumber`,
    ])
  } finally {
    rmSync(directory, { recursive: true })
  }
})
