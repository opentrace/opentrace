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
 * Browser-based JobService implementation.
 *
 * Uses the loader registry to fetch files, then runs the concurrent
 * node pipeline (cache → extract → resolve → summarize → store)
 * and submits graph batches to the store.
 * Events are pushed into an EventChannel for async iteration.
 */

import { loaderRegistry } from '../runner/browser/loader/registry';
import type { LoaderInput } from '../runner/browser';
import { JobEventKind, JobPhase } from '../gen/agent_service';
import type { JobEvent } from '../gen/agent_service';
import type { GraphStore } from '../store/types';
import { ServerGraphStore } from '../store/serverStore';
import { EventChannel } from './eventChannel';
import type {
  JobMessage,
  JobService,
  JobStream,
  IndexRepoMessage,
  ReindexRepoMessage,
} from './types';
import {
  initParsers,
  executeScanning,
  runNodePipeline,
  ResolveStage,
  SummarizeStage,
  StoreStage,
  EmbedStage,
  PipelineDebugLog,
  ExtractPool,
  defaultPoolSize,
  createExtractionState,
  extractFile,
  mergeExtraction,
  detectLanguage,
  getExtension,
} from '@opentrace/components/pipeline';
import type {
  PipelinePhase,
  RepoTree,
  ScanResult,
  PipelineEvent,
  GraphNode,
  GraphRelationship,
  CodeSymbol,
  ImportAnalysisResult,
} from '@opentrace/components/pipeline';
import { Parser, Language } from 'web-tree-sitter';
import { loadEmbedderConfig } from '../config/embedding';

// --- Tree-sitter lazy initialization ---

let parsersReady = false;

/** Map of parser key → WASM filename for all supported languages. */
const PARSER_WASM_MAP: Record<string, string> = {
  python: 'tree-sitter-python.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-tsx.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
  swift: 'tree-sitter-swift.wasm',
  php: 'tree-sitter-php.wasm',
};

async function loadParser(wasmFile: string): Promise<Parser> {
  const parser = new Parser();
  const lang = await Language.load(`/${wasmFile}`);
  parser.setLanguage(lang);
  return parser;
}

async function ensureParsers(): Promise<void> {
  if (parsersReady) return;

  await Parser.init({
    locateFile: (file: string) => `/${file}`,
  });

  const parserMap = new Map<string, Parser>();

  // Load all available parsers in parallel, ignoring any that fail
  const entries = Object.entries(PARSER_WASM_MAP);
  const results = await Promise.allSettled(
    entries.map(async ([key, wasmFile]) => {
      const parser = await loadParser(wasmFile);
      return { key, parser };
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const [key, wasmFile] = entries[i];
    if (result.status === 'fulfilled') {
      parserMap.set(result.value.key, result.value.parser);
    } else {
      console.warn(
        `[ensureParsers] ${key} (${wasmFile}) failed:`,
        result.reason,
      );
    }
  }

  initParsers(parserMap);
  parsersReady = true;
}

// --- Phase mapping ---

const PHASE_MAP: Record<PipelinePhase, JobPhase> = {
  scanning: JobPhase.JOB_PHASE_FETCHING,
  processing: JobPhase.JOB_PHASE_PARSING,
  resolving: JobPhase.JOB_PHASE_RESOLVING,
  summarizing: JobPhase.JOB_PHASE_SUMMARIZING,
  submitting: JobPhase.JOB_PHASE_SUBMITTING,
};

function toProtoPhase(phase: PipelinePhase): JobPhase {
  return PHASE_MAP[phase] ?? JobPhase.JOB_PHASE_UNSPECIFIED;
}

/** Map concurrent stage names → JobPhase for the UI.
 *  `cache` is omitted — it's an internal optimization, not user-visible.
 *  `embed` maps to EMBEDDING but real progress comes from the
 *  concurrent drain loop, not the sync pipeline events. */
const CONCURRENT_PHASE_MAP: Record<string, JobPhase> = {
  extract: JobPhase.JOB_PHASE_PARSING,
  resolve: JobPhase.JOB_PHASE_RESOLVING,
  summarize: JobPhase.JOB_PHASE_SUMMARIZING,
  store: JobPhase.JOB_PHASE_SUBMITTING,
  embed: JobPhase.JOB_PHASE_EMBEDDING,
};

/** Translate raw agent error messages into UI-friendly ones (Fix #12).
 *  Matches the agent's `_acquire_index_lock` text and the friendly
 *  409 message added in the same fix; anything else falls through
 *  unchanged. */
function friendlyServerError(message: string): string {
  if (
    /Another index is (already running|in progress)/i.test(message) ||
    /index\.db\.indexlock/i.test(message)
  ) {
    return (
      'Another index is already running on the agent. Wait for it to ' +
      'finish before starting a new one.'
    );
  }
  return message;
}

/** Build a default empty JobEvent shell (proto fields are always present). */
function emptyEvent(): JobEvent {
  return {
    kind: JobEventKind.JOB_EVENT_KIND_UNSPECIFIED,
    phase: JobPhase.JOB_PHASE_UNSPECIFIED,
    message: '',
    result: undefined,
    errors: [],
    detail: undefined,
    nodes: [],
    relationships: [],
  };
}

/** Append every element of `src` to `dst` without spreading (a spread of a
 *  50k-element array overflows the call stack). */
function pushAll<T>(dst: T[], src: readonly T[]): void {
  for (let i = 0; i < src.length; i++) dst.push(src[i]);
}

/** The sub-type fields carried on the live stream (see pushGraphDelta) —
 *  everything the filter chips / default-hide read (graphFilterUtils
 *  getSubType), and nothing else. */
const LIVE_STREAM_PROP_KEYS = ['language', 'kind', 'registry'] as const;

/** Serialize just the sub-type fields of a node's properties (empty string
 *  when it has none) — the live stream stays lean, the filter UI stays real. */
function leanPropertiesJson(
  properties: Record<string, unknown> | undefined,
): string {
  if (!properties) return '';
  let lean: Record<string, string> | null = null;
  for (const key of LIVE_STREAM_PROP_KEYS) {
    const value = properties[key];
    if (typeof value === 'string' && value) (lean ??= {})[key] = value;
  }
  return lean ? JSON.stringify(lean) : '';
}

/** Prefix of the user-facing message for a fatal WASM out-of-memory failure.
 *  Exposed (via isOomJobError) so consumers know the store must NOT be
 *  queried again after this error — the WASM instance is likely corrupted
 *  and another query would crash the tab. */
const OOM_ERROR_MESSAGE_PREFIX = 'Repository too large for browser memory';

/** Whether a job error message is the fatal browser-OOM failure. */
export function isOomJobError(message: string | null | undefined): boolean {
  return !!message && message.startsWith(OOM_ERROR_MESSAGE_PREFIX);
}

/** Repos below this file count parse on the main thread — spinning up a
 *  worker pool would cost more than it saves. Above it, parse in parallel. */
const PARALLEL_EXTRACT_MIN_FILES = 40;

export class BrowserJobService implements JobService {
  private store: GraphStore;

  constructor(store: GraphStore) {
    this.store = store;
  }

  async startJob(message: JobMessage): Promise<JobStream> {
    // Server-mode indexing (Fix #6): when the store is backed by an
    // `opentrace serve` agent, ask the agent to do the work instead of
    // running tree-sitter in the browser. The agent owns its own DB
    // and the browser pipeline's writes would no-op against the
    // read-only ServerGraphStore.
    if (
      (message.type === 'index-repo' || message.type === 'reindex-repo') &&
      this.store instanceof ServerGraphStore
    ) {
      return this.startServerIndexUrlJob(message);
    }

    let input: LoaderInput;
    const isReindex = message.type === 'reindex-repo';
    if (message.type === 'index-repo' || message.type === 'reindex-repo') {
      input = {
        kind: 'url',
        url: message.repoUrl,
        token: message.token,
        ref: message.ref,
      };
    } else if (message.type === 'index-directory') {
      input = {
        kind: 'directory',
        files: message.files,
        name: message.name,
      };
    } else if (message.type === 'import-file') {
      return this.startImportFileJob(message.file, message.name);
    } else {
      throw new Error(
        `Unsupported job type: ${(message as { type: string }).type}`,
      );
    }

    const channel = new EventChannel<JobEvent>();
    const abortController = new AbortController();
    let cancelled = false;

    // Live-build: push node/relationship batches as produced so the UI builds
    // the graph during indexing. We send id/type/name plus ONLY the small
    // sub-type fields (language/kind/registry) — the filter chips and the
    // Variable/Dependency default-hide need those, and there is no
    // authoritative full reload after a live build (holding every property
    // blob in the JS heap is what OOM-crashed the tab on Grafana-scale repos).
    // Full properties are fetched on demand per node (SidePanel).
    const pushGraphDelta = (
      nodes: {
        id: string;
        type: string;
        name: string;
        properties?: Record<string, unknown>;
      }[],
      rels: {
        id: string;
        type: string;
        source_id: string;
        target_id: string;
        properties?: Record<string, unknown>;
      }[],
    ) => {
      if (!nodes.length && !rels.length) return;
      channel.push({
        ...emptyEvent(),
        kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
        nodes: nodes.map((n) => ({
          id: n.id,
          type: n.type,
          name: n.name,
          propertiesJson: leanPropertiesJson(n.properties),
        })),
        relationships: rels.map((r) => ({
          id: r.id,
          type: r.type,
          sourceId: r.source_id,
          targetId: r.target_id,
          propertiesJson: '',
        })),
      });
    };

    // Debug log — attached to window for console access
    const debug = new PipelineDebugLog({ enabled: true });
    (globalThis as Record<string, unknown>).__pipelineDebug = debug;

    // Hoisted so the catch handler can report partial progress
    let persistedNodes = 0;
    let persistedRels = 0;
    let storeStage: StoreStage | undefined;

    const run = async () => {
      const pipelineStartTime = performance.now();
      debug.start();

      // 1. Initialize parsers + DB in parallel
      debug.log('init', 'loading tree-sitter parsers + DB');
      channel.push({
        ...emptyEvent(),
        kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
        phase: JobPhase.JOB_PHASE_INITIALIZING,
        message: 'Initializing',
      });
      await Promise.all([ensureParsers(), this.store.ensureReady?.()]);
      debug.log('init', 'parsers + DB ready');
      channel.push({
        ...emptyEvent(),
        kind: JobEventKind.JOB_EVENT_KIND_STAGE_COMPLETE,
        phase: JobPhase.JOB_PHASE_INITIALIZING,
        message: 'Ready',
      });

      if (cancelled) return;

      // 2. Fetch files via loader
      debug.log('fetch', 'finding loader');
      const loader = loaderRegistry.find((l) => l.canHandle(input));
      if (!loader) {
        throw new Error('No loader found for input');
      }

      if (cancelled) return;

      debug.log('fetch', 'loading files');
      const repoTree: RepoTree = await loader.load(input, {
        signal: abortController.signal,
        onProgress: (progress) => {
          channel.push({
            ...emptyEvent(),
            kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
            phase: JobPhase.JOB_PHASE_FETCHING,
            message: progress.fileName
              ? `Fetching ${progress.fileName}`
              : `Fetching files`,
            detail: {
              current: progress.current,
              total: progress.total,
              fileName: progress.fileName ?? '',
              nodesCreated: 0,
              relationshipsCreated: 0,
            },
          });
        },
      });
      debug.log('fetch', `loaded ${repoTree.files.length} files`);

      if (cancelled) return;

      // Store source files for UI code viewing
      const repoId = `${repoTree.owner}/${repoTree.repo}`;

      // Reindex: wipe the existing rows for this repo before any writes, so
      // the COPY FROM path doesn't hit PK violations on shared ids. Runs
      // after the fetch succeeds — a failed fetch must not destroy existing
      // data. No-op when deleteRepo is absent (server mode), matching the
      // rest of the store's server-mode write-path conventions.
      if (isReindex && this.store.deleteRepo) {
        debug.log('reindex', `clearing existing data for ${repoId}`);
        channel.push({
          ...emptyEvent(),
          kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
          phase: JobPhase.JOB_PHASE_INITIALIZING,
          message: 'Clearing existing data…',
        });
        await this.store.deleteRepo(repoId);
        channel.push({
          ...emptyEvent(),
          kind: JobEventKind.JOB_EVENT_KIND_STAGE_COMPLETE,
          phase: JobPhase.JOB_PHASE_INITIALIZING,
          message: 'Existing data cleared',
        });
        if (cancelled) return;
      }

      this.store.storeSource(
        repoTree.files.map((f) => ({
          id: `${repoId}/${f.path}`,
          path: f.path,
          content: f.content,
        })),
      );

      // 3. Run scanning stage (builds structural graph + lookup maps)
      debug.log('scanning', 'starting');
      const ctx = {
        get cancelled() {
          return cancelled;
        },
      };
      let lastYieldTime = performance.now();

      const scanGen = executeScanning({ repo: repoTree }, ctx);
      let scanResult: ScanResult | undefined;
      const scanningRels: {
        id: string;
        type: string;
        source_id: string;
        target_id: string;
        properties?: Record<string, unknown>;
      }[] = [];

      // Drive the scanning generator, forwarding events to the channel
      for (;;) {
        const { value, done } = scanGen.next();
        if (done) {
          scanResult = value;
          break;
        }
        const event = value as PipelineEvent;

        // Collect structural rels for the store stage
        if (event.relationships?.length) {
          for (const r of event.relationships) {
            scanningRels.push({
              id: r.id,
              type: r.type,
              source_id: r.source_id,
              target_id: r.target_id,
              properties: r.properties,
            });
          }
        }

        if (event.kind === 'stage_start' || event.kind === 'stage_progress') {
          const now = performance.now();
          const isLast = event.detail?.current === event.detail?.total;
          if (
            event.kind === 'stage_start' ||
            isLast ||
            now - lastYieldTime >= 100
          ) {
            channel.push({
              ...emptyEvent(),
              kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
              phase: toProtoPhase(event.phase),
              message: event.message,
              detail: event.detail
                ? {
                    current: event.detail.current,
                    total: event.detail.total,
                    fileName: event.detail.fileName ?? '',
                    nodesCreated: 0,
                    relationshipsCreated: 0,
                  }
                : undefined,
            });
            await new Promise((r) => setTimeout(r, 0));
            lastYieldTime = performance.now();
          }
        } else if (event.kind === 'stage_stop') {
          debug.log('scanning', `done: ${event.message}`);
          channel.push({
            ...emptyEvent(),
            kind: JobEventKind.JOB_EVENT_KIND_STAGE_COMPLETE,
            phase: toProtoPhase(event.phase),
            message: event.message,
          });
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      if (cancelled || !scanResult) return;

      // 4. Parse + extract every file — in PARALLEL, OFF the main thread.
      //    Tree-sitter parsing is the indexing bottleneck; a worker pool keeps
      //    the main thread free so indexing is fast AND the live build stays
      //    smooth even on huge repos (Grafana-scale). Each worker result is
      //    merged into the shared registries here on the main thread (cheap),
      //    producing symbol nodes that flow through resolve/summarize/store.
      debug.log('pipeline', 'parallel extract');

      // fileId → raw content, consumed (and freed) during extraction.
      const fileContentMap = new Map<string, string>();
      for (const file of scanResult.parseableFiles) {
        fileContentMap.set(`${scanResult.repoId}/${file.path}`, file.content);
      }
      // Release raw file strings — source is compressed in the store's
      // sourceCache; parseable content now lives in fileContentMap.
      repoTree.files.length = 0;
      scanResult.parseableFiles.length = 0;

      const embedderConfig = loadEmbedderConfig();
      const extractionState = createExtractionState(scanResult);

      // Reveal the structural skeleton (repo → dirs → files + scanned deps)
      // to the live build IMMEDIATELY, before parsing starts — so the user
      // sees the repo/dirs/files first and symbols fill in as they parse.
      const structuralSeeds: GraphNode[] = [scanResult.repoNode];
      for (const dir of scanResult.dirNodes.values()) structuralSeeds.push(dir);
      for (const file of scanResult.fileNodes) structuralSeeds.push(file);
      for (const pkg of scanResult.packageNodes.values())
        structuralSeeds.push(pkg);
      pushGraphDelta(structuralSeeds, scanningRels);

      // Files to parse: File nodes with a path + cached content.
      const extractRefs: { fileId: string; filePath: string }[] = [];
      for (const fileNode of scanResult.fileNodes) {
        const filePath = fileNode.properties?.path as string | undefined;
        if (filePath && fileContentMap.has(fileNode.id)) {
          extractRefs.push({ fileId: fileNode.id, filePath });
        }
      }

      const symbolNodes: GraphNode[] = [];
      const symbolRels: GraphRelationship[] = [];
      let extractedCount = 0;
      let lastParseYield = 0;

      // Read a file's content and free it immediately (bounds peak memory —
      // the worker gets a structured-clone copy on postMessage).
      const takeContent = (fileId: string): string | undefined => {
        const c = fileContentMap.get(fileId);
        fileContentMap.delete(fileId);
        return c;
      };

      const emitParseProgress = (force?: boolean) => {
        const now = performance.now();
        if (!force && now - lastParseYield < 100) return;
        lastParseYield = now;
        channel.push({
          ...emptyEvent(),
          kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
          phase: JobPhase.JOB_PHASE_PARSING,
          message: `Parsing ${extractedCount}/${extractRefs.length} files`,
          detail: {
            current: extractedCount,
            total: extractRefs.length,
            fileName: '',
            nodesCreated: 0,
            relationshipsCreated: 0,
          },
        });
      };

      // Live-build streaming is BATCHED: pushing per file meant thousands of
      // tiny pushGraphDelta calls (channel events + React pressure) competing
      // with the worker dispatch on the main thread — starving the parse pool.
      // We accumulate merged nodes/rels and flush in chunks instead.
      const liveBatchNodes: GraphNode[] = [];
      const liveBatchRels: GraphRelationship[] = [];
      const LIVE_STREAM_CHUNK = 600;
      const flushLiveBatch = () => {
        if (liveBatchNodes.length === 0 && liveBatchRels.length === 0) return;
        pushGraphDelta(liveBatchNodes.splice(0), liveBatchRels.splice(0));
      };

      const onExtracted = (
        fileId: string,
        language: string,
        symbols: CodeSymbol[],
        importResult: ImportAnalysisResult,
      ) => {
        const prevPkgCount = extractionState.pendingPackageNodes.length;
        const merged = mergeExtraction(
          fileId,
          language,
          symbols,
          importResult,
          extractionState,
        );
        pushAll(symbolNodes, merged.nodes);
        pushAll(symbolRels, merged.relationships);
        // Queue this file's symbols for the live build, plus any brand-new
        // Dependency nodes it discovered (so IMPORTS edges to them resolve
        // instead of sitting deferred). Deps are seeded to the store
        // separately via pendingPackageNodes, so keep them out of symbolNodes.
        pushAll(liveBatchNodes, merged.nodes);
        if (extractionState.pendingPackageNodes.length > prevPkgCount) {
          pushAll(
            liveBatchNodes,
            extractionState.pendingPackageNodes.slice(prevPkgCount),
          );
        }
        pushAll(liveBatchRels, merged.relationships);
        if (liveBatchNodes.length >= LIVE_STREAM_CHUNK) flushLiveBatch();
        extractedCount++;
        emitParseProgress();
      };

      if (extractRefs.length >= PARALLEL_EXTRACT_MIN_FILES) {
        const poolSize = Math.min(
          defaultPoolSize(),
          Math.max(2, Math.ceil(extractRefs.length / 128)),
        );
        debug.log(
          'pipeline',
          `parallel extract: ${extractRefs.length} files, ${poolSize} workers`,
        );
        // Only load the grammars this repo actually uses — loading all 14 in
        // every worker cost ~6s of startup on an 8-worker pool.
        const neededKeys = new Set<string>();
        for (const fileNode of scanResult.fileNodes) {
          const p = fileNode.properties?.path as string | undefined;
          if (!p) continue;
          const lang = detectLanguage(getExtension(p));
          if (!lang) continue;
          if (lang === 'typescript') {
            neededKeys.add('typescript');
            neededKeys.add('tsx');
          } else if (lang === 'javascript') {
            neededKeys.add('javascript');
          } else {
            neededKeys.add(lang);
          }
        }

        const pool = new ExtractPool(poolSize);
        try {
          const tInit = performance.now();
          await pool.init(
            scanResult.knownPaths,
            scanResult.goModulePath,
            neededKeys.size ? [...neededKeys] : undefined,
          );
          const tRun = performance.now();
          debug.log(
            'pipeline',
            `pool.init ${poolSize} workers (${neededKeys.size} grammars): ${Math.round(tRun - tInit)}ms`,
          );
          await pool.run(extractRefs, takeContent, {
            onResult: (r) =>
              onExtracted(r.fileId, r.language, r.symbols, r.importResult),
            onSkip: () => {
              extractedCount++;
              emitParseProgress();
            },
            onError: (fileId, error) => {
              extractedCount++;
              debug.log('error', `extract ${fileId}: ${error}`);
              emitParseProgress();
            },
            isCancelled: () => cancelled,
          });
          const tDone = performance.now();
          debug.log(
            'pipeline',
            `parsed ${extractRefs.length} files in ${Math.round(tDone - tRun)}ms (${Math.round((extractRefs.length / (tDone - tRun)) * 1000)} files/s)`,
          );
        } finally {
          pool.terminate();
        }
      } else {
        // Tiny repo — parse on the main thread (avoids worker spin-up cost).
        for (const ref of extractRefs) {
          if (cancelled) break;
          const content = takeContent(ref.fileId);
          if (content === undefined) {
            extractedCount++;
            continue;
          }
          let extracted: ReturnType<typeof extractFile> = null;
          try {
            extracted = extractFile(
              ref.filePath,
              content,
              extractionState.knownPaths,
              extractionState.goModulePath,
            );
          } catch {
            extracted = null;
          }
          if (extracted) {
            onExtracted(
              ref.fileId,
              extracted.language,
              extracted.symbols,
              extracted.importResult,
            );
          } else {
            extractedCount++;
          }
          if (extractedCount % 25 === 0) {
            emitParseProgress();
            await new Promise((r) => setTimeout(r, 0));
          }
        }
      }
      flushLiveBatch(); // push whatever's left below the chunk threshold
      fileContentMap.clear();
      emitParseProgress(true);
      // Parsing runs through the worker pool, not the concurrent scheduler,
      // so no flush_end ever completes its stage row — without this the
      // "Files & symbols" row sat ACTIVE at n/n for the rest of the job.
      channel.push({
        ...emptyEvent(),
        kind: JobEventKind.JOB_EVENT_KIND_STAGE_COMPLETE,
        phase: JobPhase.JOB_PHASE_PARSING,
        message: `Parsed ${extractedCount} files`,
      });

      if (cancelled) return;

      // 5. Build the rest of the pipeline — extraction is already done, so no
      //    FileCacheStage / ExtractStage. Symbol nodes are fed as seeds.
      const resolveStage = new ResolveStage(extractionState);
      const summarizeStage = new SummarizeStage();
      storeStage = new StoreStage();
      const embedStage = embedderConfig.enabled
        ? new EmbedStage({ config: embedderConfig, store: this.store })
        : null;

      // Pre-feed scanning + symbol (DEFINES/IMPORTS) rels into the store stage.
      storeStage.addRelationships(scanningRels);
      storeStage.addRelationships(symbolRels);

      // Seeds for PERSISTENCE: the structural skeleton (streamed to the live
      // build up front) + external Dependency nodes discovered during import
      // analysis (streamed as they were found) + the extracted symbol nodes
      // (streamed as they were parsed). Everything is already on screen; the
      // pipeline below just persists it + resolves calls.
      const seeds: GraphNode[] = structuralSeeds.slice();
      pushAll(seeds, extractionState.pendingPackageNodes);
      pushAll(seeds, symbolNodes);

      debug.log(
        'pipeline',
        `${seeds.length} seeds (${symbolNodes.length} symbols), ${
          scanningRels.length + symbolRels.length
        } rels`,
      );

      // 6. Run concurrent pipeline (resolve → summarize → store → embed)
      const stages = [
        resolveStage,
        summarizeStage,
        storeStage,
        ...(embedStage ? [embedStage] : []),
      ];
      const concurrentPipeline = runNodePipeline({ ctx, stages, seeds });

      // Reset persisted counts for this pipeline run
      persistedNodes = 0;
      persistedRels = 0;

      // Per-stage counters for UI progress
      const stageCounts: Record<string, number> = {};
      // Total items each stage will process (estimated from seed count;
      // extract produces children so downstream stages see more items)
      const stageTotals: Record<string, number> = {};
      const totalSeeds = seeds.length;
      // Track per-stage last-yield time so each stage gets throttled independently
      const stageLastYield: Record<string, number> = {};

      // WASM memory diagnostics (only available on LadybugGraphStore)
      const wasmMB = () => {
        const s = this.store as { getWasmMemoryMB?: () => number };
        return s.getWasmMemoryMB ? s.getWasmMemoryMB() : -1;
      };

      /** Drain buffered nodes from the store stage and persist them. */
      const drainNodesToStore = async () => {
        const nodes = storeStage!.drainNodes();
        if (nodes.length === 0) return;
        debug.log(
          'store',
          `draining ${nodes.length} nodes (wasm=${wasmMB().toFixed(0)}MB)`,
        );
        await this.store.importBatch({
          nodes: nodes.map((n) => ({
            id: n.id,
            type: n.type,
            name: n.name,
            properties: n.properties,
          })),
          relationships: [],
        });
        await this.store.flush();
        persistedNodes += nodes.length;
        pushGraphDelta(nodes, []);
      };

      /** Drain buffered relationships from the store stage and persist them. */
      const drainRelsToStore = async () => {
        const rels = storeStage!.drainRelationships();
        if (rels.length === 0) return;
        debug.log('store', `draining ${rels.length} rels`);
        await this.store.importBatch({
          nodes: [],
          relationships: rels.map((r) => ({
            id: r.id,
            type: r.type,
            source_id: r.source_id,
            target_id: r.target_id,
            properties: r.properties,
          })),
        });
        await this.store.flush();
        persistedRels += rels.length;
      };

      for (const event of concurrentPipeline) {
        if (cancelled) break;

        debug.logEvent(event);

        if ('action' in event) {
          const phase = CONCURRENT_PHASE_MAP[event.stage];

          if (event.action === 'end') {
            // Feed relationships from non-store stages into the store stage
            const mutation = event.mutation;
            if (
              mutation &&
              mutation.relationships.length > 0 &&
              event.stage !== 'store'
            ) {
              storeStage.addRelationships(mutation.relationships);
              pushGraphDelta([], mutation.relationships);
            }

            // Incrementally persist nodes when the store stage buffer fills
            if (storeStage.needsDrain()) {
              await drainNodesToStore();
            }

            // Skip UI events for stages without a phase mapping (e.g. cache)
            if (!phase) continue;

            // Track per-stage progress
            stageCounts[event.stage] = (stageCounts[event.stage] ?? 0) + 1;

            // Extract has a known total (seed count); downstream stages
            // process variable numbers of items so use 0 (indeterminate bar)
            if (event.stage === 'extract') {
              stageTotals[event.stage] = totalSeeds;
            } else {
              stageTotals[event.stage] = 0;
            }

            // Throttle progress per stage (100ms)
            const now = performance.now();
            const stageYield = stageLastYield[event.stage] ?? 0;
            const count = stageCounts[event.stage];
            const total = stageTotals[event.stage];
            const isLast = total > 0 && count === total;

            if (isLast || now - stageYield >= 100) {
              const storeStats = storeStage.stats();
              channel.push({
                ...emptyEvent(),
                kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
                phase,
                message: `Processing ${event.node}`,
                detail: {
                  current: count,
                  total,
                  fileName: event.node,
                  nodesCreated: storeStats.nodes,
                  relationshipsCreated: storeStats.relationships,
                },
              });
              stageLastYield[event.stage] = now;

              // Extract is the only stage with a real total and it has no
              // flush_end — without this, "Files & symbols" sat ACTIVE at
              // n/n for the whole indexing tail (looked hung to users).
              if (isLast) {
                channel.push({
                  ...emptyEvent(),
                  kind: JobEventKind.JOB_EVENT_KIND_STAGE_COMPLETE,
                  phase,
                  message: `Completed ${event.stage}`,
                });
              }

              // Yield to UI periodically (not on every event — batch up)
              if (now - lastYieldTime >= 100) {
                await new Promise((r) => setTimeout(r, 0));
                lastYieldTime = now;
              }
            }
          }
        } else if ('kind' in event) {
          switch (event.kind) {
            case 'flush_start': {
              const phase = CONCURRENT_PHASE_MAP[event.stage];
              if (phase) {
                channel.push({
                  ...emptyEvent(),
                  kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
                  phase,
                  message: `Finalizing ${event.stage}`,
                });
              }
              break;
            }

            case 'flush_end': {
              const phase = CONCURRENT_PHASE_MAP[event.stage];

              // Feed flush relationships into store stage (e.g. CALLS from resolve)
              if (
                event.mutation &&
                event.mutation.relationships.length > 0 &&
                event.stage !== 'store'
              ) {
                storeStage.addRelationships(event.mutation.relationships);
                pushGraphDelta([], event.mutation.relationships);
              }

              // When the store stage flushes, persist remaining nodes then rels
              if (event.stage === 'store') {
                const storeStats = storeStage.stats();
                debug.log(
                  'store',
                  `final flush — ${storeStats.nodes} total nodes, ${storeStats.relationships} total rels`,
                );

                channel.push({
                  ...emptyEvent(),
                  kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
                  phase: JobPhase.JOB_PHASE_SUBMITTING,
                  message: `Persisting ${storeStats.nodes} nodes, ${storeStats.relationships} relationships`,
                });

                // Drain any remaining buffered nodes
                await drainNodesToStore();
                // Now all nodes are in the DB — safe to persist relationships
                await drainRelsToStore();

                debug.log(
                  'store',
                  `persisted ${persistedNodes} nodes, ${persistedRels} rels`,
                );

                channel.push({
                  ...emptyEvent(),
                  kind: JobEventKind.JOB_EVENT_KIND_STAGE_COMPLETE,
                  phase: JobPhase.JOB_PHASE_SUBMITTING,
                  message: `Persisted ${persistedNodes} nodes, ${persistedRels} relationships`,
                });

                // Graph is ready — UI can show it immediately while
                // embedding continues as the next pipeline stage.
                channel.push({
                  ...emptyEvent(),
                  kind: JobEventKind.JOB_EVENT_KIND_GRAPH_READY,
                  result: {
                    nodesCreated: persistedNodes,
                    relationshipsCreated: persistedRels,
                    reposProcessed: 1,
                  },
                });

                await new Promise((r) => setTimeout(r, 0));
                continue;
              }

              // Embed's flush_end fires when the ENQUEUE side finishes — the
              // actual embedding continues in embedStage.settle(), which
              // pushes the real STAGE_COMPLETE. Marking it done here made the
              // panel show "Generating embeddings ✓" while counts still
              // climbed, so the whole tail read as hung.
              if (phase && event.stage !== 'embed') {
                channel.push({
                  ...emptyEvent(),
                  kind: JobEventKind.JOB_EVENT_KIND_STAGE_COMPLETE,
                  phase,
                  message: `Completed ${event.stage}`,
                });
                await new Promise((r) => setTimeout(r, 0));
              }
              break;
            }

            case 'item_error':
              debug.log(
                'error',
                `${event.stage}/${event.node}: ${event.error}`,
              );
              console.warn(
                `[pipeline] ${event.stage} error on ${event.node}: ${event.error}`,
              );
              break;

            case 'pipeline_error':
              debug.log('error', `pipeline: ${event.error}`);
              channel.push({
                ...emptyEvent(),
                kind: JobEventKind.JOB_EVENT_KIND_ERROR,
                message: event.error,
                errors: [event.error],
              });
              debug.dump();
              return;

            case 'pipeline_done': {
              const durationSeconds =
                Math.round((performance.now() - pipelineStartTime) / 10) / 100;
              debug.log(
                'pipeline',
                `done — persisted: ${persistedNodes} nodes, ${persistedRels} rels`,
              );

              // Persist index metadata
              await this.store.importBatch({
                nodes: [
                  {
                    id: `_meta:index:${repoId}`,
                    type: 'IndexMetadata',
                    name: 'index',
                    properties: {
                      indexedAt: new Date().toISOString(),
                      durationSeconds,
                      repoId: repoId,
                      repoPath: repoTree.url ?? repoId,
                      sourceUri: repoTree.url ?? '',
                      commitSha: repoTree.sha ?? '',
                      commitMessage: repoTree.commitMessage ?? '',
                      branch: repoTree.branch ?? repoTree.ref ?? '',
                      nodesCreated: persistedNodes,
                      relationshipsCreated: persistedRels,
                      filesProcessed:
                        scanResult?.parseableFiles?.length ??
                        scanResult?.fileNodes?.length ??
                        0,
                    },
                  },
                ],
                relationships: [],
              });
              await this.store.flush();

              // Run embedding — model was pre-loaded during pipeline
              if (embedStage && embedStage.total > 0) {
                debug.log(
                  'embedding',
                  `starting ${embedStage.total} embeddings`,
                );
                await embedStage.settle((embedded, total) => {
                  channel.push({
                    ...emptyEvent(),
                    kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
                    phase: JobPhase.JOB_PHASE_EMBEDDING,
                    message: `Embedded ${embedded} of ${total} nodes`,
                    detail: {
                      current: embedded,
                      total,
                      fileName: '',
                      nodesCreated: 0,
                      relationshipsCreated: 0,
                    },
                  });
                });
                debug.log(
                  'embedding',
                  `completed: ${embedStage.embeddedCount} nodes embedded`,
                );
                channel.push({
                  ...emptyEvent(),
                  kind: JobEventKind.JOB_EVENT_KIND_STAGE_COMPLETE,
                  phase: JobPhase.JOB_PHASE_EMBEDDING,
                  message: `Embedded ${embedStage.embeddedCount} nodes`,
                });
              }

              channel.push({
                ...emptyEvent(),
                kind: JobEventKind.JOB_EVENT_KIND_DONE,
                phase: JobPhase.JOB_PHASE_DONE,
                result: {
                  nodesCreated: persistedNodes,
                  relationshipsCreated: persistedRels,
                  reposProcessed: 1,
                },
              });

              debug.dump();
              break;
            }
          }
        }
      }
    };

    // Fire-and-forget so the stream is returned immediately
    run()
      .catch((err) => {
        // Log full error with stack trace to console for debugging
        console.error('[BrowserJobService] pipeline error:', err);
        debug.log(
          'error',
          `uncaught: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
        debug.dump();

        const errMsg = err instanceof Error ? err.message : String(err);
        const isOOM =
          (err instanceof Error &&
            (errMsg.includes('memory') || errMsg.includes('out of bounds'))) ||
          typeof err === 'number'; // WASM abort codes are thrown as raw numbers
        const totalStats = storeStage?.stats();
        const userMessage = isOOM
          ? `${OOM_ERROR_MESSAGE_PREFIX}. Indexed ${persistedNodes} of ${totalStats?.nodes ?? '?'} nodes. Try a smaller repository or use the CLI agent for large codebases.`
          : errMsg;

        // Don't emit GRAPH_READY on OOM — the WASM instance is likely
        // corrupted and fetchGraph() would trigger another crash.
        channel.push({
          ...emptyEvent(),
          kind: JobEventKind.JOB_EVENT_KIND_ERROR,
          message: userMessage,
          errors: [err instanceof Error ? (err.stack ?? errMsg) : errMsg],
        });
      })
      .finally(() => {
        channel.close();
      });

    return {
      [Symbol.asyncIterator]: () => channel[Symbol.asyncIterator](),
      cancel() {
        cancelled = true;
        abortController.abort();
        channel.close();
      },
    };
  }

  private async startImportFileJob(
    file: File,
    name: string,
  ): Promise<JobStream> {
    const channel = new EventChannel<JobEvent>();
    let cancelled = false;

    const run = async () => {
      // 1. Read the binary database file
      channel.push({
        ...emptyEvent(),
        kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
        phase: JobPhase.JOB_PHASE_FETCHING,
        message: `Reading ${name}`,
      });

      const buffer = await file.arrayBuffer();
      const data = new Uint8Array(buffer);

      channel.push({
        ...emptyEvent(),
        kind: JobEventKind.JOB_EVENT_KIND_STAGE_COMPLETE,
        phase: JobPhase.JOB_PHASE_FETCHING,
        message: `Read ${(data.byteLength / 1024 / 1024).toFixed(1)} MB`,
      });

      if (cancelled) return;

      // 2. Import the database via the store's importDatabase method
      if (!this.store.importDatabase) {
        throw new Error('Store does not support database file import');
      }

      const result = await this.store.importDatabase(data, (msg) => {
        channel.push({
          ...emptyEvent(),
          kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
          phase: JobPhase.JOB_PHASE_SUBMITTING,
          message: msg,
        });
      });

      channel.push({
        ...emptyEvent(),
        kind: JobEventKind.JOB_EVENT_KIND_STAGE_COMPLETE,
        phase: JobPhase.JOB_PHASE_SUBMITTING,
        message: `Imported ${result.nodes_created} nodes, ${result.relationships_created} relationships`,
      });

      channel.push({
        ...emptyEvent(),
        kind: JobEventKind.JOB_EVENT_KIND_GRAPH_READY,
        result: {
          nodesCreated: result.nodes_created,
          relationshipsCreated: result.relationships_created,
          reposProcessed: 1,
        },
      });
      channel.push({
        ...emptyEvent(),
        kind: JobEventKind.JOB_EVENT_KIND_DONE,
        phase: JobPhase.JOB_PHASE_DONE,
        result: {
          nodesCreated: result.nodes_created,
          relationshipsCreated: result.relationships_created,
          reposProcessed: 1,
        },
      });
    };

    run()
      .catch((err) => {
        channel.push({
          ...emptyEvent(),
          kind: JobEventKind.JOB_EVENT_KIND_ERROR,
          message: err instanceof Error ? err.message : String(err),
          errors: [err instanceof Error ? err.message : String(err)],
        });
      })
      .finally(() => {
        channel.close();
      });

    return {
      [Symbol.asyncIterator]: () => channel[Symbol.asyncIterator](),
      cancel() {
        cancelled = true;
        channel.close();
      },
    };
  }

  /**
   * Server-mode indexing job (Fix #6). POSTs the URL to the agent's
   * `/api/index-url`, then polls `/api/index-progress/{jobId}` every
   * ~1.5s, translating the agent's phase strings to `JobEvent`s for
   * the existing `IndexingProgress` UI.
   *
   * Cancellation here is one-sided: the UI stops polling, but the
   * agent's background thread continues to completion. A future
   * `/api/index-url/{jobId}/cancel` would be needed to actually
   * abort the agent-side work.
   */
  private async startServerIndexUrlJob(
    message: IndexRepoMessage | ReindexRepoMessage,
  ): Promise<JobStream> {
    const channel = new EventChannel<JobEvent>();
    const cancelRef = { cancelled: false };
    const store = this.store as ServerGraphStore;

    const run = async () => {
      channel.push({
        ...emptyEvent(),
        kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
        phase: JobPhase.JOB_PHASE_INITIALIZING,
        message: 'Submitting indexing job to agent…',
      });

      let jobId: string;
      try {
        const submitResult = await store.indexUrl({
          repoUrl: message.repoUrl,
          repoId: message.repoId,
          token: message.token,
          ref: message.ref,
          zipball: message.zipball,
          reindex: message.type === 'reindex-repo',
        });
        jobId = submitResult.jobId;
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const friendly = friendlyServerError(raw);
        channel.push({
          ...emptyEvent(),
          kind: JobEventKind.JOB_EVENT_KIND_ERROR,
          message: friendly,
          errors: [raw],
        });
        return;
      }

      await this.pollServerIndexJob(store, jobId, channel, cancelRef);
    };

    run().finally(() => channel.close());

    return {
      [Symbol.asyncIterator]: () => channel[Symbol.asyncIterator](),
      cancel() {
        cancelRef.cancelled = true;
        channel.close();
      },
    };
  }

  /**
   * Attach to an already-running server-mode index job (Fix #14).
   * Used after a page reload to resume the progress indicator for
   * work the agent started before the SPA was navigated away —
   * without this, a long-running index becomes invisible the moment
   * the user refreshes the page.
   */
  async attachToServerIndexJob(jobId: string): Promise<JobStream> {
    if (!(this.store instanceof ServerGraphStore)) {
      throw new Error(
        'attachToServerIndexJob requires a ServerGraphStore-backed session',
      );
    }
    const store = this.store;
    const channel = new EventChannel<JobEvent>();
    const cancelRef = { cancelled: false };

    channel.push({
      ...emptyEvent(),
      kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
      phase: JobPhase.JOB_PHASE_INITIALIZING,
      message: 'Resuming indexing job…',
    });

    this.pollServerIndexJob(store, jobId, channel, cancelRef).finally(() =>
      channel.close(),
    );

    return {
      [Symbol.asyncIterator]: () => channel[Symbol.asyncIterator](),
      cancel() {
        cancelRef.cancelled = true;
        channel.close();
      },
    };
  }

  /** Shared polling loop used by both `startServerIndexUrlJob` and
   *  `attachToServerIndexJob`. Translates the agent's progress
   *  states into `JobEvent`s and pushes them onto `channel` until
   *  the job is done, errors, or the caller cancels. */
  private async pollServerIndexJob(
    store: ServerGraphStore,
    jobId: string,
    channel: EventChannel<JobEvent>,
    cancelRef: { cancelled: boolean },
  ): Promise<void> {
    const phaseMap: Record<string, JobPhase> = {
      queued: JobPhase.JOB_PHASE_INITIALIZING,
      initializing: JobPhase.JOB_PHASE_INITIALIZING,
      deleting: JobPhase.JOB_PHASE_INITIALIZING,
      fetching: JobPhase.JOB_PHASE_FETCHING,
      parsing: JobPhase.JOB_PHASE_PARSING,
      done: JobPhase.JOB_PHASE_DONE,
      error: JobPhase.JOB_PHASE_UNSPECIFIED,
    };
    const rawPhaseMap: Record<string, JobPhase> = {
      scanning: JobPhase.JOB_PHASE_FETCHING,
      processing: JobPhase.JOB_PHASE_PARSING,
      resolving: JobPhase.JOB_PHASE_RESOLVING,
      submitting: JobPhase.JOB_PHASE_SUBMITTING,
    };
    let lastPhaseString = '';
    while (!cancelRef.cancelled) {
      let state;
      try {
        state = await store.getIndexProgress(jobId);
      } catch (err) {
        // Transient agent unreachability — treat as a polling
        // glitch unless multiple consecutive failures pile up.
        // For v1 we just surface and abort; the UI can resubmit.
        const msg = err instanceof Error ? err.message : String(err);
        channel.push({
          ...emptyEvent(),
          kind: JobEventKind.JOB_EVENT_KIND_ERROR,
          message: `Lost contact with agent: ${msg}`,
          errors: [msg],
        });
        return;
      }

      if (cancelRef.cancelled) return;

      // Prefer the agent's fine-grained phase when it's known; fall
      // back to the coarse phase mapping otherwise.
      const protoPhase =
        (state.phaseRaw && rawPhaseMap[state.phaseRaw]) ||
        phaseMap[state.phase] ||
        JobPhase.JOB_PHASE_UNSPECIFIED;

      // Use the combined "coarse:raw" key to detect transitions so a
      // change from `parsing/processing` → `parsing/resolving` still
      // triggers a STAGE_COMPLETE (without spamming one per poll).
      const phaseKey = `${state.phase}:${state.phaseRaw ?? ''}`;
      if (lastPhaseString && lastPhaseString !== phaseKey) {
        const [prevCoarse, prevRaw] = lastPhaseString.split(':');
        const prevProto =
          (prevRaw && rawPhaseMap[prevRaw]) ||
          phaseMap[prevCoarse] ||
          JobPhase.JOB_PHASE_UNSPECIFIED;
        if (prevProto !== JobPhase.JOB_PHASE_UNSPECIFIED) {
          channel.push({
            ...emptyEvent(),
            kind: JobEventKind.JOB_EVENT_KIND_STAGE_COMPLETE,
            phase: prevProto,
            message: `Completed ${prevRaw || prevCoarse}`,
          });
        }
      }
      lastPhaseString = phaseKey;

      if (state.error) {
        const friendly = friendlyServerError(state.error);
        channel.push({
          ...emptyEvent(),
          kind: JobEventKind.JOB_EVENT_KIND_ERROR,
          message: friendly,
          errors: [state.error],
        });
        return;
      }

      if (state.done && state.result) {
        // Graph is ready — UI can refresh from /api/graph.
        channel.push({
          ...emptyEvent(),
          kind: JobEventKind.JOB_EVENT_KIND_GRAPH_READY,
          result: {
            nodesCreated: state.result.totalNodes,
            relationshipsCreated: state.result.totalEdges,
            reposProcessed: 1,
          },
        });
        channel.push({
          ...emptyEvent(),
          kind: JobEventKind.JOB_EVENT_KIND_DONE,
          phase: JobPhase.JOB_PHASE_DONE,
          result: {
            nodesCreated: state.result.totalNodes,
            relationshipsCreated: state.result.totalEdges,
            reposProcessed: 1,
          },
        });
        return;
      }

      // Surface the running counts so IndexingProgress can fill in
      // the "X nodes / Y edges" tiles instead of showing zeros.
      channel.push({
        ...emptyEvent(),
        kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
        phase: protoPhase,
        message: state.message,
        detail: {
          current: state.currentItems ?? 0,
          total: state.totalItems ?? 0,
          fileName: state.currentFile ?? '',
          nodesCreated: state.nodesCreated ?? 0,
          relationshipsCreated: state.relationshipsCreated ?? 0,
        },
      });

      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}
