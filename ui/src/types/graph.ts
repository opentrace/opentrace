export interface GraphNode {
  id: string;
  name: string;
  type: string;
  properties?: Record<string, unknown>;
}

export interface GraphLink {
  source: string;
  target: string;
  label: string;
  properties?: Record<string, unknown>;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface GraphStats {
  total_nodes: number;
  total_edges: number;
  nodes_by_type: Record<string, number>;
}

/** Replaces NodeObject<GraphNode> — no more mutable D3 refs */
export type SelectedNode = GraphNode;

/** Replaces LinkObject<GraphNode, GraphLink> — endpoints always strings */
export interface SelectedEdge {
  source: string;
  target: string;
  label: string;
  properties?: Record<string, unknown>;
  sourceNode?: GraphNode;
  targetNode?: GraphNode;
}
