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
