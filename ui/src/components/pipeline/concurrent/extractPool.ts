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
 * Pool of {@link extractWorker}s. Parses files across CPU cores in parallel,
 * keeping the main thread free for the UI / live build. Concurrency is bounded
 * by the worker count (each worker handles one file at a time), which also
 * bounds peak memory — only N files are in flight at once.
 */

import type { CodeSymbol } from '../types';
import type { ImportAnalysisResult } from '../parser/importAnalyzer';
import type { ExtractWorkerIn, ExtractWorkerOut } from './extractTypes';

export interface ExtractPoolResult {
  fileId: string;
  language: string;
  symbols: CodeSymbol[];
  importResult: ImportAnalysisResult;
}

export interface ExtractFileRef {
  fileId: string;
  filePath: string;
}

export interface RunCallbacks {
  onResult: (result: ExtractPoolResult) => void;
  onSkip?: (fileId: string) => void;
  onError?: (fileId: string, error: string) => void;
  /** Cooperative cancellation — checked before dispatching each file. */
  isCancelled?: () => boolean;
}

/** Choose a sensible worker count: leave a core for the main thread, cap the
 *  fan-out so we don't load N×14 grammars on machines reporting huge core
 *  counts. */
export function defaultPoolSize(): number {
  const cores =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  return Math.min(8, Math.max(1, cores - 1));
}

export class ExtractPool {
  private workers: Worker[] = [];
  private readonly size: number;

  constructor(size: number = defaultPoolSize()) {
    this.size = Math.max(1, size);
  }

  get workerCount(): number {
    return this.size;
  }

  /** Spawn workers and initialize each with the repo-constant lookups. */
  async init(
    knownPaths: Set<string>,
    goModulePath: string | undefined,
    parserKeys?: string[],
  ): Promise<void> {
    const readies: Promise<void>[] = [];

    for (let i = 0; i < this.size; i++) {
      const worker = new Worker(
        new URL('./extractWorker.ts', import.meta.url),
        {
          type: 'module',
        },
      );
      this.workers.push(worker);

      readies.push(
        new Promise<void>((resolve, reject) => {
          const onMessage = (ev: MessageEvent<ExtractWorkerOut>) => {
            if (ev.data?.type === 'ready') {
              worker.removeEventListener('message', onMessage);
              resolve();
            }
          };
          worker.addEventListener('message', onMessage);
          worker.addEventListener('error', (e) => reject(e), { once: true });
        }),
      );

      worker.postMessage({
        type: 'init',
        knownPaths,
        goModulePath,
        parserKeys,
      } satisfies ExtractWorkerIn);
    }

    await Promise.all(readies);
  }

  /**
   * Parse every file, dispatching across all workers. Resolves once all files
   * have completed (or been drained after cancellation). `getContent` is read
   * lazily at dispatch time so we don't hold a second copy of every file.
   */
  run(
    files: ExtractFileRef[],
    getContent: (fileId: string) => string | undefined,
    cb: RunCallbacks,
  ): Promise<void> {
    let next = 0;
    let active = 0;
    let jobSeq = 0;
    const total = files.length;

    return new Promise<void>((resolve) => {
      if (total === 0) {
        resolve();
        return;
      }

      // Crash accounting: a worker that OOMs on a huge file fires 'error'
      // (never a 'message'), which previously left `active` stuck and hung
      // the whole indexing run on its last in-flight job. Track each
      // worker's in-flight job so a crash can fail it, retire the dead
      // worker, and let the surviving workers drain the queue.
      const dead = new Set<Worker>();
      const inFlight = new Map<
        Worker,
        {
          fileId: string;
          handler: (ev: MessageEvent<ExtractWorkerOut>) => void;
        }
      >();
      const crashHandlers = new Map<Worker, (ev: Event) => void>();

      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        for (const [worker, onCrash] of crashHandlers) {
          worker.removeEventListener('error', onCrash);
          worker.removeEventListener('messageerror', onCrash);
        }
        resolve();
      };

      const pump = (worker: Worker): void => {
        if (dead.has(worker)) return;
        // Skip remaining work on cancellation; resolve once everything drains.
        if (cb.isCancelled?.() || next >= total) {
          if (active === 0) finish();
          return;
        }

        const file = files[next++];
        const content = getContent(file.fileId);
        if (content === undefined) {
          // No content cached — treat as a skip, keep the worker busy.
          cb.onSkip?.(file.fileId);
          pump(worker);
          return;
        }

        const jobId = jobSeq++;
        active++;

        const handler = (ev: MessageEvent<ExtractWorkerOut>): void => {
          const m = ev.data;
          if (m.type === 'ready' || m.jobId !== jobId) return;
          worker.removeEventListener('message', handler);
          inFlight.delete(worker);
          active--;

          // Dispatch this worker's NEXT file BEFORE processing the result, so
          // the worker keeps parsing while the (main-thread) merge + live-build
          // runs. Otherwise a slow merge idles the worker — and at large scale
          // that main-thread work starves the whole pool, tanking throughput.
          pump(worker);

          if (m.type === 'result') {
            cb.onResult({
              fileId: m.fileId,
              language: m.language,
              symbols: m.symbols,
              importResult: m.importResult,
            });
          } else if (m.type === 'skip') {
            cb.onSkip?.(m.fileId);
          } else if (m.type === 'error') {
            cb.onError?.(m.fileId, m.error);
          }
        };

        worker.addEventListener('message', handler);
        inFlight.set(worker, { fileId: file.fileId, handler });
        worker.postMessage({
          type: 'extract',
          jobId,
          fileId: file.fileId,
          filePath: file.filePath,
          content,
        } satisfies ExtractWorkerIn);
      };

      for (const worker of this.workers) {
        const onCrash = (ev: Event): void => {
          if (dead.has(worker) || finished) return;
          dead.add(worker);
          const evMsg = (ev as { message?: unknown }).message;
          const reason =
            typeof evMsg === 'string' && evMsg
              ? `extract worker crashed: ${evMsg}`
              : 'extract worker crashed';
          const job = inFlight.get(worker);
          if (job) {
            worker.removeEventListener('message', job.handler);
            inFlight.delete(worker);
            active--;
            cb.onError?.(job.fileId, reason);
          }
          const anyAlive = this.workers.some((w) => !dead.has(w));
          if (!anyAlive) {
            // Last worker down: fail whatever's left so callers see every
            // file accounted for, then resolve instead of hanging.
            while (next < total) {
              cb.onError?.(files[next++].fileId, reason);
            }
            finish();
            return;
          }
          // Surviving (busy) workers keep pumping the queue as they finish;
          // we only need to resolve if this crash ended the final job.
          if (active === 0 && next >= total) finish();
        };
        crashHandlers.set(worker, onCrash);
        worker.addEventListener('error', onCrash);
        worker.addEventListener('messageerror', onCrash);
      }

      for (const worker of this.workers) pump(worker);
    });
  }

  terminate(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
  }
}
