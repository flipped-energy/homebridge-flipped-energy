import { isRecord } from '../core/types.ts'

export const EVE_EPOCH = 978307200
export const HISTORY_MEMORY_SIZE = 65535
export const ENERGY_SIGNATURE = '040102020207020f03'
export const ENERGY_ENTRY_TYPE = '1f'
export const RECORDS_PER_READ = 11
export const TRANSFER_DONE = '00'

const REFERENCE_RECORD = '15'
const ENERGY_RECORD = '14'
const REQUEST_ADDRESS_OFFSET = 2
const REQUEST_LENGTH = 6

export interface EnergySlot {
  time: number
  deciwatts: number
}

export interface ReferenceSlot {
  time: number
  reference: true
}

export type HistorySlot = EnergySlot | ReferenceSlot | null

export interface HistoryState {
  memorySize: number
  firstEntry: number
  lastEntry: number
  usedMemory: number
  refTime: number
  initialTime: number | null
  slots: HistorySlot[]
}

function u32(value: number): string {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value)
  return bytes.toString('hex')
}

function u16(value: number): string {
  const bytes = Buffer.alloc(2)
  bytes.writeUInt16LE(value)
  return bytes.toString('hex')
}

function isReference(slot: EnergySlot | ReferenceSlot): slot is ReferenceSlot {
  return 'reference' in slot
}

export function emptyHistoryState(memorySize: number): HistoryState {
  if (!Number.isInteger(memorySize) || memorySize < 2 || memorySize > 0xffff) throw new Error(`Eve history memory size ${memorySize}: expected an integer from 2 to 65535`)
  return { memorySize, firstEntry: 0, lastEntry: 0, usedMemory: 0, refTime: 0, initialTime: null, slots: [null] }
}

function count(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${where}: ${JSON.stringify(value)}, expected an integer >= 0`)
  return value
}

function readSlot(value: unknown, where: string): HistorySlot {
  if (value === null) return null
  if (!isRecord(value)) throw new Error(`${where}: ${JSON.stringify(value)}, expected null or an object`)
  const time = count(value.time, `${where}.time`)
  if (value.reference === true && !('deciwatts' in value)) return { time, reference: true }
  const deciwatts = count(value.deciwatts, `${where}.deciwatts`)
  if (deciwatts > 0xffff) throw new Error(`${where}.deciwatts: ${deciwatts}, above 65535`)
  if ('reference' in value) throw new Error(`${where}: both deciwatts and reference`)
  return { time, deciwatts }
}

export function readHistoryState(value: unknown, where: string): HistoryState {
  if (!isRecord(value)) throw new Error(`${where}: ${JSON.stringify(value)}, expected an object`)
  const memorySize = count(value.memorySize, `${where}.memorySize`)
  emptyHistoryState(memorySize)
  const slots = value.slots
  if (!Array.isArray(slots) || slots.length === 0 || slots.length > memorySize) throw new Error(`${where}.slots: expected an array of 1 to ${memorySize} slots`)
  const initialTime = value.initialTime === null ? null : count(value.initialTime, `${where}.initialTime`)
  const slotValues: unknown[] = slots
  return {
    memorySize,
    firstEntry: count(value.firstEntry, `${where}.firstEntry`),
    lastEntry: count(value.lastEntry, `${where}.lastEntry`),
    usedMemory: count(value.usedMemory, `${where}.usedMemory`),
    refTime: count(value.refTime, `${where}.refTime`),
    initialTime,
    slots: slotValues.map((slot, index) => readSlot(slot, `${where}.slots[${index}]`)),
  }
}

export class EveHistory {
  readonly #state: HistoryState
  #currentEntry = 1
  #transfer = false
  #setTime = true
  #restarted = true

  constructor(state: HistoryState) {
    this.#state = state
  }

  reset(): void {
    Object.assign(this.#state, emptyHistoryState(HISTORY_MEMORY_SIZE))
    this.#currentEntry = 1
    this.#transfer = false
    this.#setTime = true
    this.#restarted = true
  }

  get state(): HistoryState {
    return this.#state
  }

  #address(entry: number): number {
    return entry % this.#state.memorySize
  }

  #slot(entry: number): EnergySlot | ReferenceSlot {
    const slot = this.#state.slots[this.#address(entry)]
    if (slot === undefined || slot === null) throw new Error(`Eve history: entry ${entry} (slot ${this.#address(entry)}) is empty, last entry ${this.#state.lastEntry}`)
    return slot
  }

  #put(address: number, slot: EnergySlot | ReferenceSlot): void {
    const { slots } = this.#state
    while (slots.length < address) slots.push(null)
    slots[address] = slot
  }

  add(time: number, deciwatts: number): void {
    const s = this.#state
    if (!Number.isInteger(time) || time < EVE_EPOCH) throw new Error(`Eve history: entry time ${time} is not a Unix time after 2001`)
    if (!Number.isInteger(deciwatts) || deciwatts < 0 || deciwatts > 0xffff) throw new Error(`Eve history: ${deciwatts} deciwatts does not fit 16 bits`)
    if (s.lastEntry > 0 && time < this.#slot(s.lastEntry).time) throw new Error(`Eve history: entry time ${time} is before the newest entry ${this.#slot(s.lastEntry).time}`)
    if (s.usedMemory < s.memorySize) {
      s.usedMemory++
      s.firstEntry = 0
      s.lastEntry = s.usedMemory
    } else {
      s.firstEntry++
      s.lastEntry = s.firstEntry + s.usedMemory
      if (this.#restarted) {
        this.#put(this.#address(s.lastEntry), { time, reference: true })
        s.firstEntry++
        s.lastEntry = s.firstEntry + s.usedMemory
        this.#restarted = false
      }
    }
    if (s.refTime === 0) {
      s.refTime = time - EVE_EPOCH
      this.#put(this.#address(s.lastEntry), { time, reference: true })
      s.initialTime = time
      s.lastEntry++
      s.usedMemory++
    }
    this.#put(this.#address(s.lastEntry), { time, deciwatts })
  }

  status(): string | null {
    const s = this.#state
    if (s.lastEntry === 0) return null
    const newest = this.#slot(s.lastEntry)
    const full = s.usedMemory >= s.memorySize
    return [
      u32(newest.time - s.refTime - EVE_EPOCH),
      '00000000',
      u32(s.refTime),
      ENERGY_SIGNATURE,
      u16(full ? s.usedMemory : s.usedMemory + 1),
      u16(s.memorySize),
      u32(full ? s.firstEntry + 1 : s.firstEntry),
      '000000000101',
    ].join('')
  }

  request(bytes: Buffer): void {
    if (bytes.length < REQUEST_LENGTH) throw new Error(`Eve history request ${bytes.toString('hex')}: ${bytes.length} bytes, expected at least ${REQUEST_LENGTH}`)
    const address = bytes.readUInt32LE(REQUEST_ADDRESS_OFFSET)
    this.#currentEntry = address === 0 ? 1 : address
    this.#transfer = true
  }

  read(): string {
    const s = this.#state
    if (!this.#transfer || this.#currentEntry > s.lastEntry) {
      this.#transfer = false
      return TRANSFER_DONE
    }
    const records: string[] = []
    for (let i = 0; i < RECORDS_PER_READ; i++) {
      const entry = this.#currentEntry
      const slot = this.#slot(entry)
      if (isReference(slot) || this.#setTime || entry === s.firstEntry + 1) {
        records.push(`${REFERENCE_RECORD}${u32(entry)}01000000` + `81${u32(s.refTime)}00000000000000`)
        this.#setTime = false
      } else {
        records.push(`${ENERGY_RECORD}${u32(entry)}${u32(slot.time - s.refTime - EVE_EPOCH)}${ENERGY_ENTRY_TYPE}00000000${u16(slot.deciwatts)}00000000`)
      }
      this.#currentEntry++
      if (this.#currentEntry > s.lastEntry) break
    }
    return records.join('')
  }
}
