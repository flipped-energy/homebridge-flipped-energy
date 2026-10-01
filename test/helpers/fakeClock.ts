import type { TimerApi } from '../../src/runtime/scheduler.ts'

interface Pending {
  id: number
  atMs: number
  callback: () => void
}

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

export class FakeClock implements TimerApi<number> {
  #nowMs: number
  #nextId = 1
  #pending: Pending[] = []

  constructor(startMs: number) {
    this.#nowMs = startMs
  }

  now(): number {
    return this.#nowMs
  }

  setTimeout(callback: () => void, delayMs: number): number {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error(`fake clock: delay ${delayMs}`)
    const id = this.#nextId
    this.#nextId += 1
    this.#pending.push({ id, atMs: this.#nowMs + delayMs, callback })
    return id
  }

  clearTimeout(handle: number): void {
    this.#pending = this.#pending.filter((pending) => pending.id !== handle)
  }

  get pendingCount(): number {
    return this.#pending.length
  }

  async runUntil(endMs: number): Promise<void> {
    for (;;) {
      await settle()
      let next: Pending | undefined
      for (const pending of this.#pending) {
        if (next === undefined || pending.atMs < next.atMs || (pending.atMs === next.atMs && pending.id < next.id)) next = pending
      }
      if (next === undefined || next.atMs > endMs) break
      const due = next
      this.#pending = this.#pending.filter((pending) => pending.id !== due.id)
      this.#nowMs = due.atMs
      due.callback()
    }
    this.#nowMs = endMs
  }
}
