/** Accumulates byte chunks for raw dumps without repeated concatenation. */
export class ByteRecorder {
  #chunks: Uint8Array[] = []
  #length = 0

  push(data: Uint8Array): void {
    if (data.length === 0) return
    this.#chunks.push(data.slice())
    this.#length += data.length
  }

  get byteLength(): number {
    return this.#length
  }

  get chunkCount(): number {
    return this.#chunks.length
  }

  /** Concatenate and consume the accumulated bytes. */
  take(): Uint8Array {
    const out = new Uint8Array(this.#length)
    let offset = 0
    for (const chunk of this.#chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    this.#chunks = []
    this.#length = 0
    return out
  }

  clear(): void {
    this.#chunks = []
    this.#length = 0
  }
}
