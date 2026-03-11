/**
 * EventChannel — push-to-pull AsyncIterable bridge.
 *
 * Single producer pushes values via push()/close()/error().
 * Single consumer pulls via `for await (const v of channel)`.
 */

interface Waiting<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (err: unknown) => void;
}

export class EventChannel<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiting: Waiting<T> | null = null;
  private closed = false;
  private err: unknown = null;

  push(value: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve({ value: undefined as T, done: true });
    }
  }

  error(err: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.err = err;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.reject(err);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          if (this.err) return Promise.reject(this.err);
          return Promise.resolve({ value: undefined as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiting = { resolve, reject };
        });
      },
    };
  }
}
