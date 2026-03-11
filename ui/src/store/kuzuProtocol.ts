import type { GraphData, GraphStats } from "../types/graph";
import type { ImportBatchRequest, ImportBatchResponse } from "./types";

// ---- Shared result types (used by worker responses and chat tool parsers) ----

export interface NodeResult {
  id: string;
  type: string;
  name: string;
  properties?: Record<string, unknown>;
}

export interface TraverseRelationship {
  id: string;
  type: string;
  source_id: string;
  target_id: string;
}

export interface TraverseResult {
  node: NodeResult;
  relationship: TraverseRelationship;
  depth: number;
}

// ---- Main → Worker requests ----

export type KuzuRequest =
  | { kind: "init"; id: number }
  | { kind: "fetchGraph"; id: number; query?: string; hops?: number; queryEmbedding?: number[] }
  | { kind: "fetchStats"; id: number }
  | { kind: "clearGraph"; id: number }
  | { kind: "importBatch"; id: number; batch: ImportBatchRequest }
  | { kind: "searchNodes"; id: number; query: string; limit?: number; nodeTypes?: string[]; queryEmbedding?: number[] }
  | { kind: "listNodes"; id: number; type: string; limit?: number; filters?: Record<string, string> }
  | { kind: "getNode"; id: number; nodeId: string }
  | { kind: "traverse"; id: number; nodeId: string; direction?: "outgoing" | "incoming" | "both"; maxDepth?: number; relType?: string };

// ---- Worker → Main responses ----

export type KuzuResponse =
  | { kind: "ready"; id: number }
  | { kind: "fetchGraph"; id: number; data: GraphData }
  | { kind: "fetchStats"; id: number; data: GraphStats }
  | { kind: "clearGraph"; id: number }
  | { kind: "importBatch"; id: number; data: ImportBatchResponse }
  | { kind: "searchNodes"; id: number; data: NodeResult[] }
  | { kind: "listNodes"; id: number; data: NodeResult[] }
  | { kind: "getNode"; id: number; data: NodeResult | null }
  | { kind: "traverse"; id: number; data: TraverseResult[] }
  | { kind: "error"; id: number; message: string };
