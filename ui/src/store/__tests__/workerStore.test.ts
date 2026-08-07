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

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { SourceFile } from '../types';

// The proxy owns a real Web Worker + LadybugDB engine; neither exists in the
// node test environment. Stub both — these tests exercise the proxy's own
// scheduling (the storeSource chunk pump), mocking the worker RPC `call`.
vi.mock('../lbugEngine', () => ({
  createLbugEngine: () => ({
    init: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue(undefined),
    fsWrite: vi.fn().mockResolvedValue(undefined),
    fsUnlink: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

class FakeWorker {
  onmessage: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
}

beforeAll(() => {
  vi.stubGlobal('Worker', FakeWorker);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const makeFiles = (count: number): SourceFile[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `repo/f${i}.ts`,
    path: `f${i}.ts`,
    content: `// file ${i}`,
  }));

async function makeStore() {
  const { WorkerGraphStore } = await import('../workerStore');
  const store = new WorkerGraphStore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = store as any;
  return { store, s };
}

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

describe('WorkerGraphStore storeSource chunk pump', () => {
  it('a failed chunk is logged and the remaining chunks still post', async () => {
    const { store, s } = await makeStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const posted: number[] = [];
    s.call = vi.fn(async (method: string, args: unknown[]) => {
      if (method !== 'storeSource') return undefined;
      const files = args[0] as SourceFile[];
      posted.push(files.length);
      if (posted.length === 2) throw new Error('postMessage blew up');
      return undefined;
    });

    // 450 files → chunks of 200, 200, 50. Chunk 2 fails.
    store.storeSource(makeFiles(450));
    await s.pendingSource; // pump always resolves — no unhandled rejection

    expect(posted).toEqual([200, 200, 50]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('storeSource chunk'),
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('flush and exportDatabase wait for pending source chunks', async () => {
    const { store, s } = await makeStore();
    const order: string[] = [];
    const releases: (() => void)[] = [];
    s.call = vi.fn((method: string) => {
      order.push(method);
      if (method === 'storeSource') {
        return new Promise<void>((resolve) => releases.push(resolve));
      }
      return Promise.resolve(new Uint8Array());
    });

    store.storeSource(makeFiles(400)); // 2 chunks, both gated
    const flushP = store.flush();
    const exportP = store.exportDatabase();
    await flushMicrotasks();

    // Neither overtakes the unposted chunks. (Regression: the old
    // fire-and-forget loop let flush/export race ahead of storeSource.)
    expect(order).toEqual(['storeSource']);

    releases[0]();
    await flushMicrotasks();
    expect(order).toEqual(['storeSource', 'storeSource']);

    releases[1]();
    await Promise.all([flushP, exportP]);
    expect(order).toEqual([
      'storeSource',
      'storeSource',
      'flush',
      'exportDatabase',
    ]);
  });

  it('clearGraph waits for the pump and consecutive storeSource calls stay ordered', async () => {
    const { store, s } = await makeStore();
    const order: string[] = [];
    let release: (() => void) | null = null;
    s.call = vi.fn((method: string, args: unknown[]) => {
      if (method === 'storeSource') {
        order.push(`storeSource:${(args[0] as SourceFile[])[0].id}`);
        if (!release) {
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve(undefined);
      }
      order.push(method);
      return Promise.resolve(undefined);
    });

    store.storeSource([{ id: 'a', path: 'a.ts', content: '1' }]);
    store.storeSource([{ id: 'b', path: 'b.ts', content: '2' }]);
    const clearP = store.clearGraph();
    await flushMicrotasks();
    // Second batch and clearGraph both queue behind the gated first chunk.
    expect(order).toEqual(['storeSource:a']);

    release!();
    await clearP;
    expect(order).toEqual(['storeSource:a', 'storeSource:b', 'clearGraph']);
  });

  it('job-service-style chunked calls compose with the pump: file order preserved, flush waits for all', async () => {
    // browserJobService now calls storeSource in ~500-file chunks (with
    // event-loop yields between them) instead of one repo-sized call. Each
    // call chains its own pump segment; the worker must see exactly the
    // same 200-file RPC sequence, in file order, and flush must still wait
    // for every chunk from every call.
    const { store, s } = await makeStore();
    const posted: { first: string; count: number }[] = [];
    const order: string[] = [];
    s.call = vi.fn(async (method: string, args: unknown[]) => {
      order.push(method);
      if (method === 'storeSource') {
        const files = args[0] as SourceFile[];
        posted.push({ first: files[0].id, count: files.length });
      }
      return undefined;
    });

    const files = makeFiles(1200);
    const JOB_CHUNK = 500;
    for (let i = 0; i < files.length; i += JOB_CHUNK) {
      store.storeSource(files.slice(i, i + JOB_CHUNK));
      // Same yield the job service performs between chunks.
      await flushMicrotasks();
    }
    await store.flush();

    // 500 → 200+200+100, 500 → 200+200+100, 200 → 200; file order intact.
    expect(posted).toEqual([
      { first: 'repo/f0.ts', count: 200 },
      { first: 'repo/f200.ts', count: 200 },
      { first: 'repo/f400.ts', count: 100 },
      { first: 'repo/f500.ts', count: 200 },
      { first: 'repo/f700.ts', count: 200 },
      { first: 'repo/f900.ts', count: 100 },
      { first: 'repo/f1000.ts', count: 200 },
    ]);
    // flush ran only after every source chunk posted.
    expect(order[order.length - 1]).toBe('flush');
    expect(order.filter((m) => m === 'storeSource')).toHaveLength(7);
  });
});

describe('WorkerGraphStore ↔ storeWorker dispatch allowlist', () => {
  // The worker's `switch (method)` is an allowlist with a throwing default, so
  // a proxy method with no matching case fails at runtime with "unknown store
  // method" no matter how well-typed the caller is. TypeScript checks that
  // WorkerGraphStore satisfies GraphStore; nothing checks that the far side of
  // the postMessage boundary can service what the near side forwards. The eight
  // retrieval methods added to the GraphStore contract shipped with no
  // WorkerGraphStore implementation at all — tsc caught that half. Adding the
  // proxies without their cases would have compiled just as cleanly, and this
  // is the only thing standing between that and a runtime throw.
  const read = (file: string) =>
    readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

  const names = (src: string, re: RegExp) => {
    const out = new Set<string>();
    for (const m of src.matchAll(re)) out.add(m[1]);
    return out;
  };

  it('dispatches every method the proxy forwards, and no orphans', () => {
    const proxied = names(
      read('workerStore.ts'),
      /this\.call(?:<[^>]*>)?\(\s*'([A-Za-z0-9_]+)'/g,
    );
    const dispatched = names(
      read('storeWorker.ts'),
      /case\s+'([A-Za-z0-9_]+)':/g,
    );

    expect(proxied.size).toBeGreaterThan(20); // the regex still matches something
    expect([...proxied].filter((m) => !dispatched.has(m))).toEqual([]);
    expect([...dispatched].filter((m) => !proxied.has(m))).toEqual([]);
  });
});
