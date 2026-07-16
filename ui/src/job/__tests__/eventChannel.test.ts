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

import { describe, it, expect } from 'vitest';
import { EventChannel } from '../eventChannel';

async function collect<T>(channel: EventChannel<T>): Promise<T[]> {
  const out: T[] = [];
  for (const iter = channel[Symbol.asyncIterator](); ; ) {
    const { value, done } = await iter.next();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe('EventChannel', () => {
  it('delivers pushed values then ends after close()', async () => {
    const ch = new EventChannel<number>();
    ch.push(1);
    ch.push(2);
    ch.close();
    expect(await collect(ch)).toEqual([1, 2]);
  });

  it('close() preserves buffered events for the consumer to drain', async () => {
    const ch = new EventChannel<string>();
    ch.push('graph_ready');
    ch.push('done');
    ch.close();
    // Normal completion: a slow consumer must still see the final events.
    expect(await collect(ch)).toEqual(['graph_ready', 'done']);
  });

  it('closeAndDrop() discards buffered events so the iterator ends immediately', async () => {
    const ch = new EventChannel<string>();
    ch.push('progress');
    ch.push('graph_ready');
    ch.push('done');
    ch.closeAndDrop();
    // Cancellation: buffered events from the dead job must NOT flow.
    expect(await collect(ch)).toEqual([]);
  });

  it('closeAndDrop() resolves a waiting consumer with done', async () => {
    const ch = new EventChannel<number>();
    const iter = ch[Symbol.asyncIterator]();
    const pending = iter.next();
    ch.closeAndDrop();
    expect(await pending).toEqual({ value: undefined, done: true });
  });

  it('ignores push() after closeAndDrop()', async () => {
    const ch = new EventChannel<number>();
    ch.closeAndDrop();
    ch.push(42);
    expect(await collect(ch)).toEqual([]);
  });

  it('waiting consumer receives values pushed later', async () => {
    const ch = new EventChannel<number>();
    const iter = ch[Symbol.asyncIterator]();
    const pending = iter.next();
    ch.push(7);
    expect(await pending).toEqual({ value: 7, done: false });
    ch.close();
    expect(await iter.next()).toMatchObject({ done: true });
  });

  it('error() rejects the pending/next read', async () => {
    const ch = new EventChannel<number>();
    ch.error(new Error('boom'));
    const iter = ch[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow('boom');
  });
});
