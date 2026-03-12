/**
 * Main-thread manager for browser-based code indexing.
 *
 * Orchestrates two Web Workers:
 * - Parse Worker: tree-sitter extraction, call resolution, graph batches
 * - Enrichment Worker: ML summarization + embedding (optional, parallel init)
 *
 * The manager buffers enrichment items between workers and handles
 * timing mismatches (parse typically finishes before enrichment worker is ready).
 */

import { loadEmbedderConfig } from '../../config/embedding';
import { loadSummarizerConfig } from '../../config/summarization';
import { loaderRegistry } from './loader/registry';
import type { LoaderInput } from './loader/loaderInterface';
import type { FetchProgress } from './loader/shared';
import type { GraphStore } from '../../store/types';
import type {
  EnrichItem,
  EnrichWorkerRequest,
  EnrichWorkerResponse,
  GraphBatch,
  IndexPhase,
  IndexSummary,
  ProgressDetail,
  RepoTree,
  WorkerRequest,
  WorkerResponse,
} from './types';

export interface IndexingCallbacks {
  onProgress: (
    phase: IndexPhase,
    message: string,
    detail: ProgressDetail,
  ) => void;
  onStageComplete: (phase: IndexPhase, message: string) => void;
  onDone: (summary: IndexSummary) => void;
  onError: (message: string) => void;
  onPersisted?: (nodesCreated: number, relationshipsCreated: number) => void;
}

export class IndexingManager {
  private parseWorker: Worker | null = null;
  private enrichWorker: Worker | null = null;
  private callbacks: IndexingCallbacks;
  private store: GraphStore;
  private abortController: AbortController | null = null;
  private totalNodesSubmitted = 0;
  private totalRelsSubmitted = 0;
  private pendingBatches: Promise<void>[] = [];

  // Two-worker completion tracking
  private parseDone = false;
  private enrichmentDone = false;
  private enrichmentEnabled = false;

  // Parse result stats for final summary
  private parseResult: { filesProcessed: number; errors: string[] } = {
    filesProcessed: 0,
    errors: [],
  };
  private startTime = 0;

  // Buffer for enrichment items (parse worker may finish before enrichment worker is ready)
  private enrichmentBuffer: EnrichItem[] = [];
  private enrichmentReady = false;

  // Pending repo for parse worker
  private _pendingRepo: RepoTree | null = null;
  private parseWorkerReady = false;
  private persistedSignaled = false;

  constructor(callbacks: IndexingCallbacks, store: GraphStore) {
    this.callbacks = callbacks;
    this.store = store;
  }

  /** Start browser-based indexing from a URL or local directory. */
  async start(input: LoaderInput) {
    this.abortController = new AbortController();
    this.startTime = Date.now();

    // Check if enrichment (embedding) is enabled — summaries are always instant via templates
    const embedderConfig = loadEmbedderConfig();
    this.enrichmentEnabled = embedderConfig.enabled;

    // If enrichment is disabled, mark it as done immediately
    if (!this.enrichmentEnabled) {
      this.enrichmentDone = true;
    }

    // 1. Create parse worker
    this.parseWorker = new Worker(
      new URL('./parser/worker.ts', import.meta.url),
      { type: 'module' },
    );
    this.parseWorker.onmessage = async (e: MessageEvent<WorkerResponse>) => {
      await this.handleParseWorkerMessage(e.data);
    };
    this.parseWorker.onerror = (e) => {
      this.terminateAll();
      this.callbacks.onError(`Parse worker error: ${e.message}`);
    };

    // 2. Create enrichment worker (if enabled) — init runs in parallel with parse worker + fetch
    if (this.enrichmentEnabled) {
      this.enrichWorker = new Worker(
        new URL('./enricher/enrichmentWorker.ts', import.meta.url),
        { type: 'module' },
      );
      this.enrichWorker.onmessage = async (
        e: MessageEvent<EnrichWorkerResponse>,
      ) => {
        await this.handleEnrichWorkerMessage(e.data);
      };
      this.enrichWorker.onerror = (e) => {
        // Enrichment failure is non-fatal — graph still works
        console.error('Enrichment worker error:', e.message);
        this.enrichmentDone = true;
        this.enrichWorker?.terminate();
        this.enrichWorker = null;
        this.checkAllDone();
      };

      // Init enrichment worker with embedder config (summaries are pre-computed by pipeline)
      this.postToEnrichWorker({
        type: 'init',
        embedderConfig: embedderConfig.enabled ? embedderConfig : undefined,
      });
    }

    // 3. Init parse worker (just tree-sitter, fast ~1s) with summarizer config
    const summarizerConfig = loadSummarizerConfig();
    this.callbacks.onProgress('initializing', 'Loading parsers...', {
      current: 0,
      total: 1,
    });
    this.postToParseWorker({ type: 'init', summarizerConfig });

    // 4. Fetch repo in parallel with worker init
    const fetchingMessage =
      input.kind === 'directory'
        ? 'Loading files...'
        : 'Fetching repository tree...';
    this.callbacks.onProgress('fetching', fetchingMessage, {
      current: 0,
      total: 1,
    });

    const progressCallback = (progress: FetchProgress) => {
      if (progress.phase === 'tree') {
        const treeMessage =
          input.kind === 'directory'
            ? 'Scanning directory...'
            : 'Downloading repository tree...';
        this.callbacks.onProgress('fetching', treeMessage, {
          current: progress.current,
          total: progress.total,
        });
      } else {
        this.callbacks.onProgress(
          'fetching',
          `Loading ${progress.fileName ?? 'files'}...`,
          {
            current: progress.current,
            total: progress.total,
            fileName: progress.fileName,
          },
        );
      }
    };

    let repo: RepoTree;
    try {
      repo = await this.fetchRepo(input, progressCallback);
    } catch (err) {
      if (this.abortController.signal.aborted) return;
      this.terminateAll();
      this.callbacks.onError(
        `Failed to fetch repo: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    this.callbacks.onProgress(
      'fetching',
      `Fetched ${repo.files.length} files`,
      {
        current: repo.files.length,
        total: repo.files.length,
      },
    );
    this.callbacks.onStageComplete(
      'fetching',
      `Fetched ${repo.files.length} files`,
    );

    // Cache file contents for source viewing (before worker consumes them)
    if (this.store) {
      const repoId = `${repo.owner}/${repo.repo}`;
      this.store.storeSource(
        repo.files.map((f) => ({
          id: `${repoId}/${f.path}`,
          path: f.path,
          content: f.content,
          binary: f.binary,
        })),
      );
    }

    // Send repo to parse worker if ready, otherwise buffer
    if (this.parseWorkerReady) {
      this.callbacks.onProgress('parsing', 'Starting extraction...', {
        current: 0,
        total: 1,
      });
      this.postToParseWorker({ type: 'index', repo });
    } else {
      this._pendingRepo = repo;
    }
  }

  // --- Parse Worker message handler ---

  private async handleParseWorkerMessage(msg: WorkerResponse) {
    switch (msg.type) {
      case 'ready':
        this.parseWorkerReady = true;
        this.callbacks.onStageComplete('initializing', 'Parsers loaded');
        if (this._pendingRepo) {
          this.callbacks.onProgress('parsing', 'Starting extraction...', {
            current: 0,
            total: 1,
          });
          this.postToParseWorker({ type: 'index', repo: this._pendingRepo });
          this._pendingRepo = null;
        }
        break;

      case 'progress':
        this.callbacks.onProgress(msg.phase, msg.message, msg.detail);
        break;

      case 'stage-complete':
        this.callbacks.onStageComplete(msg.phase, msg.message);
        // After resolving, all structural nodes/edges are submitted.
        // Flush pending batches and signal graph-ready so the UI can
        // minimize the modal while summarizing/embedding continue.
        if (msg.phase === 'resolving' && !this.persistedSignaled) {
          await Promise.all([...this.pendingBatches]);
          this.persistedSignaled = true;
          this.callbacks.onStageComplete(
            'submitting',
            `Submitted ${this.totalNodesSubmitted} nodes, ${this.totalRelsSubmitted} relationships`,
          );
          this.callbacks.onPersisted?.(
            this.totalNodesSubmitted,
            this.totalRelsSubmitted,
          );
        }
        break;

      case 'batch': {
        const p = this.submitBatch({
          nodes: msg.nodes,
          relationships: msg.relationships,
        });
        this.pendingBatches.push(p);
        p.then(() => {
          const idx = this.pendingBatches.indexOf(p);
          if (idx >= 0) this.pendingBatches.splice(idx, 1);
        });
        break;
      }

      case 'enrich-items':
        // Buffer items and flush to enrichment worker if it's ready
        this.enrichmentBuffer.push(...msg.items);
        this.flushEnrichmentBuffer();
        break;

      case 'done':
        // Store parse result for final summary
        this.parseResult = {
          filesProcessed: msg.filesProcessed,
          errors: msg.errors,
        };
        this.parseDone = true;
        this.parseWorker?.terminate();
        this.parseWorker = null;

        // Wait for remaining batches (summary updates from summarizing phase)
        await Promise.all([...this.pendingBatches]);

        // Signal persisted if not already done after resolving
        // (e.g. if resolving stage-complete was missed)
        if (!this.persistedSignaled) {
          this.persistedSignaled = true;
          this.callbacks.onStageComplete(
            'submitting',
            `Submitted ${this.totalNodesSubmitted} nodes, ${this.totalRelsSubmitted} relationships`,
          );
          this.callbacks.onPersisted?.(
            this.totalNodesSubmitted,
            this.totalRelsSubmitted,
          );
        }

        this.checkAllDone();
        break;

      case 'error':
        this.terminateAll();
        this.callbacks.onError(msg.message);
        break;
    }
  }

  // --- Enrichment Worker message handler ---

  private async handleEnrichWorkerMessage(msg: EnrichWorkerResponse) {
    switch (msg.type) {
      case 'ready':
        this.enrichmentReady = true;
        this.flushEnrichmentBuffer();
        break;

      case 'progress':
        this.callbacks.onProgress(msg.phase, msg.message, msg.detail);
        break;

      case 'stage-complete':
        this.callbacks.onStageComplete(msg.phase, msg.message);
        break;

      case 'batch': {
        const p = this.submitBatch({
          nodes: msg.nodes,
          relationships: msg.relationships,
        });
        this.pendingBatches.push(p);
        p.then(() => {
          const idx = this.pendingBatches.indexOf(p);
          if (idx >= 0) this.pendingBatches.splice(idx, 1);
        });
        break;
      }

      case 'done':
        await Promise.all(this.pendingBatches);
        this.enrichmentDone = true;
        this.enrichWorker?.terminate();
        this.enrichWorker = null;
        this.checkAllDone();
        break;

      case 'error':
        // Enrichment failure is non-fatal
        console.error('Enrichment error:', msg.message);
        this.enrichmentDone = true;
        this.enrichWorker?.terminate();
        this.enrichWorker = null;
        this.checkAllDone();
        break;
    }
  }

  // --- Buffer management ---

  private flushEnrichmentBuffer() {
    if (
      !this.enrichmentReady ||
      this.enrichmentBuffer.length === 0 ||
      !this.enrichWorker
    )
      return;

    this.postToEnrichWorker({ type: 'enrich', items: this.enrichmentBuffer });
    this.enrichmentBuffer = [];
  }

  // --- Completion tracking ---

  private checkAllDone() {
    if (!this.parseDone || !this.enrichmentDone) return;

    this.callbacks.onDone({
      filesProcessed: this.parseResult.filesProcessed,
      nodesCreated: this.totalNodesSubmitted,
      relationshipsCreated: this.totalRelsSubmitted,
      errors: this.parseResult.errors,
      durationMs: Date.now() - this.startTime,
    });
  }

  // --- Batch submission ---

  private async submitBatch(batch: GraphBatch) {
    if (batch.nodes.length === 0 && batch.relationships.length === 0) return;

    try {
      const result = await this.store.importBatch(batch);
      this.totalNodesSubmitted += result.nodes_created;
      this.totalRelsSubmitted += result.relationships_created;

      this.callbacks.onProgress('submitting', `Submitted batch`, {
        current: this.totalNodesSubmitted,
        total: this.totalNodesSubmitted,
        fileName: `${result.nodes_created} nodes, ${result.relationships_created} rels`,
        nodesCreated: this.totalNodesSubmitted,
        relationshipsCreated: this.totalRelsSubmitted,
      });
    } catch (err) {
      const nodeIds = batch.nodes.slice(0, 5).map((n) => `${n.type}:${n.id}`);
      const relIds = batch.relationships
        .slice(0, 5)
        .map((r) => `${r.type}:${r.source_id}->${r.target_id}`);
      console.error(
        `Failed to submit batch (${batch.nodes.length} nodes, ${batch.relationships.length} rels):`,
        err,
        '\n  sample nodes:',
        nodeIds,
        '\n  sample rels:',
        relIds,
      );
    }
  }

  // --- Repo fetching ---

  /** Find a matching loader from the registry and fetch. */
  private async fetchRepo(
    input: LoaderInput,
    onProgress: (progress: FetchProgress) => void,
  ): Promise<RepoTree> {
    const loader = loaderRegistry.find((l) => l.canHandle(input));
    if (!loader) {
      throw new Error(
        'No loader found. Provide a GitHub URL, GitLab URL, or local directory.',
      );
    }
    return loader.load(input, {
      signal: this.abortController!.signal,
      onProgress,
    });
  }

  // --- Worker communication ---

  private postToParseWorker(msg: WorkerRequest) {
    this.parseWorker?.postMessage(msg);
  }

  private postToEnrichWorker(msg: EnrichWorkerRequest) {
    this.enrichWorker?.postMessage(msg);
  }

  /** Cancel the indexing operation. */
  cancel() {
    this.abortController?.abort();
    this.postToParseWorker({ type: 'cancel' });
    this.postToEnrichWorker({ type: 'cancel' });
    this.terminateAll();
  }

  private terminateAll() {
    this.parseWorker?.terminate();
    this.parseWorker = null;
    this.enrichWorker?.terminate();
    this.enrichWorker = null;
  }
}
