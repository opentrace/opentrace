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

import type { Parser, Node as SyntaxNode } from 'web-tree-sitter';
import type {
  Registries,
  CallInfo,
} from '../runner/browser/parser/callResolver';

// --- Pipeline infrastructure ---

export interface PipelineContext {
  readonly cancelled: boolean;
}

// --- Pipeline events (mirrors proto JobEvent / JobEventKind / JobPhase) ---

export type PipelineEventKind =
  | 'stage_start'
  | 'stage_progress'
  | 'stage_stop'
  | 'done'
  | 'error';

export type PipelinePhase =
  | 'scanning'
  | 'processing'
  | 'resolving'
  | 'submitting';

export interface ProgressDetail {
  current: number;
  total: number;
  fileName?: string;
  nodesCreated?: number;
  relationshipsCreated?: number;
}

export interface PipelineResult {
  nodesCreated: number;
  relationshipsCreated: number;
  filesProcessed: number;
  classesExtracted: number;
  functionsExtracted: number;
}

export interface PipelineEvent {
  kind: PipelineEventKind;
  phase: PipelinePhase;
  message: string;
  detail?: ProgressDetail;
  result?: PipelineResult;
  errors?: string[];
  nodes?: GraphNode[];
  relationships?: GraphRelationship[];
}

// --- Repo input ---

export interface RepoFile {
  path: string;
  content: string;
}

export interface RepoTree {
  owner: string;
  repo: string;
  ref: string;
  url?: string;
  provider?: string;
  files: RepoFile[];
}

// --- Graph output ---

export interface GraphNode {
  id: string;
  type: string;
  name: string;
  properties?: Record<string, unknown>;
}

export interface GraphRelationship {
  id: string;
  type: string;
  source_id: string;
  target_id: string;
  properties?: Record<string, unknown>;
}

// --- Extraction ---

export interface CallRef {
  name: string;
  receiver: string | null;
  kind: 'bare' | 'attribute';
}

export interface CodeSymbol {
  name: string;
  kind: 'class' | 'function';
  startLine: number;
  endLine: number;
  signature: string | null;
  children: CodeSymbol[];
  calls: CallRef[];
  receiverVar: string | null;
  receiverType: string | null;
  paramTypes: Record<string, string> | null;
  superclasses?: string[];
  interfaces?: string[];
  subtype?: string;
  docs?: string;
}

export interface ExtractionResult {
  symbols: CodeSymbol[];
  language: string;
  rootNode: SyntaxNode | null;
}

// --- Stage boundaries ---

export interface LoadingInput {
  repo: RepoTree;
}

export interface ScanResult {
  repo: RepoTree;
  repoId: string;
  repoNode: GraphNode;
  dirNodes: Map<string, GraphNode>;
  fileNodes: GraphNode[];
  structureRels: GraphRelationship[];
  parseableFiles: RepoFile[];
  packageNodes: Map<string, GraphNode>;
  dependencyRels: GraphRelationship[];
  goModulePath?: string;
  knownPaths: Set<string>;
  pathToFileId: Map<string, string>;
}

export interface ProcessingOutput {
  scanResult: ScanResult;
  registries: Registries;
  allCallInfo: CallInfo[];
  packageNodes: Map<string, GraphNode>;
  stats: PipelineResult;
}

export interface ParsingFileResult {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  classesExtracted: number;
  functionsExtracted: number;
  error?: string;
}

export type ParserMap = Map<string, Parser>;

// --- Store interface ---

export interface Store {
  saveNode(node: GraphNode): void;
  saveRelationship(rel: GraphRelationship): void;
}
