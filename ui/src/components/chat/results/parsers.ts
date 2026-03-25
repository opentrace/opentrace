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
 * Lightweight parsers for OpenTrace API tool results.
 * Each parser attempts to extract typed data from the raw JSON string
 * returned by the tool. Returns null on any failure — the caller
 * falls back to raw JSON display.
 */

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

export interface TraverseEntry {
  node: NodeResult;
  relationship: TraverseRelationship;
  depth: number;
}

/** search_graph → { results: Node[], count, query_info } */
export function parseSearchResult(raw: string): NodeResult[] | null {
  try {
    const data = JSON.parse(raw);
    const arr = data?.results ?? (Array.isArray(data) ? data : null);
    if (!Array.isArray(arr)) return null;
    return arr.filter((n: unknown) => isNode(n)) as NodeResult[];
  } catch {
    return null;
  }
}

/** list_nodes → { nodes: Node[], count, query_info } */
export function parseListNodesResult(raw: string): NodeResult[] | null {
  try {
    const data = JSON.parse(raw);
    const arr = data?.nodes ?? (Array.isArray(data) ? data : null);
    if (!Array.isArray(arr)) return null;
    return arr.filter((n: unknown) => isNode(n)) as NodeResult[];
  } catch {
    return null;
  }
}

/** get_node → Node directly */
export function parseGetNodeResult(raw: string): NodeResult | null {
  try {
    const data = JSON.parse(raw);
    return isNode(data) ? (data as NodeResult) : null;
  } catch {
    return null;
  }
}

/** traverse_graph → { results: TraverseEntry[], count, ... } */
export function parseTraverseResult(raw: string): TraverseEntry[] | null {
  try {
    const data = JSON.parse(raw);
    const arr = data?.results ?? (Array.isArray(data) ? data : null);
    if (!Array.isArray(arr)) return null;
    return arr.filter(
      (e: unknown) =>
        typeof e === 'object' &&
        e !== null &&
        'node' in e &&
        isNode((e as Record<string, unknown>).node),
    ) as TraverseEntry[];
  } catch {
    return null;
  }
}

/**
 * Extract node IDs from a tool result (or args) based on the tool name.
 * Returns an array of node IDs found, or empty array on failure.
 */
export function extractNodeIds(
  toolName: string,
  result: string,
  args?: string,
): string[] {
  switch (toolName) {
    case 'search_graph': {
      const nodes = parseSearchResult(result);
      return nodes ? nodes.map((n) => n.id) : [];
    }
    case 'list_nodes': {
      const nodes = parseListNodesResult(result);
      return nodes ? nodes.map((n) => n.id) : [];
    }
    case 'get_node': {
      const node = parseGetNodeResult(result);
      return node ? [node.id] : [];
    }
    case 'traverse_graph': {
      const entries = parseTraverseResult(result);
      return entries ? entries.map((e) => e.node.id) : [];
    }
    case 'load_source': {
      // Node ID is in the tool arguments, not the result
      if (!args) return [];
      try {
        const parsed = JSON.parse(args);
        return typeof parsed.nodeId === 'string' ? [parsed.nodeId] : [];
      } catch {
        return [];
      }
    }
    default:
      return [];
  }
}

function isNode(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.type === 'string' &&
    typeof o.name === 'string'
  );
}
