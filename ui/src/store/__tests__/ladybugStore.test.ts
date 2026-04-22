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

import { describe, it, expect, vi } from 'vitest';
import { LadybugGraphStore, REL_PAIRS } from '../ladybugStore';

describe('REL_PAIRS', () => {
  it('has no duplicate FROM→TO pairs', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const [from, to] of REL_PAIRS) {
      const key = `${from}→${to}`;
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    expect(duplicates).toEqual([]);
  });
});

// Helper: build a store with WASM init bypassed and a mock conn that
// resolves every query() call into a trivial result.
function makeStoreWithMockConn() {
  const store = new LadybugGraphStore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = store as any;
  s.ready = Promise.resolve();
  const connQuery = vi.fn().mockImplementation(async () => ({
    getAllObjects: async () => [],
    close: async () => {},
  }));
  s.conn = { query: connQuery };
  return { store, s, connQuery };
}

describe('LadybugGraphStore clearGraph abort behavior', () => {
  it('aborts queued query()/exec() tasks when clearGraph fires', async () => {
    const { store, s, connQuery } = makeStoreWithMockConn();

    // Hold the queue open so pending tasks can't run until we say so.
    let releaseGate: () => void = () => {};
    s.queue = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    // Enqueue two tasks before clearGraph fires — they capture generation 0.
    const pendingQuery = s.query('MATCH (n) RETURN n');
    const pendingExec = s.exec('CREATE (n)');

    // clearGraph bumps the generation and enqueues its own DDL.
    const clearPromise = store.clearGraph();

    // Release the gate so the chain can drain.
    releaseGate();

    // Pre-clearGraph tasks should reject with AbortError.
    await expect(pendingQuery).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pendingExec).rejects.toMatchObject({ name: 'AbortError' });

    // clearGraph itself completes.
    await expect(clearPromise).resolves.toBeUndefined();

    // conn.query was called only for clearGraph's DDL, never for the
    // aborted user queries.
    const cyphers = connQuery.mock.calls.map((c: [string]) => c[0]);
    expect(cyphers).not.toContain('MATCH (n) RETURN n');
    expect(cyphers).not.toContain('CREATE (n)');
    // Sanity: clearGraph did dispatch some DROP/CREATE DDL.
    expect(cyphers.some((c: string) => c.startsWith('DROP TABLE'))).toBe(true);
  });

  it('allows queries enqueued after clearGraph to run normally', async () => {
    const { store, s, connQuery } = makeStoreWithMockConn();

    // Fire clearGraph first (bumps gen 0 → 1, completes its DDL).
    await store.clearGraph();

    // Subsequent query captures gen 1, matches current gen 1, runs normally.
    const rows = await s.query('MATCH (n) RETURN n');
    expect(rows).toEqual([]);

    const cyphers = connQuery.mock.calls.map((c: [string]) => c[0]);
    expect(cyphers).toContain('MATCH (n) RETURN n');
  });

  it('bumps the generation counter on clearGraph', async () => {
    const { store, s } = makeStoreWithMockConn();

    expect(s.generation).toBe(0);
    await store.clearGraph();
    expect(s.generation).toBe(1);
    await store.clearGraph();
    expect(s.generation).toBe(2);
  });
});
