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
  GraphStore,
  ImportBatchRequest,
  ImportBatchResponse,
  IndexMetadata,
  NodeResult,
  NodeSourceResponse,
  SourceFile,
  TraverseResult,
} from './types';

/** Shape returned by GET /api/index-progress/{jobId} (Fix #6). */
export interface IndexProgress {
  jobId: string;
  /** Coarse phase string; matches the agent's serve.py vocabulary —
   *  `queued | initializing | deleting | fetching | parsing | done | error`. */
  phase: string;
  /** Raw pipeline phase from the agent's PipelineEvent.Phase enum
   *  (`scanning | processing | resolving | submitting`). Used by the UI
   *  to choose a more granular stage when available, falling back to
   *  the coarse `phase` above. */
  phaseRaw?: string | null;
  message: string;
  done: boolean;
  error: string | null;
  /** Running per-stage counter (file index within the current stage). */
  currentItems?: number;
  /** Running per-stage total (e.g. total files in the stage). */
  totalItems?: number;
  /** File the agent is currently working on, when applicable. */
  currentFile?: string | null;
  /** Cumulative count of nodes that have been or will be created so
   *  far. Updated as pipeline stages emit their cumulative results. */
  nodesCreated?: number;
  /** Cumulative count of relationships in the same vein. */
  relationshipsCreated?: number;
  result: {
    elapsedSeconds: number;
    repoId: string;
    totalNodes: number;
    totalEdges: number;
  } | null;
  startedAt: number;
}

export class ServerGraphStore implements GraphStore {
  private readonly baseUrl: string;
  private _hasData = false;

  // Visualization caps threaded into /api/graph as ?maxNodes=&maxEdges=.
  // Defaults match LadybugStore and SettingsDrawer's DEFAULT_MAX_*. The
  // agent caps the response server-side (see serve.py:fetch_graph).
  private maxVisNodes = 50000;
  private maxVisEdges = 50000;

  constructor(baseUrl: string) {
    // Strip trailing slash for consistent URL building
    this.baseUrl = baseUrl.replace(/\/+$/, '');

    // Apply persisted visualization limits so the first fetch uses them
    // without waiting for the user to open Settings and click Update.
    // Mirrors LadybugStore's behavior in ensureReady().
    try {
      const savedNodes = localStorage.getItem('ot:maxVisNodes');
      const savedEdges = localStorage.getItem('ot:maxVisEdges');
      const n = savedNodes != null ? Number(savedNodes) : NaN;
      const e = savedEdges != null ? Number(savedEdges) : NaN;
      // Integers only — the /api/graph contract rejects non-integer caps,
      // so a persisted decimal would make every fetch 400.
      if (Number.isInteger(n) && n > 0) this.maxVisNodes = n;
      if (Number.isInteger(e) && e > 0) this.maxVisEdges = e;
    } catch {
      /* localStorage unavailable (SSR, restricted browser) — keep defaults */
    }
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

  /**
   * Update visualization node/edge caps. Stored locally and threaded into
   * subsequent `fetchGraph` calls as `?maxNodes=&maxEdges=` query params.
   * Persistence to localStorage is the caller's responsibility — see
   * SettingsDrawer's `applyLimits()`.
   */
  async setLimits(maxNodes: number, maxEdges: number): Promise<void> {
    // The /api/graph contract rejects non-integer caps — validate here so a
    // bad value fails loudly instead of 400-ing every subsequent fetch.
    if (!Number.isInteger(maxNodes) || maxNodes <= 0) {
      throw new Error('maxNodes must be a positive integer');
    }
    if (!Number.isInteger(maxEdges) || maxEdges <= 0) {
      throw new Error('maxEdges must be a positive integer');
    }
    this.maxVisNodes = maxNodes;
    this.maxVisEdges = maxEdges;
  }

  /**
   * Ask the agent to index a remote repository server-side. The agent
   * handles cloning/extracting; the browser does no tree-sitter work in
   * this path. Used by server-mode "Add Repo" (browserJobService routes
   * to this method instead of running the in-browser pipeline).
   *
   * Returns the job id; poll {@link getIndexProgress} until `done`.
   */
  async indexUrl(body: {
    repoUrl: string;
    repoId?: string;
    token?: string;
    ref?: string;
    zipball?: boolean;
    reindex?: boolean;
  }): Promise<{ jobId: string; status: string }> {
    return this.post<{ jobId: string; status: string }>('/api/index-url', body);
  }

  /** Read the current state of a server-side index job. The UI polls
   *  this every ~1.5s during a server-mode index (Fix #6). */
  async getIndexProgress(jobId: string): Promise<IndexProgress> {
    return this.get<IndexProgress>(
      `/api/index-progress/${encodeURIComponent(jobId)}`,
    );
  }

  /** Return the currently-running index job, or null. Used by the
   *  SPA on mount to resume polling after a page reload (Fix #14).
   *  Returns null if the agent doesn't implement the endpoint
   *  (older agents that pre-date Fix #14). */
  async getActiveIndexJob(): Promise<IndexProgress | null> {
    try {
      return await this.get<IndexProgress | null>('/api/index-active');
    } catch (err) {
      // 404 / 405 from an older agent: just behave as if there's no
      // active job. The user will only miss "resume polling on
      // reload" — everything else still works.
      if (err instanceof Error && /404|405/.test(err.message)) return null;
      throw err;
    }
  }

  async fetchGraph(query?: string, hops?: number): Promise<GraphData> {
    const params: Record<string, string> = {};
    if (query) params.query = query;
    if (hops != null) params.hops = String(hops);
    // Always thread the caps. Agent honors them in /api/graph; older
    // agents that don't recognize the params simply ignore them.
    params.maxNodes = String(this.maxVisNodes);
    params.maxEdges = String(this.maxVisEdges);

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
  ): Promise<TraverseResult[]> {
    return this.post<TraverseResult[]>('/api/traverse', {
      nodeId,
      direction,
      maxDepth,
      relType: relType ?? null,
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

  // ---- Write methods (no-ops — server owns the data) ------------------

  async importBatch(_batch: ImportBatchRequest): Promise<ImportBatchResponse> {
    // Server mode: data lives on the server, not imported from the browser.
    return { nodes_created: 0, relationships_created: 0 };
  }

  async flush(): Promise<void> {
    // No-op — nothing buffered.
  }

  storeSource(_files: SourceFile[]): void {
    // No-op — source lives on the server.
  }

  async clearGraph(): Promise<void> {
    // Fix #11: ask the agent to wipe its database. Previously this
    // was a no-op so the Settings "Clear Database" button looked
    // like it worked but the next `/api/graph` call still returned
    // every node. The agent endpoint refuses while an index job is
    // in flight; we surface that as a thrown error so the
    // SettingsDrawer's existing catch shows it inline.
    await this.post('/api/clear', {});
    this._hasData = false;
  }
}
