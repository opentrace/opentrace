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
 * Main-thread proxy for the LadybugGraphStore Web Worker (Fix #56 / Plan D).
 *
 * Implements the `GraphStore` interface by forwarding each call to
 * `storeWorker.ts` over `postMessage`. All the JS scaffolding that used
 * to burst the main thread during indexing (BM25 build, CSV string
 * generation, deflate, Parquet I/O, row → DTO mapping) now lives in the
 * worker.
 *
 * `hasData()` stays synchronous via a main-thread shadow counter
 * maintained on importBatch / importDatabase / clearGraph replies.
 *
 * `setEmbedder()` keeps the actual WorkerEmbedder on the main thread —
 * the store worker installs a shim that bounces `embed-request` messages
 * back here for forwarding. One extra postMessage hop per query embed,
 * vs the alternative of duplicating the ONNX model in a third worker.
 */

import type { GraphData, GraphStats } from '@opentrace/components/utils';
import type { Embedder } from '../runner/browser/enricher/embedder/types';
import type {
  GraphStore,
  ImportBatchRequest,
  ImportBatchResponse,
  IndexMetadata,
  NodeResult,
  NodeSourceResponse,
  SourceFile,
  TraverseResult,
} from './types';

type InMessage =
  | { seq: number; type: 'result'; value: unknown }
  | { seq: number; type: 'error'; message: string }
  | { seq: number; type: 'progress'; value: string }
  | { seq: number; type: 'embed-request'; texts: string[] };

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  onProgress?: (msg: string) => void;
}

export class WorkerGraphStore implements GraphStore {
  private worker: Worker;
  private pending = new Map<number, PendingRequest>();
  private nextSeq = 1;
  private embedder: Embedder | null = null;
  private nodesImportedSinceClear = 0;

  constructor() {
    this.worker = new Worker(
      new URL('./storeWorker.ts', import.meta.url),
      { type: 'module' },
    );
    this.worker.onmessage = (e: MessageEvent<InMessage>) => this.onMessage(e.data);
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'store worker error');
      for (const req of this.pending.values()) req.reject(err);
      this.pending.clear();
    };
    // The inner store used to read these from localStorage during init, but
    // Workers don't expose localStorage. Read them here and push them in once.
    try {
      const savedNodes = localStorage.getItem('ot:maxVisNodes');
      const savedEdges = localStorage.getItem('ot:maxVisEdges');
      if (savedNodes || savedEdges) {
        const maxN = savedNodes ? Number(savedNodes) : 2000;
        const maxE = savedEdges ? Number(savedEdges) : 5000;
        if (Number.isFinite(maxN) && Number.isFinite(maxE)) {
          void this.setLimits(maxN, maxE);
        }
      }
    } catch {
      // localStorage may be unavailable (SSR, sandboxed iframe) — limits keep
      // their defaults in that case.
    }
  }

  // --- GraphStore interface ---

  hasData(): boolean {
    return this.nodesImportedSinceClear > 0;
  }

  ensureReady(): Promise<void> {
    return this.call<void>('ensureReady', []);
  }

  fetchGraph(query?: string, hops?: number): Promise<GraphData> {
    return this.call<GraphData>('fetchGraph', [query, hops]);
  }

  fetchStats(): Promise<GraphStats> {
    return this.call<GraphStats>('fetchStats', []);
  }

  fetchMetadata(): Promise<IndexMetadata[]> {
    return this.call<IndexMetadata[]>('fetchMetadata', []);
  }

  async clearGraph(): Promise<void> {
    await this.call<void>('clearGraph', []);
    this.nodesImportedSinceClear = 0;
  }

  deleteRepo(repoId: string): Promise<void> {
    return this.call<void>('deleteRepo', [repoId]);
  }

  setLimits(maxNodes: number, maxEdges: number): Promise<void> {
    return this.call<void>('setLimits', [maxNodes, maxEdges]);
  }

  async importBatch(batch: ImportBatchRequest): Promise<ImportBatchResponse> {
    const result = await this.call<ImportBatchResponse>('importBatch', [batch]);
    this.nodesImportedSinceClear += batch.nodes.length;
    return result;
  }

  flush(): Promise<void> {
    return this.call<void>('flush', []);
  }

  importVectors(vectors: { id: string; vec: number[] }[]): Promise<void> {
    return this.call<void>('importVectors', [vectors]);
  }

  async importDatabase(
    data: Uint8Array,
    onProgress?: (msg: string) => void,
  ): Promise<ImportBatchResponse> {
    // Transfer the Uint8Array buffer zero-copy; the proxy no longer holds
    // a usable view after this call, but no caller in the codebase reuses
    // the bytes after handing them off.
    const result = await this.call<ImportBatchResponse>(
      'importDatabase',
      [data, !!onProgress],
      [data.buffer],
      onProgress,
    );
    this.nodesImportedSinceClear += result.nodes_created;
    return result;
  }

  exportDatabase(options?: {
    includeSource?: boolean;
    repoId?: string;
  }): Promise<Uint8Array> {
    return this.call<Uint8Array>('exportDatabase', [options]);
  }

  setEmbedder(embedder: unknown): void {
    this.embedder = embedder as Embedder;
    this.worker.postMessage({ type: 'set-embedder' });
  }

  storeSource(files: SourceFile[]): void {
    // Fire-and-forget — matches the synchronous-void shape of the inner
    // method. Callers pass the entire repo corpus in a single array; for a
    // large repo (e.g. Grafana, ~15k files / 100s of MB) a single
    // postMessage's structured-clone serialize blocks main long enough for
    // the browser to mark the tab unresponsive. Chunk so main can breathe
    // between batches.
    const CHUNK = 200;
    if (files.length <= CHUNK) {
      void this.call<void>('storeSource', [files]);
      return;
    }
    void (async () => {
      for (let i = 0; i < files.length; i += CHUNK) {
        const slice = files.slice(i, i + CHUNK);
        await this.call<void>('storeSource', [slice]);
      }
    })();
  }

  fetchSource(
    nodeId: string,
    startLine?: number,
    endLine?: number,
  ): Promise<NodeSourceResponse | null> {
    return this.call<NodeSourceResponse | null>('fetchSource', [
      nodeId,
      startLine,
      endLine,
    ]);
  }

  searchNodes(
    query: string,
    limit?: number,
    nodeTypes?: string[],
  ): Promise<NodeResult[]> {
    return this.call<NodeResult[]>('searchNodes', [query, limit, nodeTypes]);
  }

  listNodes(
    type: string,
    limit?: number,
    filters?: Record<string, string>,
  ): Promise<NodeResult[]> {
    return this.call<NodeResult[]>('listNodes', [type, limit, filters]);
  }

  getNode(nodeId: string): Promise<NodeResult | null> {
    return this.call<NodeResult | null>('getNode', [nodeId]);
  }

  traverse(
    nodeId: string,
    direction?: 'outgoing' | 'incoming' | 'both',
    maxDepth?: number,
    relType?: string,
  ): Promise<TraverseResult[]> {
    return this.call<TraverseResult[]>('traverse', [
      nodeId,
      direction,
      maxDepth,
      relType,
    ]);
  }

  grepSource(
    pattern: string,
    options?: {
      caseSensitive?: boolean;
      maxResults?: number;
      fileFilter?: string;
    },
  ): Promise<
    { nodeId: string; filePath: string; line: number; text: string }[]
  > {
    return this.call('grepSource', [pattern, options]);
  }

  async dispose(): Promise<void> {
    try {
      await this.call<void>('dispose', []);
    } catch {
      // ignore — worker may already be dead
    }
    this.worker.terminate();
    const err = new Error('WorkerGraphStore disposed');
    for (const req of this.pending.values()) req.reject(err);
    this.pending.clear();
  }

  // --- Internal ---

  private call<T>(
    method: string,
    args: unknown[],
    transfer?: Transferable[],
    onProgress?: (msg: string) => void,
  ): Promise<T> {
    const seq = this.nextSeq++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(seq, {
        resolve: resolve as (v: unknown) => void,
        reject,
        onProgress,
      });
      const msg = { seq, type: 'call' as const, method, args };
      if (transfer && transfer.length > 0) {
        this.worker.postMessage(msg, transfer);
      } else {
        this.worker.postMessage(msg);
      }
    });
  }

  private onMessage(msg: InMessage): void {
    if (msg.type === 'embed-request') {
      void this.handleEmbedRequest(msg.seq, msg.texts);
      return;
    }
    const req = this.pending.get(msg.seq);
    if (!req) return;
    if (msg.type === 'progress') {
      req.onProgress?.(msg.value);
      return;
    }
    this.pending.delete(msg.seq);
    if (msg.type === 'error') {
      req.reject(new Error(msg.message));
      return;
    }
    if (msg.type === 'result') {
      req.resolve(msg.value);
      return;
    }
  }

  private async handleEmbedRequest(
    seq: number,
    texts: string[],
  ): Promise<void> {
    if (!this.embedder) {
      this.worker.postMessage({
        seq,
        type: 'embed-error',
        message: 'no embedder configured',
      });
      return;
    }
    try {
      const vectors = await this.embedder.embed(texts);
      this.worker.postMessage({ seq, type: 'embed-reply', vectors });
    } catch (err) {
      this.worker.postMessage({
        seq,
        type: 'embed-error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
