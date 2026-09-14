import type { ProjectionUpdate } from "./projection-port.js";

/** A minimal single-consumer async push stream for durable Projection updates. */
export class UpdateStream implements AsyncIterable<ProjectionUpdate> {
  private readonly queue: ProjectionUpdate[] = [];
  private waiting?: (result: IteratorResult<ProjectionUpdate>) => void;
  private closed = false;

  push(update: ProjectionUpdate): void {
    if (this.closed) return;
    const waiting = this.waiting;
    if (waiting !== undefined) {
      this.waiting = undefined;
      waiting({ value: update, done: false });
    } else {
      this.queue.push(update);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiting = this.waiting;
    if (waiting !== undefined) {
      this.waiting = undefined;
      waiting({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ProjectionUpdate> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value !== undefined) {
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
