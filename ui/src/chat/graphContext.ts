import type { GraphNode, GraphLink } from '../types/graph';

export function buildGraphContext(
  nodes: GraphNode[],
  links: GraphLink[],
): string {
  // Node type distribution
  const typeCounts: Record<string, number> = {};
  for (const n of nodes) {
    typeCounts[n.type] = (typeCounts[n.type] ?? 0) + 1;
  }
  const typeLines = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `  ${t}: ${c}`)
    .join('\n');

  // Relationship type distribution
  const relCounts: Record<string, number> = {};
  for (const l of links) {
    const label = l.label || 'RELATES';
    relCounts[label] = (relCounts[label] ?? 0) + 1;
  }
  const relLines = Object.entries(relCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `  ${t}: ${c}`)
    .join('\n');

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
    const src =
      typeof l.source === 'object'
        ? ((l.source as GraphNode).name ?? (l.source as GraphNode).id)
        : l.source;
    const tgt =
      typeof l.target === 'object'
        ? ((l.target as GraphNode).name ?? (l.target as GraphNode).id)
        : l.target;
    return `  - ${src} -[${l.label || 'RELATES'}]-> ${tgt}`;
  });

  return `You are an expert assistant for OpenTrace, a system architecture exploration tool.
The user is viewing a graph of their system with ${nodes.length} nodes and ${links.length} relationships.

Node types:
${typeLines}

Relationship types:
${relLines}

Sample nodes:
${sampleNodes.join('\n')}

Sample relationships:
${sampleLinks.join('\n')}

You have tools to search the graph, list nodes by type, get node details, traverse connections, and load source code.
Use them when the user asks questions requiring specific lookups beyond the snapshot above.
Use load_source to show actual code when the user asks to see implementation details — pass a File or symbol node ID.
Answer questions about this system's architecture, dependencies, and structure.
Be concise and specific, referencing actual node names and types from the graph.

## Delegation

You also have two specialized sub-agents you can delegate to:

- **code_explorer** — For complex exploration that requires multiple lookups. Use it for questions like "explain the structure of ServiceX", "how is authentication implemented?", or "walk me through the payment flow". The sub-agent will autonomously search, inspect, and traverse the graph to produce a synthesized answer.
- **dependency_analyzer** — For dependency mapping and impact analysis. Use it for questions like "what depends on ServiceX?", "what is the blast radius of changing DatabaseY?", or "show me the upstream consumers of this endpoint".

**When to delegate vs use tools directly:**
- Simple lookups (list all services, get a specific node, search by name) → use the raw tools directly
- Multi-step exploration or analysis requiring several tool calls → delegate to a sub-agent`;
}
