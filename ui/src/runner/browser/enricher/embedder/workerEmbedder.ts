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
 * Main-thread proxy for the embedder Web Worker (Fix #55 / Plan E).
 *
 * Implements the `Embedder` interface by forwarding each call to
 * `embedderWorker.ts` over `postMessage`. The Worker hosts
 * @huggingface/transformers so inference no longer blocks Pixi's
 * ticker during indexing.
 *
 * Eager init: the constructor immediately fires off the `init`
 * message so the model load overlaps with earlier pipeline stages
 * (matches the previous `MiniLmEmbedder` behavior).
 */

import type { Embedder, EmbedderConfig } from './types';
import { isConstrainedDevice } from '../../../../config/device';

type OutMessage =
  | { seq: number; type: 'init-done'; dimension: number }
  | { seq: number; type: 'embed-result'; vectors: Float32Array[] }
  | { seq: number; type: 'dispose-done' }
  | { seq: number; type: 'error'; message: string };

interface PendingRequest {
  type: 'init' | 'embed' | 'dispose';
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class WorkerEmbedder implements Embedder {
  private worker: Worker;
  private pending = new Map<number, PendingRequest>();
  private nextSeq = 1;
  private dim = 384;
  private initPromise: Promise<void>;
  private disposed = false;

  constructor(config: EmbedderConfig) {
    this.worker = new Worker(new URL('./embedderWorker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<OutMessage>) =>
      this.onMessage(e.data);
    this.worker.onerror = (e) => {
      // A worker-level error is fatal: terminate, mark disposed so later
      // calls fail fast instead of posting to a dead worker, and reject
      // everything still pending.
      const err = new Error(e.message || 'embedder worker error');
      this.disposed = true;
      this.worker.terminate();
      this.rejectAllPending(err);
    };
    // Eager init: fire off the model load now so it overlaps with
    // earlier pipeline stages. Matches the previous main-thread
    // behavior where `MiniLmEmbedder.init()` was kicked off from
    // EmbedStage's constructor.
    // Only let the worker reach for the (bigger, fp32) WebGPU model on
    // non-constrained devices; phones stay on the small quantized WASM model so
    // the embedder doesn't add a ~90MB model on top of an already-full heap.
    this.initPromise = this.request<{ dimension: number }>('init', {
      config,
      gpuPreferred: !isConstrainedDevice(),
    }).then((reply) => {
      this.dim = reply.dimension;
    });
  }

  async init(): Promise<void> {
    // The constructor already started the load; just wait for it.
    await this.initPromise;
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.initPromise;
    if (this.disposed) {
      throw new Error('WorkerEmbedder disposed');
    }
    const reply = await this.request<{ vectors: Float32Array[] }>('embed', {
      texts,
    });
    // The `Embedder` contract returns `number[][]` — convert at the
    // boundary. Float32Array → number[] is one tight loop; the cost
    // is dwarfed by inference time.
    return reply.vectors.map((v) => Array.from(v));
  }

  dimension(): number {
    return this.dim;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      // Don't wait forever for a reply — a wedged worker would hang
      // dispose() indefinitely. Race the ack against a short timeout.
      await Promise.race([
        this.request('dispose', {}),
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
    } catch {
      // Worker may already be dead — fall through to terminate.
    }
    this.worker.terminate();
    // Reject anything still pending.
    this.rejectAllPending(new Error('WorkerEmbedder disposed'));
  }

  private rejectAllPending(err: Error): void {
    for (const req of this.pending.values()) req.reject(err);
    this.pending.clear();
  }

  private request<TReply>(
    type: 'init' | 'embed' | 'dispose',
    args: Record<string, unknown>,
  ): Promise<TReply> {
    if (this.disposed && type !== 'dispose') {
      return Promise.reject(new Error('WorkerEmbedder disposed'));
    }
    const seq = this.nextSeq++;
    return new Promise<TReply>((resolve, reject) => {
      this.pending.set(seq, {
        type,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      try {
        this.worker.postMessage({ seq, type, ...args });
      } catch (err) {
        // postMessage can throw (e.g. worker terminated). Don't leave a
        // dangling pending entry that would never settle.
        this.pending.delete(seq);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private onMessage(msg: OutMessage): void {
    const req = this.pending.get(msg.seq);
    if (!req) return;
    this.pending.delete(msg.seq);
    if (msg.type === 'error') {
      const err = new Error(msg.message);
      req.reject(err);
      // A failed init means the model never loaded — the worker is
      // unusable. Make it terminal so embed() calls fail fast.
      if (req.type === 'init') {
        this.disposed = true;
        this.worker.terminate();
        this.rejectAllPending(err);
      }
      return;
    }
    if (msg.type === 'init-done') {
      req.resolve({ dimension: msg.dimension });
      return;
    }
    if (msg.type === 'embed-result') {
      req.resolve({ vectors: msg.vectors });
      return;
    }
    if (msg.type === 'dispose-done') {
      req.resolve(undefined);
      return;
    }
  }
}
