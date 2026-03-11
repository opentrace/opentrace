/**
 * Core types for the browser-based code indexing pipeline.
 * Ported from agent/src/opentrace_agent/sources/code/extractors/base.py
 */

import type { Node as SyntaxNode } from "web-tree-sitter";

// --- Symbol extraction types ---

export interface CallRef {
  name: string;
  receiver: string | null;
  kind: "bare" | "attribute";
}

export interface CodeSymbol {
  name: string;
  kind: "class" | "function";
  startLine: number;
  endLine: number;
  signature: string | null;
  children: CodeSymbol[];
  calls: CallRef[];
  receiverVar: string | null;
  receiverType: string | null;
}

export interface ExtractionResult {
  symbols: CodeSymbol[];
  language: string;
  rootNode: SyntaxNode | null;
}

// --- Repo tree (from provider API) ---

export interface RepoFile {
  path: string;
  content: string;
  sha: string;
  size: number;
}

export interface RepoTree {
  owner: string;
  repo: string;
  ref: string;
  /** Full URL to the repository (e.g. https://github.com/owner/repo). */
  url?: string;
  files: RepoFile[];
}

// --- Graph nodes/relationships (matches Go API types) ---

export interface GraphNode {
  id: string;
  type: string;
  name: string;
  properties?: Record<string, unknown>;
  embedding?: number[];
}

export interface GraphRelationship {
  id: string;
  type: string;
  source_id: string;
  target_id: string;
  properties?: Record<string, unknown>;
}

export interface GraphBatch {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}

// --- Worker message protocol ---

export type IndexPhase =
  | "initializing"
  | "fetching"
  | "parsing"
  | "resolving"
  | "enriching"
  | "summarizing"
  | "embedding"
  | "submitting"
  | "done";

export interface ProgressDetail {
  current: number;
  total: number;
  fileName?: string;
  nodesCreated?: number;
  relationshipsCreated?: number;
}

export interface IndexSummary {
  filesProcessed: number;
  nodesCreated: number;
  relationshipsCreated: number;
  errors: string[];
  durationMs: number;
}

export interface SummarizerWorkerConfig {
  enabled: boolean;
  strategy: "template" | "ml" | "none";
  model: string;
  maxInputLength: number;
  minLines: number;
}

export interface EmbedderWorkerConfig {
  enabled: boolean;
  model: string;
}

// --- Enrichment item (emitted by parse worker, consumed by enrichment worker) ---

export interface EnrichItem {
  nodeId: string;
  nodeType: string;    // "File" | "Class" | "Function" | "Directory"
  nodeName: string;
  kind: "function" | "class" | "file" | "directory";
  source: string;      // code snippet for keyword extraction
  path?: string;       // for embedding searchText
  summary?: string;    // pre-computed template summary (set by pipeline)
}

// Main → Parse Worker messages
export type WorkerRequest =
  | { type: "init"; summarizerConfig?: SummarizerWorkerConfig }
  | { type: "index"; repo: RepoTree }
  | { type: "cancel" };

// Parse Worker → Main messages
export type WorkerResponse =
  | { type: "ready" }
  | { type: "progress"; phase: IndexPhase; message: string; detail: ProgressDetail }
  | { type: "stage-complete"; phase: IndexPhase; message: string }
  | { type: "batch"; nodes: GraphNode[]; relationships: GraphRelationship[] }
  | { type: "enrich-items"; items: EnrichItem[] }
  | { type: "done"; filesProcessed: number; nodesCreated: number; relationshipsCreated: number; errors: string[] }
  | { type: "error"; message: string };

// Main → Enrichment Worker messages
export type EnrichWorkerRequest =
  | { type: "init"; embedderConfig?: EmbedderWorkerConfig }
  | { type: "enrich"; items: EnrichItem[] }
  | { type: "cancel" };

// Enrichment Worker → Main messages
export type EnrichWorkerResponse =
  | { type: "ready" }
  | { type: "progress"; phase: IndexPhase; message: string; detail: ProgressDetail }
  | { type: "stage-complete"; phase: IndexPhase; message: string }
  | { type: "batch"; nodes: GraphNode[]; relationships: GraphRelationship[] }
  | { type: "done"; enrichedCount: number }
  | { type: "error"; message: string };
