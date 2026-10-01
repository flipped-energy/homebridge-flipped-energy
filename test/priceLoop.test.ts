import { test } from 'node:test'
import { SEQUENCE_SETS, replayFile } from './helpers/sequenceReplay.ts'

for (const name of SEQUENCE_SETS.priceLoop) {
  test(`sequence ${name}`, async () => {
    await replayFile(name)
  })
}
