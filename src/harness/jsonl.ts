export type TJsonlLineRead =
  | { readonly kind: "line"; readonly value: string; readonly raw: string }
  | { readonly kind: "truncated"; readonly value: string }
  | { readonly kind: "closed" };

/**
 * The Harness Module's one hand-rolled NDJSON line splitter, kept over
 * `node:readline` deliberately (M3 D15, M4 D1). The growth rule points both
 * ways to hand-roll: framing is frozen by the Harness protocols, and correctness
 * depends on distinguishing a final unterminated line. `readline` emits that
 * remainder as an ordinary line, erasing the Adapters' truncated-frame evidence.
 */
export class JsonlLineReader {
  private readonly decoder = new TextDecoder();
  private readonly iterator: AsyncIterator<Uint8Array>;
  private remainder = "";
  private ended = false;

  constructor(chunks: AsyncIterable<Uint8Array>) {
    this.iterator = chunks[Symbol.asyncIterator]();
  }

  async next(): Promise<TJsonlLineRead> {
    for (;;) {
      const newline = this.remainder.indexOf("\n");
      if (newline >= 0) {
        const raw = this.remainder.slice(0, newline + 1);
        const value = raw.slice(0, -1).replace(/\r$/, "");
        this.remainder = this.remainder.slice(newline + 1);
        return { kind: "line", value, raw };
      }
      if (this.ended) return { kind: "closed" };

      const chunk = await this.iterator.next();
      if (!chunk.done) {
        this.remainder += this.decoder.decode(chunk.value, { stream: true });
        continue;
      }

      this.remainder += this.decoder.decode();
      this.ended = true;
      if (this.remainder.length === 0) return { kind: "closed" };

      const value = this.remainder;
      this.remainder = "";
      return { kind: "truncated", value };
    }
  }
}
