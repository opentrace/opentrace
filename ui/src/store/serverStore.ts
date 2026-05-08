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
 * Server-backed GraphStore implementation.
 *
 * Delegates all read queries to the `opentrace serve` REST API.
 * Write methods (importBatch, storeSource, clearGraph) are no-ops —
 * the server owns the data and the UI is a pure read-through client.
 */

import type { GraphData, GraphStats } from '@opentrace/components/utils';
import type {
  CountByResult,
  FindOrphansResult,
  FindPathResult,
  FindViaResult,
  GraphStore,
  GrepResult,
  OverviewResult,
  ProvenanceResult,
  SearchResult,
  ImportBatchRequest,
  ImportBatchResponse,
  IndexMetadata,
  NodeResult,
  NodeSourceResponse,
  SourceFile,
  TraverseOptions,
  TraverseResult,
} from './types';

export class ServerGraphStore implements GraphStore {
  private readonly baseUrl: string;
  private _hasData = false;

  constructor(baseUrl: string) {
    // Strip trailing slash for consistent URL building
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  // ---- Helpers --------------------------------------------------------

  private async get<T>(
    path: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const base = this.baseUrl.endsWith('/') ? this.baseUrl : this.baseUrl + '/';
    const url = new URL(path.startsWith('/') ? path.slice(1) : path, base);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, v);
      }
    }
    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Server error ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const base = this.baseUrl.endsWith('/') ? this.baseUrl : this.baseUrl + '/';
    const url = new URL(path.startsWith('/') ? path.slice(1) : path, base);
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Server error ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  // ---- GraphStore interface -------------------------------------------

  hasData(): boolean {
    return this._hasData;
  }

  async ensureReady(): Promise<void> {
    // Probe the health endpoint to confirm the server is reachable,
    // and check stats to set the hasData flag.
    await this.get<{ status: string }>('/api/health');
    const stats = await this.get<GraphStats>('/api/stats');
    this._hasData = stats.total_nodes > 0;
  }

  async fetchGraph(query?: string, hops?: number): Promise<GraphData> {
    const params: Record<string, string> = {};
    if (query) params.query = query;
    if (hops != null) params.hops = String(hops);

    const raw = await this.get<{
      nodes: NodeResult[];
      links: {
        source: string;
        target: string;
        type: string;
        properties?: Record<string, unknown>;
      }[];
    }>('/api/graph', params);

    this._hasData = this._hasData || raw.nodes.length > 0;

    return {
      nodes: raw.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        type: n.type,
        properties: n.properties,
      })),
      // Server returns `type` on links; UI GraphLink expects `label`
      links: raw.links.map((l) => ({
        source: l.source,
        target: l.target,
        label: l.type,
        properties: l.properties,
      })),
    };
  }

  async fetchStats(): Promise<GraphStats> {
    const stats = await this.get<GraphStats>('/api/stats');
    this._hasData = stats.total_nodes > 0;
    return stats;
  }

  async fetchMetadata(): Promise<IndexMetadata[]> {
    try {
      return await this.get<IndexMetadata[]>('/api/metadata');
    } catch {
      return [];
    }
  }

  async searchNodes(
    query: string,
    limit = 50,
    nodeTypes?: string[],
  ): Promise<NodeResult[]> {
    const params: Record<string, string> = {
      query,
      limit: String(limit),
    };
    if (nodeTypes?.length) {
      params.nodeTypes = nodeTypes.join(',');
    }
    return this.get<NodeResult[]>('/api/nodes/search', params);
  }

  async listNodes(
    type: string,
    limit = 50,
    filters?: Record<string, string>,
  ): Promise<NodeResult[]> {
    const params: Record<string, string> = {
      type,
      limit: String(limit),
    };
    if (filters) {
      params.filters = JSON.stringify(filters);
    }
    return this.get<NodeResult[]>('/api/nodes/list', params);
  }

  async getNode(nodeId: string): Promise<NodeResult | null> {
    try {
      return await this.get<NodeResult>(
        `/api/nodes/${encodeURIComponent(nodeId)}`,
      );
    } catch (e) {
      // 404 → null
      if (e instanceof Error && e.message.includes('404')) return null;
      throw e;
    }
  }

  async traverse(
    nodeId: string,
    direction: 'outgoing' | 'incoming' | 'both' = 'outgoing',
    maxDepth = 3,
    relType?: string,
    options?: TraverseOptions,
  ): Promise<TraverseResult[]> {
    return this.post<TraverseResult[]>('/api/traverse', {
      nodeId,
      direction,
      maxDepth,
      relType: relType ?? null,
      relTypes: options?.relTypes ?? null,
      vaultScope: options?.vaultScope ?? null,
      confidenceThreshold: options?.confidenceThreshold ?? null,
    });
  }

  async fetchSource(
    nodeId: string,
    startLine?: number,
    endLine?: number,
  ): Promise<NodeSourceResponse | null> {
    const params: Record<string, string> = {};
    if (startLine != null) params.startLine = String(startLine);
    if (endLine != null) params.endLine = String(endLine);
    try {
      return await this.get<NodeSourceResponse>(
        `/api/source/${encodeURIComponent(nodeId)}`,
        params,
      );
    } catch (e) {
      if (e instanceof Error && e.message.includes('404')) return null;
      throw e;
    }
  }

  // ---- OT-1732 retrieval primitives -----------------------------------

  async findPath(
    startId: string,
    endId: string,
    maxHops?: number,
    edgeTypes?: string[],
  ): Promise<FindPathResult> {
    return this.post<FindPathResult>('/api/retrieval/find_path', {
      startId,
      endId,
      maxHops: maxHops ?? 5,
      edgeTypes: edgeTypes ?? null,
    });
  }

  async findOrphans(
    nodeType: string,
    edgeType: string,
    direction?: 'incoming' | 'outgoing' | 'both',
    limit?: number,
  ): Promise<FindOrphansResult> {
    return this.post<FindOrphansResult>('/api/retrieval/find_orphans', {
      nodeType,
      edgeType,
      direction: direction ?? 'incoming',
      limit: limit ?? 1000,
    });
  }

  async findViaRelationshipToType(
    startType: string,
    edgeType: string,
    targetType: string,
    limit?: number,
  ): Promise<FindViaResult> {
    return this.post<FindViaResult>(
      '/api/retrieval/find_via_relationship_to_type',
      {
        startType,
        edgeType,
        targetType,
        limit: limit ?? 100,
      },
    );
  }

  async overview(options?: {
    topN?: number;
    vaultScope?: string;
  }): Promise<OverviewResult> {
    return this.post<OverviewResult>('/api/retrieval/overview', {
      topN: options?.topN ?? 5,
      vaultScope: options?.vaultScope ?? null,
    });
  }

  async provenance(nodeId: string): Promise<ProvenanceResult> {
    return this.post<ProvenanceResult>('/api/retrieval/provenance', { nodeId });
  }

  async grep(
    pattern: string,
    scopeId: string,
    options?: {
      fileFilter?: string;
      caseSensitive?: boolean;
      maxResults?: number;
    },
  ): Promise<GrepResult> {
    return this.post<GrepResult>('/api/retrieval/grep', {
      pattern,
      scopeId,
      fileFilter: options?.fileFilter ?? null,
      caseSensitive: options?.caseSensitive ?? false,
      maxResults: options?.maxResults ?? 200,
    });
  }

  async search(
    query: string,
    options?: { limit?: number; nodeTypes?: string[]; vaultScope?: string },
  ): Promise<SearchResult> {
    return this.post<SearchResult>('/api/retrieval/search', {
      query,
      limit: options?.limit ?? 25,
      nodeTypes: options?.nodeTypes ?? null,
      vaultScope: options?.vaultScope ?? null,
    });
  }

  async countBy(
    nodeType: string,
    options?: { parentId?: string; parentEdge?: string; maxHops?: number },
  ): Promise<CountByResult> {
    return this.post<CountByResult>('/api/retrieval/count_by', {
      nodeType,
      parentId: options?.parentId ?? null,
      parentEdge: options?.parentEdge ?? 'CONTAINS',
      maxHops: options?.maxHops ?? 3,
    });
  }

  // ---- Write methods (no-ops — server owns the data) ------------------

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async importBatch(_batch: ImportBatchRequest): Promise<ImportBatchResponse> {
    // Server mode: data lives on the server, not imported from the browser.
    return { nodes_created: 0, relationships_created: 0 };
  }

  async flush(): Promise<void> {
    // No-op — nothing buffered.
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  storeSource(_files: SourceFile[]): void {
    // No-op — source lives on the server.
  }

  async clearGraph(): Promise<void> {
    // No-op — the server manages the database lifecycle.
  }
}
