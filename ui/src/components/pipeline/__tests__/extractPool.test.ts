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
 * ExtractPool crash resilience. A worker that dies mid-job (OOM on a huge
 * generated file) fires 'error' and never posts a result — the pool must fail
 * that job, retire the worker, keep draining with the survivors, and resolve
 * (never hang), even when EVERY worker dies.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ExtractPool } from '../concurrent/extractPool';

type Listener = (ev: unknown) => void;

class FakeWorker {
  static instances: FakeWorker[] = [];
  private listeners = new Map<string, Set<Listener>>();
  /** Jobs received via postMessage({type:'extract'}) — completed manually. */
  jobs: { jobId: number; fileId: string }[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  emit(type: string, ev: unknown): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }

  postMessage(msg: { type: string; jobId?: number; fileId?: string }): void {
    if (msg.type === 'init') {
      queueMicrotask(() => this.emit('message', { data: { type: 'ready' } }));
    } else if (msg.type === 'extract') {
      this.jobs.push({ jobId: msg.jobId!, fileId: msg.fileId! });
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  // ── test drivers ──
  completeJob(idx: number): void {
    const j = this.jobs[idx];
    this.emit('message', {
      data: {
        type: 'result',
        jobId: j.jobId,
        fileId: j.fileId,
        language: 'ts',
        symbols: [],
        importResult: { imports: [] },
      },
    });
  }

  crash(message = 'boom'): void {
    this.emit('error', { message });
  }
}

const FILES = [
  { fileId: 'a', filePath: 'a.ts' },
  { fileId: 'b', filePath: 'b.ts' },
  { fileId: 'c', filePath: 'c.ts' },
];
const getContent = () => 'export {}';

async function makePool(size: number): Promise<ExtractPool> {
  const pool = new ExtractPool(size);
  await pool.init(new Set(), undefined);
  return pool;
}

/** Let queued microtasks/dispatches settle. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('ExtractPool crash handling', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails the in-flight job and drains the rest on a single crash', async () => {
    const pool = await makePool(2);
    const [w1, w2] = FakeWorker.instances;

    const results: string[] = [];
    const errors: [string, string][] = [];
    const done = pool.run(FILES, getContent, {
      onResult: (r) => results.push(r.fileId),
      onError: (fileId, error) => errors.push([fileId, error]),
    });
    await tick();

    // Both workers got a job (a, b); c queued.
    expect(w1.jobs.map((j) => j.fileId)).toEqual(['a']);
    expect(w2.jobs.map((j) => j.fileId)).toEqual(['b']);

    // w2 dies mid-job; w1 keeps going and picks up c.
    w2.crash('OOM');
    await tick();
    w1.completeJob(0);
    await tick();
    expect(w1.jobs.map((j) => j.fileId)).toEqual(['a', 'c']);
    w1.completeJob(1);

    await done; // must resolve — this hung before the fix
    expect(results.sort()).toEqual(['a', 'c']);
    expect(errors).toEqual([['b', 'extract worker crashed: OOM']]);
  });

  it('fails all remaining files and resolves when every worker dies', async () => {
    const pool = await makePool(1);
    const [w1] = FakeWorker.instances;

    const errors: string[] = [];
    const done = pool.run(FILES, getContent, {
      onResult: () => {},
      onError: (fileId) => errors.push(fileId),
    });
    await tick();

    expect(w1.jobs.map((j) => j.fileId)).toEqual(['a']);
    w1.crash();

    await done; // resolves instead of hanging with b/c stranded
    expect(errors.sort()).toEqual(['a', 'b', 'c']);
  });

  it('a crash after the queue drained still resolves cleanly', async () => {
    const pool = await makePool(2);
    const [w1, w2] = FakeWorker.instances;

    const results: string[] = [];
    const done = pool.run(FILES.slice(0, 2), getContent, {
      onResult: (r) => results.push(r.fileId),
    });
    await tick();

    w1.completeJob(0);
    await tick();
    // w1 idle (queue empty), w2 still busy — then w2 dies.
    w2.crash();

    await done;
    expect(results).toEqual(['a']);
  });
});
