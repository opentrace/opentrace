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

function isNode(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.type === 'string' &&
    typeof o.name === 'string'
  );
}
