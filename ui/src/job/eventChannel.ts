/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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

  /**
   * Close the channel AND discard any buffered events, so the consumer's
   * iterator ends immediately instead of draining stale events first.
   *
   * Use this for cancellation: a cancelled job's buffered events (e.g. a
   * GRAPH_READY/DONE that was pushed just before the user hit cancel) must
   * not keep driving UI state. Normal completion should use close(), which
   * lets the consumer drain the remaining buffered events.
   */
  closeAndDrop(): void {
    this.buffer.length = 0;
    this.close();
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
