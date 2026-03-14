import type { GraphNode, GraphRelationship, Store } from '../types';

export class MemoryStore implements Store {
  readonly nodes = new Map<string, GraphNode>();
  readonly relationships = new Map<string, GraphRelationship>();

  saveNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
  }

  saveRelationship(rel: GraphRelationship): void {
    this.relationships.set(rel.id, rel);
  }
}
