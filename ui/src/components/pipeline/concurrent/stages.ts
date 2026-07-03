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
 * Concrete INodeStage implementations that wrap the existing
 * pipeline's extraction, resolution, and summarization logic.
 *
 * These stages are designed to run inside `runNodePipeline()`.
 * Scanning runs upfront (outside the concurrent pipeline) since
 * it builds shared lookup maps that all stages depend on.
 *
 * Stage order: FileCacheStage → ExtractStage → ResolveStage → SummarizeStage → StoreStage
 */

import type {
  CodeSymbol,
  GraphNode,
  GraphRelationship,
  ScanResult,
} from '../types';
import type { Registries, CallInfo } from '../parser/callResolver';
import {
  resolveCalls,
  resolvedCallsToRelationships,
} from '../parser/callResolver';
import { analyzeImports } from '../parser/importAnalyzer';
import type { ImportAnalysisResult } from '../parser/importAnalyzer';
import { detectLanguage, getExtension } from '../stages/loading';
import {
  getExtractor,
  getParserForLanguage,
  processSymbol,
} from '../stages/parsing';
import { summarizeFromMetadata } from '../summarizer/templateSummarizer';
import type { NodeKind } from '../summarizer/types';
import type { INodeStage, StageMutation } from './types';

// --- FileCacheStage ---

const DEFAULT_CACHE_LIMIT = 500 * 1024 * 1024; // 500 MB

export interface FileCacheStageConfig {
  /** Map from file ID to file content (from scanning). */
  fileContentMap: Map<string, string>;
  /** Maximum bytes to cache. Default 500 MB. */
  byteLimit?: number;
}

/**
 * Bounded file-content cache stage.
 *
 * Caches file contents up to the byte limit. Once full, nodes still
 * pass through but content won't be available for downstream extraction.
 * Provides a `getContent(fileId)` method for ExtractStage.
 */
export class FileCacheStage implements INodeStage {
  private readonly cache = new Map<string, string>();
  private bytesUsed = 0;
  private readonly byteLimit: number;
  private full = false;
  private cachedCount = 0;
  private skippedCount = 0;

  constructor(config: FileCacheStageConfig) {
    this.byteLimit = config.byteLimit ?? DEFAULT_CACHE_LIMIT;

    // Eagerly copy content into the cache so the caller can clear the
    // source map immediately to free memory.
    for (const [fileId, content] of config.fileContentMap) {
      const byteSize = content.length * 2;
      if (this.bytesUsed + byteSize <= this.byteLimit) {
        this.cache.set(fileId, content);
        this.bytesUsed += byteSize;
        this.cachedCount++;
      } else {
        this.full = true;
        this.skippedCount++;
      }
    }
  }

  name(): string {
    return 'cache';
  }

  process(node: GraphNode): StageMutation {
    // Passthrough — caching was done eagerly in the constructor
    return { nodes: [node], relationships: [] };
  }

  flush(): StageMutation {
    return { nodes: [], relationships: [] };
  }

  /** Read cached content for a file. Returns undefined if not cached. */
  getContent(fileId: string): string | undefined {
    return this.cache.get(fileId);
  }

  /**
   * Remove a file from the raw cache (e.g. after extraction is done).
   * Frees the JS string so GC can reclaim the memory.
   */
  evict(fileId: string): void {
    const content = this.cache.get(fileId);
    if (content) {
      this.bytesUsed -= content.length * 2;
      this.cache.delete(fileId);
    }
  }

  /** Current bytes used by the cache. */
  getBytesUsed(): number {
    return this.bytesUsed;
  }

  /** Whether the cache limit has been reached. */
  isFull(): boolean {
    return this.full;
  }

  /** Number of files cached vs skipped. */
  stats(): {
    cached: number;
    skipped: number;
    bytesUsed: number;
    byteLimit: number;
  } {
    return {
      cached: this.cachedCount,
      skipped: this.skippedCount,
      bytesUsed: this.bytesUsed,
      byteLimit: this.byteLimit,
    };
  }
}

// --- Shared extraction state + merge ---

/**
 * Mutable state accumulated while extracting a repo: the call-resolution
 * registries + per-symbol call info (consumed by ResolveStage), plus the
 * package-node dedupe set and the repo-constant lookups. Shared by BOTH the
 * main-thread ExtractStage and the worker-pool path so both produce identical
 * output (parity is guaranteed by using one merge function).
 */
export interface ExtractionState {
  registries: Registries;
  allCallInfo: CallInfo[];
  packageNodes: Map<string, GraphNode>;
  pendingPackageNodes: GraphNode[];
  emittedNodeIds: Set<string>;
  knownPaths: Set<string>;
  pathToFileId: Map<string, string>;
  goModulePath?: string;
}

export function createExtractionState(scanResult: ScanResult): ExtractionState {
  return {
    registries: {
      nameRegistry: new Map(),
      fileRegistry: new Map(),
      classRegistry: new Map(),
      importRegistry: new Map(),
    },
    allCallInfo: [],
    packageNodes: new Map(scanResult.packageNodes),
    pendingPackageNodes: [],
    emittedNodeIds: new Set(),
    knownPaths: scanResult.knownPaths,
    pathToFileId: scanResult.pathToFileId,
    goModulePath: scanResult.goModulePath,
  };
}

/**
 * Parse + walk one file on the CURRENT thread (main thread, or a worker that
 * has called initParsers). Returns null for non-parseable files / parse
 * failures. The tree is freed before returning.
 */
export function extractFile(
  filePath: string,
  content: string,
  knownPaths: Set<string>,
  goModulePath: string | undefined,
): {
  language: string;
  symbols: CodeSymbol[];
  importResult: ImportAnalysisResult;
} | null {
  const ext = getExtension(filePath);
  const language = detectLanguage(ext);
  if (!language) return null;

  const parser = getParserForLanguage(language, ext);
  const extractor = getExtractor(language);
  if (!parser || !extractor) return null;

  const tree = parser.parse(content);
  if (!tree) return null;

  try {
    const extraction = extractor(tree.rootNode);
    const importResult = analyzeImports(
      tree.rootNode,
      language,
      filePath,
      knownPaths,
      goModulePath,
    );
    return { language, symbols: extraction.symbols, importResult };
  } finally {
    // Free the WASM-backed tree — we're done walking it.
    tree.delete();
  }
}

/**
 * Merge one file's extraction (symbols + import analysis) into the shared
 * registries, producing that file's symbol nodes + DEFINES/IMPORTS rels.
 * Pure main-thread work on serializable data. Does NOT include the File node
 * itself — it's already a pipeline seed / already streamed.
 */
export function mergeExtraction(
  fileId: string,
  language: string,
  symbols: CodeSymbol[],
  importResult: ImportAnalysisResult,
  state: ExtractionState,
): StageMutation {
  const nodes: GraphNode[] = [];
  const rels: GraphRelationship[] = [];

  state.registries.fileRegistry.set(fileId, new Map());

  for (const sym of symbols) {
    processSymbol(
      sym,
      fileId,
      language,
      state.registries,
      state.allCallInfo,
      nodes,
      rels,
      state.emittedNodeIds,
    );
  }

  // Internal imports → importRegistry + IMPORTS edges
  const fileImports: Record<string, string> = {};
  const seenTargetFiles = new Set<string>();
  for (const [alias, targetPath] of Object.entries(importResult.internal)) {
    const targetFileId = state.pathToFileId.get(targetPath);
    if (targetFileId) {
      fileImports[alias] = targetFileId;
      if (!seenTargetFiles.has(targetFileId)) {
        seenTargetFiles.add(targetFileId);
        rels.push({
          id: `${fileId}->IMPORTS->${targetFileId}`,
          type: 'IMPORTS',
          source_id: fileId,
          target_id: targetFileId,
        });
      }
    }
  }
  state.registries.importRegistry.set(fileId, fileImports);

  // External imports → IMPORTS rels + new Dependency nodes
  for (const [pkgName, pkgId] of Object.entries(importResult.external)) {
    if (!state.packageNodes.has(pkgId)) {
      const pkgNode: GraphNode = {
        id: pkgId,
        type: 'Dependency',
        name: pkgName,
        properties: { registry: pkgId.split(':')[1] },
      };
      state.packageNodes.set(pkgId, pkgNode);
      state.pendingPackageNodes.push(pkgNode);
    }
    rels.push({
      id: `${fileId}->IMPORTS->${pkgId}`,
      type: 'IMPORTS',
      source_id: fileId,
      target_id: pkgId,
    });
  }

  return { nodes, relationships: rels };
}

// --- ExtractStage ---

export interface ExtractStageConfig {
  scanResult: ScanResult;
  /** Content provider — typically the FileCacheStage. */
  getContent: (fileId: string) => string | undefined;
}

/**
 * Processes File nodes: parses with tree-sitter, extracts symbols, analyzes
 * imports. Produces Class/Function/Package nodes and DEFINES/IMPORTS
 * relationships. Non-File nodes (and non-parseable files) pass through
 * unchanged. Accumulates registries and callInfo for use by ResolveStage.
 *
 * NOTE: this is the single-threaded path (used for tiny repos / tests). Large
 * repos parse via the worker pool (see extractPool.ts) which calls the same
 * {@link extractFile} + {@link mergeExtraction} functions off the main thread.
 */
export class ExtractStage implements INodeStage {
  readonly state: ExtractionState;
  private readonly getContent: (fileId: string) => string | undefined;

  constructor(config: ExtractStageConfig) {
    this.state = createExtractionState(config.scanResult);
    this.getContent = config.getContent;
  }

  /** Exposed for ResolveStage (structural). */
  get registries(): Registries {
    return this.state.registries;
  }
  get allCallInfo(): CallInfo[] {
    return this.state.allCallInfo;
  }

  name(): string {
    return 'extract';
  }

  process(node: GraphNode): StageMutation {
    if (node.type !== 'File') {
      return { nodes: [node], relationships: [] };
    }

    const filePath = node.properties?.path as string | undefined;
    if (!filePath) {
      return { nodes: [node], relationships: [] };
    }

    const content = this.getContent(node.id);
    if (content === undefined) {
      return { nodes: [node], relationships: [] };
    }

    let extracted: ReturnType<typeof extractFile> = null;
    try {
      extracted = extractFile(
        filePath,
        content,
        this.state.knownPaths,
        this.state.goModulePath,
      );
    } catch {
      // Parse error — return the File node so it still flows to summarization
      return { nodes: [node], relationships: [] };
    }
    if (!extracted) {
      return { nodes: [node], relationships: [] };
    }

    const merged = mergeExtraction(
      node.id,
      extracted.language,
      extracted.symbols,
      extracted.importResult,
      this.state,
    );
    // File node passes through to downstream stages, then the symbol nodes.
    return {
      nodes: [node, ...merged.nodes],
      relationships: merged.relationships,
    };
  }

  flush(): StageMutation {
    // Emit any external package nodes accumulated during processing
    const nodes = this.state.pendingPackageNodes.splice(0);
    return { nodes, relationships: [] };
  }
}

// --- ResolveStage ---

/**
 * Call resolution stage. Per-node processing is a passthrough since
 * resolution requires the complete symbol registry.
 *
 * All real work happens in flush(): bulk-resolves all accumulated
 * calls using the 7-strategy resolver.
 */
export class ResolveStage implements INodeStage {
  private readonly src: { registries: Registries; allCallInfo: CallInfo[] };

  /** Accepts an ExtractStage or a bare ExtractionState (structural). */
  constructor(src: { registries: Registries; allCallInfo: CallInfo[] }) {
    this.src = src;
  }

  name(): string {
    return 'resolve';
  }

  process(node: GraphNode): StageMutation {
    // Passthrough — resolution needs the complete registry
    return { nodes: [node], relationships: [] };
  }

  flush(): StageMutation {
    const { registries, allCallInfo } = this.src;
    const resolvedCalls = resolveCalls(allCallInfo, registries);
    const callRels = resolvedCallsToRelationships(resolvedCalls);
    return { nodes: [], relationships: callRels };
  }
}

// --- SummarizeStage ---

const TYPE_TO_KIND: Record<string, NodeKind> = {
  Function: 'function',
  Class: 'class',
  File: 'file',
  Directory: 'directory',
};

/**
 * Adds a template-based summary to every node that doesn't already
 * have one. Stateless per-node operation.
 */
export class SummarizeStage implements INodeStage {
  name(): string {
    return 'summarize';
  }

  process(node: GraphNode): StageMutation {
    if (!node.properties?.summary) {
      const summary = this.summarizeNode(node);
      if (summary) {
        node.properties = { ...node.properties, summary };
      }
    }
    return { nodes: [node], relationships: [] };
  }

  flush(): StageMutation {
    return { nodes: [], relationships: [] };
  }

  private summarizeNode(node: GraphNode): string {
    const kind = TYPE_TO_KIND[node.type];
    if (!kind) {
      return `${node.type} ${node.name}`;
    }

    const props = node.properties ?? {};
    return summarizeFromMetadata({
      name: node.name,
      kind,
      signature: props.signature as string | undefined,
      language: props.language as string | undefined,
      lineCount:
        typeof props.startLine === 'number' && typeof props.endLine === 'number'
          ? props.endLine - props.startLine + 1
          : undefined,
      receiverType: props.receiver_type as string | undefined,
      fileName:
        kind === 'file' ? ((props.path as string) ?? node.name) : undefined,
      childNames: props.childNames as string[] | undefined,
      docs: props.docs as string | undefined,
    });
  }
}

// --- StoreStage ---

/** Default number of nodes to buffer before signalling a drain. */
const DEFAULT_DRAIN_THRESHOLD = 500;

/**
 * Terminal stage that accumulates graph data for incremental persistence.
 *
 * During process(), nodes are buffered internally (not forwarded further).
 * When the buffer reaches `drainThreshold`, the caller should drain it
 * via {@link drainNodes} and persist the batch to the store. This keeps
 * peak memory bounded — the DB ingests data incrementally instead of in
 * one giant batch at the end.
 *
 * Relationships are accumulated separately via `addRelationships()` and
 * flushed at the end (they require all endpoint nodes to already exist).
 */
export class StoreStage implements INodeStage {
  private bufferedNodes: GraphNode[] = [];
  private bufferedRelationships: GraphRelationship[] = [];
  private totalNodes = 0;
  private totalRelationships = 0;
  private readonly drainThreshold: number;

  constructor(drainThreshold = DEFAULT_DRAIN_THRESHOLD) {
    this.drainThreshold = drainThreshold;
  }

  name(): string {
    return 'store';
  }

  process(node: GraphNode): StageMutation {
    this.bufferedNodes.push(node);
    this.totalNodes++;
    // Forward the node so downstream stages (e.g. EmbedStage) can see it
    return { nodes: [node], relationships: [] };
  }

  /**
   * Feed relationships from upstream stage mutations.
   * Call this from the event loop when processing StageEvent 'end' mutations.
   */
  addRelationships(rels: GraphRelationship[]): void {
    for (let i = 0; i < rels.length; i++) {
      this.bufferedRelationships.push(rels[i]);
      this.totalRelationships++;
    }
  }

  /** True when the node buffer has reached the drain threshold. */
  needsDrain(): boolean {
    return this.bufferedNodes.length >= this.drainThreshold;
  }

  /**
   * Return and clear buffered nodes. The caller should persist these
   * to the store (importBatch + flush). Called periodically from the
   * event loop, not just at the end.
   */
  drainNodes(): GraphNode[] {
    const nodes = this.bufferedNodes;
    this.bufferedNodes = [];
    return nodes;
  }

  /**
   * Return and clear buffered relationships. Called once at the end
   * after all nodes have been persisted.
   */
  drainRelationships(): GraphRelationship[] {
    const rels = this.bufferedRelationships;
    this.bufferedRelationships = [];
    return rels;
  }

  flush(): StageMutation {
    // Any remaining nodes + all relationships
    return {
      nodes: this.bufferedNodes,
      relationships: this.bufferedRelationships,
    };
  }

  /** Cumulative counts (including already-drained items). */
  stats(): { nodes: number; relationships: number } {
    return {
      nodes: this.totalNodes,
      relationships: this.totalRelationships,
    };
  }
}

// --- EmbedStage ---

import type {
  Embedder,
  EmbedderConfig,
} from '../../../runner/browser/enricher/embedder/types';
import type { GraphStore } from '../../../store/types';

export interface EmbedStageConfig {
  config: EmbedderConfig;
  store: GraphStore;
}

/**
 * Embedding stage decoupled from the pipeline tick loop.
 *
 * process() collects File nodes without blocking. The ONNX model
 * starts loading in the constructor so it overlaps with the entire
 * pipeline. settle() runs the actual inference sequentially (one
 * batch at a time) after the pipeline is done.
 */
export class EmbedStage implements INodeStage {
  private initPromise: Promise<Embedder | null> | null = null;
  private readonly embedderConfig: EmbedderConfig;
  private readonly store: GraphStore;
  private queue: GraphNode[] = [];
  private embedded = 0;
  private _total = 0;

  constructor({ config, store }: EmbedStageConfig) {
    this.embedderConfig = config;
    this.store = store;
    // Start model loading immediately — overlaps with earlier stages
    this.ensureModel();
  }

  name(): string {
    return 'embed';
  }

  private ensureModel(): Promise<Embedder | null> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          // Embedder runs in a Web Worker (Fix #55 / Plan E) so
          // inference doesn't block the Pixi ticker during indexing.
          // `WorkerEmbedder` implements the same `Embedder` interface
          // as the old in-process `MiniLmEmbedder`, so the rest of
          // the pipeline doesn't know the difference.
          const { WorkerEmbedder } =
            await import('../../../runner/browser/enricher/embedder/workerEmbedder');
          const embedder = new WorkerEmbedder(this.embedderConfig);
          await embedder.init();
          this.store.setEmbedder?.(embedder);
          return embedder;
        } catch (err) {
          // Returning null keeps the rest of the pipeline working — the user
          // gets an indexed graph without embeddings rather than a hard crash.
          // But the failure must be visible: silent zero-embedding states are
          // indistinguishable from "embedding disabled" and have cost real
          // hours of debugging when chunk URLs go stale or model fetches are
          // blocked by CSP/COEP.
          console.error('[EmbedStage] embedder init failed:', err);
          return null;
        }
      })();
    }
    return this.initPromise;
  }

  process(node: GraphNode): StageMutation {
    if (node.type === 'File' && !node.properties?.has_embedding) {
      this.queue.push(node);
      this._total++;
    }
    return { nodes: [], relationships: [] };
  }

  flush(): StageMutation {
    return { nodes: [], relationships: [] };
  }

  /**
   * Run embedding sequentially on all queued nodes. The model was
   * pre-loaded in the constructor so init is already done by now.
   */
  async settle(
    onProgress?: (embedded: number, total: number) => void,
  ): Promise<void> {
    const embedder = await this.ensureModel();
    if (!embedder) {
      // Init failed — drop queued nodes so the (potentially long-lived)
      // EmbedStage instance does not retain File-node references and their
      // attached source/summary properties. For large repos the queue can
      // hold thousands of entries.
      this.queue = [];
      return;
    }
    if (this.queue.length === 0) return;

    const BATCH = 8;
    for (let off = 0; off < this.queue.length; off += BATCH) {
      const batch = this.queue.slice(off, off + BATCH);
      const texts = batch.map((n) => {
        const parts = [n.name, n.type];
        const props = n.properties ?? {};
        if (typeof props.summary === 'string') parts.push(props.summary);
        if (typeof props.path === 'string') parts.push(props.path);
        return parts.join(' ');
      });

      try {
        const vectors = await embedder.embed(texts);
        const pending: { id: string; vec: number[] }[] = [];
        for (let i = 0; i < batch.length; i++) {
          if (vectors[i] && vectors[i].length > 0) {
            pending.push({ id: batch[i].id, vec: vectors[i] });
          }
        }
        if (pending.length > 0 && this.store.importVectors) {
          await this.store.importVectors(pending);
          this.embedded += pending.length;
        }
      } catch (err) {
        // Skip the bad batch but keep going — one toxic input shouldn't
        // abort the whole indexing run. Log so the failure is debuggable
        // instead of silently dropping vectors.
        console.error(
          `[EmbedStage] batch failed (offset ${off}, size ${batch.length}):`,
          err,
        );
      }

      onProgress?.(this.embedded, this.queue.length);
      await new Promise<void>((r) => setTimeout(r, 0));
    }

    // Free node references — they're persisted in the DB now
    this.queue = [];
  }

  get embeddedCount(): number {
    return this.embedded;
  }

  get total(): number {
    return this._total;
  }
}
