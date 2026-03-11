import type { GraphData, GraphStats } from "../types/graph";
import type { NodeResult, TraverseResult } from "./kuzuProtocol";

export type { NodeResult, TraverseResult } from "./kuzuProtocol";

export interface ImportBatchRequest {
  nodes: { id: string; type: string; name: string; properties?: Record<string, unknown>; embedding?: number[] }[];
  relationships: { id: string; type: string; source_id: string; target_id: string; properties?: Record<string, unknown> }[];
}

export interface ImportBatchResponse {
  nodes_created: number;
  relationships_created: number;
  errors?: string[];
}

export interface NodeSourceResponse {
  content: string;
  path: string;
  language?: string;
  start_line?: number;
  end_line?: number;
  line_count: number;
}

export interface SourceFile {
  id: string;
  path: string;
  content: string;
}

export interface GraphStore {
  fetchGraph(query?: string, hops?: number): Promise<GraphData>;
  fetchStats(): Promise<GraphStats>;
  clearGraph(): Promise<void>;
  importBatch(batch: ImportBatchRequest): Promise<ImportBatchResponse>;
  storeSource(files: SourceFile[]): void;
  fetchSource(nodeId: string, startLine?: number, endLine?: number): Promise<NodeSourceResponse | null>;

  // Query methods (used by chat tools)
  searchNodes(query: string, limit?: number, nodeTypes?: string[]): Promise<NodeResult[]>;
  listNodes(type: string, limit?: number, filters?: Record<string, string>): Promise<NodeResult[]>;
  getNode(nodeId: string): Promise<NodeResult | null>;
  traverse(nodeId: string, direction?: "outgoing" | "incoming" | "both", maxDepth?: number, relType?: string): Promise<TraverseResult[]>;
}
