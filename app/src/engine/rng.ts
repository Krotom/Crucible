// Seeded random number generator owned by the engine (mulberry32). Its whole state is one 32-bit integer, so snapshots are trivial.
export class Rng {
  constructor(public state: number) { this.state = state >>> 0 }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** A function view for APIs that take `() => number`. */
  fn(): () => number { return () => this.next() }
}

/** 53-bit string hash (cyrb53) over numbers, used for state hashes. */
export class Hasher {
  private h1 = 0xdeadbeef
  private h2 = 0x41c6ce57
  private buf = new DataView(new ArrayBuffer(8))

  add(x: number): void {
    this.buf.setFloat64(0, x, true)
    for (let i = 0; i < 2; i++) {
      const v = this.buf.getUint32(i * 4, true)
      this.h1 = Math.imul(this.h1 ^ v, 2654435761)
      this.h2 = Math.imul(this.h2 ^ v, 1597334677)
    }
  }

  digest(): string {
    let h1 = Math.imul(this.h1 ^ (this.h1 >>> 16), 2246822507) ^ Math.imul(this.h2 ^ (this.h2 >>> 13), 3266489909)
    let h2 = Math.imul(this.h2 ^ (this.h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    h1 >>>= 0; h2 >>>= 0
    return h2.toString(16).padStart(8, '0') + h1.toString(16).padStart(8, '0')
  }
}
