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
 * In-memory GraphStore implementation.
 *
 * Drop-in replacement for KuzuGraphStore that keeps everything in Maps.
 * No WASM, no workers, no COOP/COEP headers required.
 */

import type { GraphData, GraphStats } from '../types/graph';
import type {
  GraphStore,
  ImportBatchRequest,
  ImportBatchResponse,
  NodeResult,
  NodeSourceResponse,
  SourceFile,
  TraverseResult,
} from './types';

interface StoredNode {
  id: string;
  type: string;
  name: string;
  properties: Record<string, unknown>;
}

interface StoredRel {
  id: string;
  type: string;
  source_id: string;
  target_id: string;
  properties: Record<string, unknown>;
}

export class InMemoryGraphStore implements GraphStore {
  private nodes = new Map<string, StoredNode>();
  private rels = new Map<string, StoredRel>();
  private sourceCache = new Map<
    string,
    { content: string; path: string; binary?: boolean }
  >();

  async importBatch(batch: ImportBatchRequest): Promise<ImportBatchResponse> {
    let nodesCreated = 0;
    let relsCreated = 0;

    for (const n of batch.nodes) {
      const existing = this.nodes.get(n.id);
      if (existing) {
        // Merge properties into existing node (e.g. summary update)
        existing.properties = {
          ...existing.properties,
          ...(n.properties ?? {}),
        };
      } else {
        nodesCreated++;
        this.nodes.set(n.id, {
          id: n.id,
          type: n.type,
          name: n.name,
          properties: n.properties ?? {},
        });
      }
    }

    for (const r of batch.relationships) {
      if (!this.rels.has(r.id)) relsCreated++;
      this.rels.set(r.id, {
        id: r.id,
        type: r.type,
        source_id: r.source_id,
        target_id: r.target_id,
        properties: r.properties ?? {},
      });
    }

    return { nodes_created: nodesCreated, relationships_created: relsCreated };
  }

  async flush(): Promise<void> {
    // No-op — writes are immediate.
  }

  storeSource(files: SourceFile[]): void {
    for (const f of files) {
      this.sourceCache.set(f.id, {
        content: f.content,
        path: f.path,
        binary: f.binary,
      });
    }
  }

  async fetchSource(
    nodeId: string,
    startLine?: number,
    endLine?: number,
  ): Promise<NodeSourceResponse | null> {
    const fileId = nodeId.includes('::')
      ? nodeId.slice(0, nodeId.indexOf('::'))
      : nodeId;
    const entry = this.sourceCache.get(fileId);
    if (!entry) return null;

    if (entry.binary) {
      return {
        content: entry.content,
        path: entry.path,
        line_count: 0,
        binary: true,
      };
    }

    const allLines = entry.content.split('\n');
    if (startLine != null && endLine != null) {
      const sliced = allLines.slice(startLine - 1, endLine);
      return {
        content: sliced.join('\n'),
        path: entry.path,
        start_line: startLine,
        end_line: endLine,
        line_count: allLines.length,
      };
    }

    return {
      content: entry.content,
      path: entry.path,
      line_count: allLines.length,
    };
  }

  async fetchGraph(query?: string): Promise<GraphData> {
    const matchingNodes = query
      ? [...this.nodes.values()].filter(
          (n) =>
            n.name.toLowerCase().includes(query.toLowerCase()) ||
            n.id.toLowerCase().includes(query.toLowerCase()),
        )
      : [...this.nodes.values()];

    const nodeIds = new Set(matchingNodes.map((n) => n.id));
    const links = [...this.rels.values()]
      .filter((r) => nodeIds.has(r.source_id) && nodeIds.has(r.target_id))
      .map((r) => ({
        source: r.source_id,
        target: r.target_id,
        label: r.type,
        properties: r.properties,
      }));

    return {
      nodes: matchingNodes.map((n) => ({
        id: n.id,
        name: n.name,
        type: n.type,
        properties: n.properties,
      })),
      links,
    };
  }

  async fetchStats(): Promise<GraphStats> {
    const byType: Record<string, number> = {};
    for (const n of this.nodes.values()) {
      byType[n.type] = (byType[n.type] ?? 0) + 1;
    }
    return {
      total_nodes: this.nodes.size,
      total_edges: this.rels.size,
      nodes_by_type: byType,
    };
  }

  async clearGraph(): Promise<void> {
    this.nodes.clear();
    this.rels.clear();
    this.sourceCache.clear();
  }

  async searchNodes(
    query: string,
    limit = 50,
    nodeTypes?: string[],
  ): Promise<NodeResult[]> {
    const q = query.toLowerCase();
    const results: NodeResult[] = [];

    for (const n of this.nodes.values()) {
      if (nodeTypes && !nodeTypes.includes(n.type)) continue;
      if (n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) {
        results.push({
          id: n.id,
          type: n.type,
          name: n.name,
          properties: n.properties,
        });
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  async listNodes(
    type: string,
    limit = 100,
    filters?: Record<string, string>,
  ): Promise<NodeResult[]> {
    const results: NodeResult[] = [];

    for (const n of this.nodes.values()) {
      if (n.type !== type) continue;
      if (filters) {
        let match = true;
        for (const [k, v] of Object.entries(filters)) {
          if (String(n.properties[k] ?? '') !== v) {
            match = false;
            break;
          }
        }
        if (!match) continue;
      }
      results.push({
        id: n.id,
        type: n.type,
        name: n.name,
        properties: n.properties,
      });
      if (results.length >= limit) break;
    }

    return results;
  }

  async getNode(nodeId: string): Promise<NodeResult | null> {
    const n = this.nodes.get(nodeId);
    if (!n) return null;
    return { id: n.id, type: n.type, name: n.name, properties: n.properties };
  }

  async traverse(
    nodeId: string,
    direction: 'outgoing' | 'incoming' | 'both' = 'outgoing',
    maxDepth = 1,
    relType?: string,
  ): Promise<TraverseResult[]> {
    const results: TraverseResult[] = [];
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [
      { id: nodeId, depth: 0 },
    ];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;
      if (visited.has(id)) continue;
      visited.add(id);

      for (const rel of this.rels.values()) {
        if (relType && rel.type !== relType) continue;

        let neighborId: string | null = null;
        if (
          (direction === 'outgoing' || direction === 'both') &&
          rel.source_id === id
        ) {
          neighborId = rel.target_id;
        }
        if (
          (direction === 'incoming' || direction === 'both') &&
          rel.target_id === id
        ) {
          neighborId = rel.source_id;
        }
        if (!neighborId || visited.has(neighborId)) continue;

        const neighbor = this.nodes.get(neighborId);
        if (!neighbor) continue;

        results.push({
          node: {
            id: neighbor.id,
            type: neighbor.type,
            name: neighbor.name,
            properties: neighbor.properties,
          },
          relationship: {
            id: rel.id,
            type: rel.type,
            source_id: rel.source_id,
            target_id: rel.target_id,
            properties: rel.properties,
          },
          depth: depth + 1,
        });

        queue.push({ id: neighborId, depth: depth + 1 });
      }
    }

    return results;
  }
}
