import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as constants from '../src/hap/constants.ts'
import { HomebridgeAPI } from './helpers/homebridgeHarness.ts'

type View = Readonly<Record<string, unknown>>

function indexView(value: unknown, label: string): View {
  if (typeof value !== 'object' || value === null) throw new Error(`${label} is ${value === null ? 'null' : typeof value}, expected an object`)
  return Object.fromEntries(Object.entries(value))
}

const api = new HomebridgeAPI()
const hap = indexView(api.hap, 'api.hap')

const MEMBERS: Readonly<Record<string, readonly [string, string]>> = {
  STATUS_SERVICE_COMMUNICATION_FAILURE: ['HAPStatus', 'SERVICE_COMMUNICATION_FAILURE'],
  STATUS_READ_ONLY_CHARACTERISTIC: ['HAPStatus', 'READ_ONLY_CHARACTERISTIC'],
  FORMAT_FLOAT: ['Formats', 'FLOAT'],
  FORMAT_DATA: ['Formats', 'DATA'],
  PERM_PAIRED_READ: ['Perms', 'PAIRED_READ'],
  PERM_PAIRED_WRITE: ['Perms', 'PAIRED_WRITE'],
  PERM_NOTIFY: ['Perms', 'NOTIFY'],
  PERM_HIDDEN: ['Perms', 'HIDDEN'],
}

test('every literal in src/hap/constants.ts equals the run-time member of the HAP-NodeJS object', () => {
  const exported = indexView(constants, 'constants')
  assert.deepEqual(Object.keys(exported).sort(), Object.keys(MEMBERS).sort())
  for (const [name, [container, member]] of Object.entries(MEMBERS)) {
    const runtime = indexView(hap[container], `api.hap.${container}`)[member]
    assert.notEqual(runtime, undefined, `api.hap.${container}.${member} is undefined`)
    assert.equal(exported[name], runtime, `${name} vs api.hap.${container}.${member}`)
  }
})

test('a HapStatusError built from each status constant reports that status', () => {
  for (const status of [constants.STATUS_SERVICE_COMMUNICATION_FAILURE, constants.STATUS_READ_ONLY_CHARACTERISTIC]) {
    assert.equal(new api.hap.HapStatusError(status).hapStatus, status)
  }
})

test('custom characteristics built from the format and permission constants carry those props', () => {
  const float = new api.hap.Characteristic('Flipped Test Float', api.hap.uuid.generate('flipped:test:float'), {
    format: constants.FORMAT_FLOAT,
    perms: [constants.PERM_PAIRED_READ, constants.PERM_NOTIFY],
    unit: 'kWh',
    minValue: 0,
    maxValue: 1000000,
    minStep: 0.01,
  })
  assert.equal(float.props.format, 'float')
  assert.deepEqual(float.props.perms, ['pr', 'ev'])
  assert.equal(float.props.unit, 'kWh')
  const data = new api.hap.Characteristic('Flipped Test Data', api.hap.uuid.generate('flipped:test:data'), {
    format: constants.FORMAT_DATA,
    perms: [constants.PERM_PAIRED_READ, constants.PERM_PAIRED_WRITE, constants.PERM_NOTIFY, constants.PERM_HIDDEN],
  })
  assert.equal(data.props.format, 'data')
  assert.deepEqual(data.props.perms, ['pr', 'pw', 'ev', 'hd'])
})
