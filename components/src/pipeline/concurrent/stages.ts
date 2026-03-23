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

import type { GraphNode, GraphRelationship, ScanResult } from '../types';
import type { Registries, CallInfo } from '../parser/callResolver';
import {
  resolveCalls,
  resolvedCallsToRelationships,
} from '../parser/callResolver';
import { analyzeImports } from '../parser/importAnalyzer';
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
  stats(): { cached: number; skipped: number; bytesUsed: number; byteLimit: number } {
    return {
      cached: this.cachedCount,
      skipped: this.skippedCount,
      bytesUsed: this.bytesUsed,
      byteLimit: this.byteLimit,
    };
  }
}

// --- ExtractStage ---

export interface ExtractStageConfig {
  scanResult: ScanResult;
  /** Content provider — typically the FileCacheStage. */
  getContent: (fileId: string) => string | undefined;
}

/**
 * Processes File nodes: parses with tree-sitter, extracts symbols,
 * analyzes imports. Produces Class/Function/Package nodes and
 * DEFINED_IN/IMPORTS relationships.
 *
 * Non-File nodes (and non-parseable files) pass through unchanged.
 *
 * Accumulates registries and callInfo for use by ResolveStage.
 */
export class ExtractStage implements INodeStage {
  readonly registries: Registries = {
    nameRegistry: new Map(),
    fileRegistry: new Map(),
    classRegistry: new Map(),
    importRegistry: new Map(),
  };
  readonly allCallInfo: CallInfo[] = [];

  private readonly knownPaths: Set<string>;
  private readonly pathToFileId: Map<string, string>;
  private readonly goModulePath: string | undefined;
  private readonly getContent: (fileId: string) => string | undefined;
  private readonly packageNodes: Map<string, GraphNode>;
  private readonly emittedNodeIds = new Set<string>();
  private readonly pendingPackageNodes: GraphNode[] = [];

  constructor(config: ExtractStageConfig) {
    const { scanResult, getContent } = config;
    this.knownPaths = scanResult.knownPaths;
    this.pathToFileId = scanResult.pathToFileId;
    this.goModulePath = scanResult.goModulePath;
    this.getContent = getContent;
    this.packageNodes = new Map(scanResult.packageNodes);
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

    const ext = getExtension(filePath);
    const language = detectLanguage(ext);
    if (!language) {
      return { nodes: [node], relationships: [] };
    }

    const parser = getParserForLanguage(language, ext);
    const extractor = getExtractor(language);
    if (!parser || !extractor) {
      return { nodes: [node], relationships: [] };
    }

    const fileId = node.id;
    const content = this.getContent(fileId);
    if (content === undefined) {
      return { nodes: [node], relationships: [] };
    }

    const nodes: GraphNode[] = [node]; // File node passes through
    const rels: GraphRelationship[] = [];

    try {
      const tree = parser.parse(content);
      if (!tree) {
        return { nodes: [node], relationships: [] };
      }

      const extraction = extractor(tree.rootNode);

      // Initialize file registry entry
      this.registries.fileRegistry.set(fileId, new Map());

      // Process symbols → graph nodes + registries
      for (const sym of extraction.symbols) {
        processSymbol(
          sym,
          fileId,
          language,
          this.registries,
          this.allCallInfo,
          nodes,
          rels,
          this.emittedNodeIds,
        );
      }

      // Import analysis
      const rootNode = extraction.rootNode;
      if (rootNode) {
        const importResult = analyzeImports(
          rootNode,
          language,
          filePath,
          this.knownPaths,
          this.goModulePath,
        );

        // Internal imports → populate importRegistry + IMPORTS edges
        const fileImports: Record<string, string> = {};
        const seenTargetFiles = new Set<string>();
        for (const [alias, targetPath] of Object.entries(
          importResult.internal,
        )) {
          const targetFileId = this.pathToFileId.get(targetPath);
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
        this.registries.importRegistry.set(fileId, fileImports);

        // External imports → IMPORTS rels + new Package nodes
        for (const [pkgName, pkgId] of Object.entries(
          importResult.external,
        )) {
          if (!this.packageNodes.has(pkgId)) {
            const pkgNode: GraphNode = {
              id: pkgId,
              type: 'Package',
              name: pkgName,
              properties: { registry: pkgId.split(':')[1] },
            };
            this.packageNodes.set(pkgId, pkgNode);
            this.pendingPackageNodes.push(pkgNode);
          }

          rels.push({
            id: `${fileId}->IMPORTS->${pkgId}`,
            type: 'IMPORTS',
            source_id: fileId,
            target_id: pkgId,
          });
        }
      }
    } catch {
      // Parse error — return the File node so it still flows to summarization
      return { nodes: [node], relationships: [] };
    }

    return { nodes, relationships: rels };
  }

  flush(): StageMutation {
    // Emit any external package nodes accumulated during processing
    const nodes = this.pendingPackageNodes.splice(0);
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
  private readonly extractStage: ExtractStage;

  constructor(extractStage: ExtractStage) {
    this.extractStage = extractStage;
  }

  name(): string {
    return 'resolve';
  }

  process(node: GraphNode): StageMutation {
    // Passthrough — resolution needs the complete registry
    return { nodes: [node], relationships: [] };
  }

  flush(): StageMutation {
    const { registries, allCallInfo } = this.extractStage;
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
        typeof props.start_line === 'number' &&
        typeof props.end_line === 'number'
          ? props.end_line - props.start_line + 1
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
    // Terminal — do not forward nodes
    return { nodes: [], relationships: [] };
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
