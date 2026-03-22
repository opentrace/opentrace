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
import { JobEventKind, JobPhase } from '../gen/opentrace/v1/agent_service';
import type { JobEvent } from '../gen/opentrace/v1/agent_service';
import type { GraphStore } from '../store/types';
import { EventChannel } from './eventChannel';
import type { JobMessage, JobService, JobStream } from './types';
import {
  initParsers,
  executeScanning,
  runNodePipeline,
  FileCacheStage,
  ExtractStage,
  ResolveStage,
  SummarizeStage,
  StoreStage,
  PipelineDebugLog,
} from '@opentrace/components/pipeline';
import type {
  PipelinePhase,
  RepoTree,
  ScanResult,
  PipelineEvent,
  ConcurrentPipelineEvent,
  GraphNode,
} from '@opentrace/components/pipeline';
import { Parser, Language } from 'web-tree-sitter';

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
 *  `cache` is omitted — it's an internal optimization, not user-visible. */
const CONCURRENT_PHASE_MAP: Record<string, JobPhase> = {
  extract: JobPhase.JOB_PHASE_PARSING,
  resolve: JobPhase.JOB_PHASE_RESOLVING,
  summarize: JobPhase.JOB_PHASE_SUMMARIZING,
  store: JobPhase.JOB_PHASE_SUBMITTING,
};

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

export class BrowserJobService implements JobService {
  private store: GraphStore;

  constructor(store: GraphStore) {
    this.store = store;
  }

  async startJob(message: JobMessage): Promise<JobStream> {
    let input: LoaderInput;
    if (message.type === 'index-repo') {
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

    // Debug log — attached to window for console access
    const debug = new PipelineDebugLog({ enabled: true });
    (globalThis as Record<string, unknown>).__pipelineDebug = debug;

    const run = async () => {
      debug.start();

      // 1. Initialize parsers
      debug.log('init', 'loading tree-sitter parsers');
      channel.push({
        ...emptyEvent(),
        kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
        phase: JobPhase.JOB_PHASE_INITIALIZING,
        message: 'Initializing parsers',
      });
      await ensureParsers();
      debug.log('init', 'parsers ready');
      channel.push({
        ...emptyEvent(),
        kind: JobEventKind.JOB_EVENT_KIND_STAGE_COMPLETE,
        phase: JobPhase.JOB_PHASE_INITIALIZING,
        message: 'Parsers ready',
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
      const scanningRels: { id: string; type: string; source_id: string; target_id: string; properties?: Record<string, unknown> }[] = [];

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
          if (event.kind === 'stage_start' || isLast || now - lastYieldTime >= 100) {
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

      // 4. Build concurrent pipeline stages
      debug.log('pipeline', 'building stages');

      const fileContentMap = new Map<string, string>();
      for (const file of scanResult.parseableFiles) {
        fileContentMap.set(`${scanResult.repoId}/${file.path}`, file.content);
      }

      const fileCacheStage = new FileCacheStage({ fileContentMap });
      const extractStage = new ExtractStage({
        scanResult,
        getContent: (fileId) => fileCacheStage.getContent(fileId),
      });
      const resolveStage = new ResolveStage(extractStage);
      const summarizeStage = new SummarizeStage();
      const storeStage = new StoreStage();

      // Pre-feed scanning rels into the store stage
      storeStage.addRelationships(scanningRels);

      // Seed nodes: all structural nodes from scanning
      const seeds: GraphNode[] = [scanResult.repoNode];
      for (const dir of scanResult.dirNodes.values()) seeds.push(dir);
      for (const file of scanResult.fileNodes) seeds.push(file);
      for (const pkg of scanResult.packageNodes.values()) seeds.push(pkg);

      debug.log('pipeline', `${seeds.length} seed nodes, ${scanningRels.length} scanning rels`);
      debug.log('pipeline', `file cache limit: ${(fileCacheStage.stats().byteLimit / 1024 / 1024).toFixed(0)} MB`);

      // 5. Run concurrent pipeline
      const concurrentPipeline = runNodePipeline({
        ctx,
        stages: [fileCacheStage, extractStage, resolveStage, summarizeStage, storeStage],
        seeds,
      });

      // Final persisted counts — set once by store stage flush, used for DONE
      let persistedNodes = 0;
      let persistedRels = 0;

      // Per-stage counters for UI progress
      const stageCounts: Record<string, number> = {};
      // Total items each stage will process (estimated from seed count;
      // extract produces children so downstream stages see more items)
      const stageTotals: Record<string, number> = {};
      const totalSeeds = seeds.length;
      // Track per-stage last-yield time so each stage gets throttled independently
      const stageLastYield: Record<string, number> = {};

      for (const event of concurrentPipeline) {
        if (cancelled) break;

        debug.logEvent(event);

        if ('action' in event) {
          const phase = CONCURRENT_PHASE_MAP[event.stage];

          if (event.action === 'end') {
            // Feed relationships from non-store stages into the store stage
            const mutation = event.mutation;
            if (mutation && mutation.relationships.length > 0 && event.stage !== 'store') {
              storeStage.addRelationships(mutation.relationships);
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
              if (event.mutation && event.mutation.relationships.length > 0 && event.stage !== 'store') {
                storeStage.addRelationships(event.mutation.relationships);
              }

              // When the store stage flushes, persist everything to the graph store
              if (event.stage === 'store' && event.mutation) {
                const batch = event.mutation;
                debug.log('store', `flushing ${batch.nodes.length} nodes, ${batch.relationships.length} rels`);

                channel.push({
                  ...emptyEvent(),
                  kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
                  phase: JobPhase.JOB_PHASE_SUBMITTING,
                  message: `Persisting ${batch.nodes.length} nodes, ${batch.relationships.length} relationships`,
                });

                const importResult = await this.store.importBatch({
                  nodes: batch.nodes.map((n) => ({
                    id: n.id,
                    type: n.type,
                    name: n.name,
                    properties: n.properties,
                  })),
                  relationships: batch.relationships.map((r) => ({
                    id: r.id,
                    type: r.type,
                    source_id: r.source_id,
                    target_id: r.target_id,
                    properties: r.properties,
                  })),
                });

                await this.store.flush();

                // Use importBatch response as the single source of truth for
                // persisted counts — may differ from buffer if store deduplicates
                persistedNodes = importResult.nodes_created;
                persistedRels = importResult.relationships_created;

                debug.log('store', `persisted ${persistedNodes} nodes, ${persistedRels} rels`);

                channel.push({
                  ...emptyEvent(),
                  kind: JobEventKind.JOB_EVENT_KIND_STAGE_COMPLETE,
                  phase: JobPhase.JOB_PHASE_SUBMITTING,
                  message: `Persisted ${persistedNodes} nodes, ${persistedRels} relationships`,
                });
                await new Promise((r) => setTimeout(r, 0));
                continue;
              }

              if (phase) {
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
              debug.log('error', `${event.stage}/${event.node}: ${event.error}`);
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
              const cacheStats = fileCacheStage.stats();
              debug.log('pipeline', `done — persisted: ${persistedNodes} nodes, ${persistedRels} rels`);
              debug.log('pipeline', `cache: ${cacheStats.cached} cached, ${cacheStats.skipped} skipped, ${(cacheStats.bytesUsed / 1024 / 1024).toFixed(1)} MB used`);

              channel.push({
                ...emptyEvent(),
                kind: JobEventKind.JOB_EVENT_KIND_GRAPH_READY,
                result: {
                  nodesCreated: persistedNodes,
                  relationshipsCreated: persistedRels,
                  reposProcessed: 1,
                },
              });
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
        debug.log('error', `uncaught: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        debug.dump();
        channel.push({
          ...emptyEvent(),
          kind: JobEventKind.JOB_EVENT_KIND_ERROR,
          message: err instanceof Error ? err.message : String(err),
          errors: [err instanceof Error ? err.stack ?? err.message : String(err)],
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
}
