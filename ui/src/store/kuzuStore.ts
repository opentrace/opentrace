/**
 * Main-thread proxy for the KuzuDB Web Worker.
 *
 * Each method posts a message and returns a Promise that resolves when
 * the worker responds with the matching request ID.
 */

import type { KuzuRequest, KuzuResponse, NodeResult, TraverseResult } from "./kuzuProtocol";
import type { ImportBatchRequest, ImportBatchResponse, NodeSourceResponse } from "./types";
import type { GraphData, GraphStats } from "../types/graph";
import type { GraphStore, SourceFile } from "./types";
import type { Embedder } from "../runner/browser/enricher/embedder/types";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class KuzuGraphStore implements GraphStore {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private ready: Promise<void>;
  private embedder: Embedder | null = null;
  private sourceCache = new Map<string, { content: string; path: string }>();

  constructor() {
    this.worker = new Worker(
      new URL("./kuzuWorker.ts", import.meta.url),
      { type: "module" },
    );

    this.worker.onmessage = (e: MessageEvent<KuzuResponse>) => {
      const msg = e.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);

      if (msg.kind === "error") {
        p.reject(new Error(msg.message));
      } else {
        p.resolve(msg);
      }
    };

    this.worker.onerror = (e) => {
      for (const [id, p] of this.pending) {
        p.reject(new Error(`Worker error: ${e.message}`));
        this.pending.delete(id);
      }
    };

    // Auto-initialize on construction
    this.ready = this.send({ kind: "init", id: 0 }).then(() => {});
  }

  private send(msg: KuzuRequest): Promise<KuzuResponse> {
    return new Promise((resolve, reject) => {
      this.pending.set(msg.id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage(msg);
    });
  }

  private async rpc(msg: KuzuRequest): Promise<KuzuResponse> {
    await this.ready;
    return this.send(msg);
  }

  /** Set an embedder for generating query embeddings during search. */
  setEmbedder(embedder: Embedder): void {
    this.embedder = embedder;
  }

  async fetchGraph(query?: string, hops?: number): Promise<GraphData> {
    let queryEmbedding: number[] | undefined;
    if (query && this.embedder) {
      try {
        const embeddings = await this.embedder.embed([query]);
        if (embeddings.length > 0 && embeddings[0].length > 0) {
          queryEmbedding = embeddings[0];
        }
      } catch {
        // Embedding failure is non-fatal — proceed with text-only search.
      }
    }
    const resp = await this.rpc({ kind: "fetchGraph", id: this.nextId++, query, hops, queryEmbedding });
    return (resp as Extract<KuzuResponse, { kind: "fetchGraph" }>).data;
  }

  async fetchStats(): Promise<GraphStats> {
    const resp = await this.rpc({ kind: "fetchStats", id: this.nextId++ });
    return (resp as Extract<KuzuResponse, { kind: "fetchStats" }>).data;
  }

  async clearGraph(): Promise<void> {
    await this.rpc({ kind: "clearGraph", id: this.nextId++ });
    this.sourceCache.clear();
  }

  async importBatch(batch: ImportBatchRequest): Promise<ImportBatchResponse> {
    const resp = await this.rpc({ kind: "importBatch", id: this.nextId++, batch });
    return (resp as Extract<KuzuResponse, { kind: "importBatch" }>).data;
  }

  storeSource(files: SourceFile[]): void {
    for (const f of files) {
      this.sourceCache.set(f.id, { content: f.content, path: f.path });
    }
  }

  async fetchSource(nodeId: string, startLine?: number, endLine?: number): Promise<NodeSourceResponse | null> {
    // Strip symbol suffix to get the file ID: "owner/repo/path.py::Class::method" → "owner/repo/path.py"
    const fileId = nodeId.includes("::") ? nodeId.slice(0, nodeId.indexOf("::")) : nodeId;
    const entry = this.sourceCache.get(fileId);
    if (!entry) return null;

    const allLines = entry.content.split("\n");
    const totalLines = allLines.length;

    if (startLine != null && endLine != null) {
      const sliced = allLines.slice(startLine - 1, endLine);
      return {
        content: sliced.join("\n"),
        path: entry.path,
        start_line: startLine,
        end_line: endLine,
        line_count: totalLines,
      };
    }

    return {
      content: entry.content,
      path: entry.path,
      line_count: totalLines,
    };
  }

  // ---- Chat tool methods (browser-only mode) ----

  async searchNodes(queryStr: string, limit?: number, nodeTypes?: string[]): Promise<NodeResult[]> {
    let queryEmbedding: number[] | undefined;
    if (this.embedder) {
      try {
        const embeddings = await this.embedder.embed([queryStr]);
        if (embeddings.length > 0 && embeddings[0].length > 0) {
          queryEmbedding = embeddings[0];
        }
      } catch {
        // Embedding failure is non-fatal — proceed with text-only search.
      }
    }
    const resp = await this.rpc({
      kind: "searchNodes",
      id: this.nextId++,
      query: queryStr,
      limit,
      nodeTypes,
      queryEmbedding,
    });
    return (resp as Extract<KuzuResponse, { kind: "searchNodes" }>).data;
  }

  async listNodes(type: string, limit?: number, filters?: Record<string, string>): Promise<NodeResult[]> {
    const resp = await this.rpc({
      kind: "listNodes",
      id: this.nextId++,
      type,
      limit,
      filters,
    });
    return (resp as Extract<KuzuResponse, { kind: "listNodes" }>).data;
  }

  async getNode(nodeId: string): Promise<NodeResult | null> {
    const resp = await this.rpc({
      kind: "getNode",
      id: this.nextId++,
      nodeId,
    });
    return (resp as Extract<KuzuResponse, { kind: "getNode" }>).data;
  }

  async traverse(
    nodeId: string,
    direction?: "outgoing" | "incoming" | "both",
    maxDepth?: number,
    relType?: string,
  ): Promise<TraverseResult[]> {
    const resp = await this.rpc({
      kind: "traverse",
      id: this.nextId++,
      nodeId,
      direction,
      maxDepth,
      relType,
    });
    return (resp as Extract<KuzuResponse, { kind: "traverse" }>).data;
  }
}
