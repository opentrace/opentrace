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
import { createLbugEngine, type LbugEngine } from './lbugEngine';
import type {
  CountByResult,
  FindOrphansResult,
  FindPathResult,
  FindViaResult,
  GraphStore,
  GrepResult,
  ImportBatchRequest,
  ImportBatchResponse,
  IndexMetadata,
  NodeResult,
  NodeSourceResponse,
  OverviewResult,
  ProvenanceResult,
  SearchResult,
  SourceFile,
  TraverseResult,
} from './types';

type EngineMethod =
  | 'init'
  | 'query'
  | 'exec'
  | 'fsWrite'
  | 'fsUnlink'
  | 'close';

type InMessage =
  | { seq: number; type: 'result'; value: unknown }
  | { seq: number; type: 'error'; message: string }
  | { seq: number; type: 'progress'; value: string }
  | { seq: number; type: 'embed-request'; texts: string[] }
  | {
      seq: number;
      type: 'engine-request';
      method: EngineMethod;
      args: unknown[];
    };

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
  // The LadybugDB engine is owned here, on the main thread, so its internal
  // worker is a top-level worker rather than one nested inside storeWorker
  // (which broke on browsers without worker-in-worker support — Sentry
  // OSS-OPENTRACE-1G). storeWorker reaches it via `engine-request` messages.
  private engine: LbugEngine = createLbugEngine();
  private nodesImportedSinceClear = 0;
  // Serializes storeSource's chunked posts. Ordering-sensitive methods
  // (flush, exportDatabase, clearGraph, deleteRepo, importDatabase) await
  // this so they can't overtake source chunks that haven't been posted yet.
  // Always resolves — per-chunk errors are caught and logged in the pump.
  private pendingSource: Promise<void> = Promise.resolve();

  constructor() {
    this.worker = new Worker(new URL('./storeWorker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<InMessage>) =>
      this.onMessage(e.data);
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

  fetchGraphSkeleton(types: string[]): Promise<GraphData> {
    return this.call<GraphData>('fetchGraphSkeleton', [types]);
  }

  fetchGraphPage(opts: {
    type: string;
    offset: number;
    limit: number;
  }): Promise<{
    nodes: GraphData['nodes'];
    links: GraphData['links'];
    exhausted: boolean;
  }> {
    return this.call('fetchGraphPage', [opts]);
  }

  fetchStats(): Promise<GraphStats> {
    return this.call<GraphStats>('fetchStats', []);
  }

  fetchMetadata(): Promise<IndexMetadata[]> {
    return this.call<IndexMetadata[]>('fetchMetadata', []);
  }

  async clearGraph(): Promise<void> {
    await this.pendingSource;
    await this.call<void>('clearGraph', []);
    this.nodesImportedSinceClear = 0;
  }

  async deleteRepo(repoId: string): Promise<void> {
    await this.pendingSource;
    return this.call<void>('deleteRepo', [repoId]);
  }

  setLimits(maxNodes: number, maxEdges: number): Promise<void> {
    return this.call<void>('setLimits', [maxNodes, maxEdges]);
  }

  setSkipSourceContent(skip: boolean): Promise<void> {
    return this.call<void>('setSkipSourceContent', [skip]);
  }

  async importBatch(batch: ImportBatchRequest): Promise<ImportBatchResponse> {
    const result = await this.call<ImportBatchResponse>('importBatch', [batch]);
    // Count nodes actually created, not the batch size — the worker may reject
    // some (reported via result.errors), so batch.nodes.length would overcount.
    this.nodesImportedSinceClear += result.nodes_created;
    return result;
  }

  async flush(): Promise<void> {
    // Source chunks must land before the flush that persists them.
    await this.pendingSource;
    return this.call<void>('flush', []);
  }

  importVectors(vectors: { id: string; vec: number[] }[]): Promise<void> {
    return this.call<void>('importVectors', [vectors]);
  }

  async importDatabase(
    data: Uint8Array,
    onProgress?: (msg: string) => void,
  ): Promise<ImportBatchResponse> {
    // Serialize behind any in-flight source posts — importDatabase clears
    // the store, and a straggler source chunk landing mid-import would
    // interleave stale source with the imported data.
    await this.pendingSource;
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

  async exportDatabase(options?: {
    includeSource?: boolean;
    repoId?: string;
  }): Promise<Uint8Array> {
    // An export must include source chunks that were queued before it.
    await this.pendingSource;
    return this.call<Uint8Array>('exportDatabase', [options]);
  }

  setEmbedder(embedder: unknown): void {
    this.embedder = embedder as Embedder;
    this.worker.postMessage({ type: 'set-embedder' });
  }

  storeSource(files: SourceFile[]): void {
    // Synchronous-void shape matches the GraphStore interface; the actual
    // posting is chained on `pendingSource`. Callers pass the entire repo
    // corpus in a single array; for a large repo (e.g. Grafana, ~15k files /
    // 100s of MB) a single postMessage's structured-clone serialize blocks
    // main long enough for the browser to mark the tab unresponsive. Chunk
    // so main can breathe between batches.
    //
    // Chaining (instead of fire-and-forget) fixes two bugs:
    //  * a failed chunk used to abandon the remaining chunks as an
    //    unhandled rejection — now each chunk's error is caught + logged
    //    and the pump continues with the rest;
    //  * flush()/exportDatabase()/clearGraph()/deleteRepo()/importDatabase()
    //    could overtake unposted chunks — they now await the pump first.
    const CHUNK = 200;
    this.pendingSource = this.pendingSource.then(async () => {
      for (let i = 0; i < files.length; i += CHUNK) {
        const slice = files.slice(i, i + CHUNK);
        try {
          await this.call<void>('storeSource', [slice]);
        } catch (err) {
          console.warn(
            `[WorkerGraphStore] storeSource chunk ${i / CHUNK} (${slice.length} files) failed:`,
            err,
          );
        }
      }
    });
  }

  async fetchSource(
    nodeId: string,
    startLine?: number,
    endLine?: number,
  ): Promise<NodeSourceResponse | null> {
    // Don't answer from a source cache that's still being populated —
    // the file being asked for may sit in an unposted chunk.
    await this.pendingSource;
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

  // ─── Retrieval primitives ────────────────────────────────────────────
  // Straight proxies to the worker's LadybugStore, which owns the real
  // implementations. They exist here because `GraphStore` declares them
  // REQUIRED and chat/tools.ts calls them unguarded — a store that reached
  // those call sites without them would throw at runtime, not degrade.

  search(
    query: string,
    options?: { limit?: number; nodeTypes?: string[]; vaultScope?: string },
  ): Promise<SearchResult> {
    return this.call<SearchResult>('search', [query, options]);
  }

  overview(options?: {
    topN?: number;
    vaultScope?: string;
  }): Promise<OverviewResult> {
    return this.call<OverviewResult>('overview', [options]);
  }

  findPath(
    startId: string,
    endId: string,
    maxHops?: number,
    edgeTypes?: string[],
  ): Promise<FindPathResult> {
    return this.call<FindPathResult>('findPath', [
      startId,
      endId,
      maxHops,
      edgeTypes,
    ]);
  }

  findOrphans(
    nodeType: string,
    edgeType: string,
    direction?: 'incoming' | 'outgoing' | 'both',
    limit?: number,
  ): Promise<FindOrphansResult> {
    return this.call<FindOrphansResult>('findOrphans', [
      nodeType,
      edgeType,
      direction,
      limit,
    ]);
  }

  findViaRelationshipToType(
    startType: string,
    edgeType: string,
    targetType: string,
    limit?: number,
  ): Promise<FindViaResult> {
    return this.call<FindViaResult>('findViaRelationshipToType', [
      startType,
      edgeType,
      targetType,
      limit,
    ]);
  }

  countBy(
    nodeType: string,
    options?: { parentId?: string; parentEdge?: string; maxHops?: number },
  ): Promise<CountByResult> {
    return this.call<CountByResult>('countBy', [nodeType, options]);
  }

  provenance(nodeId: string): Promise<ProvenanceResult> {
    return this.call<ProvenanceResult>('provenance', [nodeId]);
  }

  grep(
    pattern: string,
    scopeId: string,
    options?: {
      fileFilter?: string;
      caseSensitive?: boolean;
      maxResults?: number;
    },
  ): Promise<GrepResult> {
    return this.call<GrepResult>('grep', [pattern, scopeId, options]);
  }

  async dispose(): Promise<void> {
    try {
      // Drives ladybugStore.dispose() in the worker, which calls
      // engine.close() back over RPC — closing the engine while the worker
      // is still alive to relay the request.
      await this.call<void>('dispose', []);
    } catch {
      // ignore — worker may already be dead
    }
    this.worker.terminate();
    // Belt-and-suspenders: if the RPC close didn't land (worker wedged),
    // close the engine directly. engine.close() is idempotent.
    try {
      await this.engine.close();
    } catch {
      // ignore — engine may already be closed
    }
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
    if (msg.type === 'engine-request') {
      void this.handleEngineRequest(msg.seq, msg.method, msg.args);
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

  private async handleEngineRequest(
    seq: number,
    method: EngineMethod,
    args: unknown[],
  ): Promise<void> {
    try {
      let value: unknown;
      switch (method) {
        case 'init':
          value = await this.engine.init();
          break;
        case 'query':
          value = await this.engine.query(args[0] as string);
          break;
        case 'exec':
          value = await this.engine.exec(args[0] as string);
          break;
        case 'fsWrite':
          value = await this.engine.fsWrite(
            args[0] as string,
            args[1] as Uint8Array,
          );
          break;
        case 'fsUnlink':
          value = await this.engine.fsUnlink(args[0] as string);
          break;
        case 'close':
          value = await this.engine.close();
          break;
        default:
          throw new Error(`unknown engine method '${method}'`);
      }
      this.worker.postMessage({ seq, type: 'engine-reply', value });
    } catch (err) {
      this.worker.postMessage({
        seq,
        type: 'engine-error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
