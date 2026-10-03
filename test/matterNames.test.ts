import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MATTER_MODEL, NODE_LABEL_MAX, matterName, matterSerialNumber, matterUuidSeed, nodeLabel } from '../src/matter/names.ts'
import { CHANNEL_NAMES } from '../src/runtime/stateStore.ts'
import { instanceHash } from '../src/runtime/stateStore.ts'

const ACCOUNT = '36200000001234'
const NMI = '4103005678'

test('the three name shapes for each channel are at most 32 characters', () => {
  const names = CHANNEL_NAMES.flatMap((key) => [matterName(true, ACCOUNT, null, key), matterName(false, ACCOUNT, null, key), matterName(false, ACCOUNT, NMI, key)])
  assert.deepEqual(names, [
    'Power Usage Energy',
    'Power Usage Energy 1234',
    'Power Usage Energy 1234 5678',
    'Solar Export Energy',
    'Solar Export Energy 1234',
    'Solar Export Energy 1234 5678',
    'Controlled Load Energy',
    'Controlled Load Energy 1234',
    'Controlled Load Energy 1234 5678',
    'Peak Usage', 'Peak Usage 1234', 'Peak Usage 1234 5678',
    'Off-Peak Usage', 'Off-Peak Usage 1234', 'Off-Peak Usage 1234 5678',
    'Shoulder Usage', 'Shoulder Usage 1234', 'Shoulder Usage 1234 5678',
  ])
  assert.ok(names.every((name) => name.length <= NODE_LABEL_MAX))
  assert.equal(Math.max(...names.map((name) => name.length)), NODE_LABEL_MAX)
})

test('a 33-character name throws', () => {
  const name = 'Controlled Load Energy 1234 56789'
  assert.equal(name.length, 33)
  assert.throws(() => nodeLabel(name), /has 33 characters, the maximum is 32/)
  assert.equal(nodeLabel(name.slice(0, 32)), name.slice(0, 32))
})

test('UUID seed, serial number and model', () => {
  const instanceKey = `${ACCOUNT}:${NMI}`
  assert.equal(matterUuidSeed(instanceKey, 'grid_import'), `flipped:${instanceKey}:matter:grid_import`)
  const serial = matterSerialNumber(instanceKey, 'grid_import')
  assert.equal(serial, `FE-${instanceHash(instanceKey)}-GI-M`)
  assert.equal(serial.length, 24)
  assert.equal(matterSerialNumber(instanceKey, 'solar_export').slice(-5), '-SE-M')
  assert.equal(matterSerialNumber(instanceKey, 'controlled_load').slice(-5), '-CL-M')
  assert.equal(MATTER_MODEL, 'Energy History')
})
