import type { GraphNode, GraphLink } from "../types/graph";

export function buildGraphContext(nodes: GraphNode[], links: GraphLink[]): string {
  // Node type distribution
  const typeCounts: Record<string, number> = {};
  for (const n of nodes) {
    typeCounts[n.type] = (typeCounts[n.type] ?? 0) + 1;
  }
  const typeLines = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `  ${t}: ${c}`)
    .join("\n");

  // Relationship type distribution
  const relCounts: Record<string, number> = {};
  for (const l of links) {
    const label = l.label || "RELATES";
    relCounts[label] = (relCounts[label] ?? 0) + 1;
  }
  const relLines = Object.entries(relCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `  ${t}: ${c}`)
    .join("\n");

  // Sample nodes spread across types (up to 30 total)
  const MAX_SAMPLE = 30;
  const types = Object.keys(typeCounts);
  const perType = Math.max(1, Math.floor(MAX_SAMPLE / (types.length || 1)));
  const sampleNodes: string[] = [];
  for (const type of types) {
    const ofType = nodes.filter((n) => n.type === type);
    for (const n of ofType.slice(0, perType)) {
      sampleNodes.push(`  - ${n.name ?? n.id} (${n.type})`);
    }
  }

  // Sample relationships (up to 20)
  const sampleLinks = links.slice(0, 20).map((l) => {
    const src = typeof l.source === "object" ? (l.source as GraphNode).name ?? (l.source as GraphNode).id : l.source;
    const tgt = typeof l.target === "object" ? (l.target as GraphNode).name ?? (l.target as GraphNode).id : l.target;
    return `  - ${src} -[${l.label || "RELATES"}]-> ${tgt}`;
  });

  return `You are an expert assistant for OpenTrace, a system architecture exploration tool.
The user is viewing a graph of their system with ${nodes.length} nodes and ${links.length} relationships.

Node types:
${typeLines}

Relationship types:
${relLines}

Sample nodes:
${sampleNodes.join("\n")}

Sample relationships:
${sampleLinks.join("\n")}

You have tools to search the graph, list nodes by type, get node details, and traverse connections.
Use them when the user asks questions requiring specific lookups beyond the snapshot above.
Answer questions about this system's architecture, dependencies, and structure.
Be concise and specific, referencing actual node names and types from the graph.`;
}
