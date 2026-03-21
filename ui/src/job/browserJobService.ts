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
 * Uses the loader registry to fetch files, then runs the new
 * pipeline (fetching → parsing) and submits graph batches to the store.
 * Events are pushed into an EventChannel for async iteration.
 */

import { loaderRegistry } from '../runner/browser/loader/registry';
import type { LoaderInput } from '../runner/browser';
import { JobEventKind, JobPhase } from '../gen/opentrace/v1/agent_service';
import type { JobEvent } from '../gen/opentrace/v1/agent_service';
import type { GraphStore } from '../store/types';
import { EventChannel } from './eventChannel';
import type { JobMessage, JobService, JobStream } from './types';
import { runPipeline, initParsers } from '@opentrace/components/pipeline';
import type { PipelinePhase, RepoTree } from '@opentrace/components/pipeline';
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

    const run = async () => {
      // 1. Initialize parsers
      channel.push({
        ...emptyEvent(),
        kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
        phase: JobPhase.JOB_PHASE_INITIALIZING,
        message: 'Initializing parsers',
      });
      await ensureParsers();
      channel.push({
        ...emptyEvent(),
        kind: JobEventKind.JOB_EVENT_KIND_STAGE_COMPLETE,
        phase: JobPhase.JOB_PHASE_INITIALIZING,
        message: 'Parsers ready',
      });

      if (cancelled) return;

      // 2. Fetch files via loader
      const loader = loaderRegistry.find((l) => l.canHandle(input));
      if (!loader) {
        throw new Error('No loader found for input');
      }

      if (cancelled) return;

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

      // 3. Run pipeline and submit graph data
      const ctx = {
        get cancelled() {
          return cancelled;
        },
      };
      const pipeline = runPipeline({ repo: repoTree }, ctx);
      let totalNodesCreated = 0;
      let totalRelsCreated = 0;
      let lastYieldTime = performance.now();

      for (const event of pipeline) {
        if (cancelled) break;

        // Submit graph data to store as it flows through
        if (event.nodes?.length || event.relationships?.length) {
          const result = await this.store.importBatch({
            nodes: (event.nodes ?? []).map((n) => ({
              id: n.id,
              type: n.type,
              name: n.name,
              properties: n.properties,
            })),
            relationships: (event.relationships ?? []).map((r) => ({
              id: r.id,
              type: r.type,
              source_id: r.source_id,
              target_id: r.target_id,
            })),
          });
          totalNodesCreated += result.nodes_created;
          totalRelsCreated += result.relationships_created;
        }

        // Map pipeline events to proto JobEvents
        switch (event.kind) {
          case 'stage_start':
            // Emit as progress to mark the stage active in the UI
            channel.push({
              ...emptyEvent(),
              kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
              phase: toProtoPhase(event.phase),
              message: event.message,
            });
            break;

          case 'stage_progress': {
            // Throttle progress events to avoid flooding the channel.
            // Only push if enough wall-clock time has elapsed or this is
            // the last item in the batch.
            const now = performance.now();
            const isLast = event.detail?.current === event.detail?.total;
            if (isLast || now - lastYieldTime >= 100) {
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
                      nodesCreated: totalNodesCreated,
                      relationshipsCreated: totalRelsCreated,
                    }
                  : undefined,
              });
              // Yield to let the UI repaint
              await new Promise((r) => setTimeout(r, 0));
              lastYieldTime = performance.now();
            }
            break;
          }

          case 'stage_stop':
            channel.push({
              ...emptyEvent(),
              kind: JobEventKind.JOB_EVENT_KIND_STAGE_COMPLETE,
              phase: toProtoPhase(event.phase),
              message: event.message,
            });
            // Yield at stage boundaries so the UI can repaint
            await new Promise((r) => setTimeout(r, 0));
            break;

          case 'done': {
            // Flush buffered writes to the store
            channel.push({
              ...emptyEvent(),
              kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
              phase: JobPhase.JOB_PHASE_SUBMITTING,
              message: `Persisting ${totalNodesCreated} nodes, ${totalRelsCreated} relationships`,
            });
            await this.store.flush();
            channel.push({
              ...emptyEvent(),
              kind: JobEventKind.JOB_EVENT_KIND_STAGE_COMPLETE,
              phase: JobPhase.JOB_PHASE_SUBMITTING,
              message: `Persisted ${totalNodesCreated} nodes, ${totalRelsCreated} relationships`,
            });

            // Emit GRAPH_READY so the UI transitions to 'persisted' state
            channel.push({
              ...emptyEvent(),
              kind: JobEventKind.JOB_EVENT_KIND_GRAPH_READY,
              result: {
                nodesCreated: totalNodesCreated,
                relationshipsCreated: totalRelsCreated,
                reposProcessed: 1,
              },
            });
            // Then emit DONE
            channel.push({
              ...emptyEvent(),
              kind: JobEventKind.JOB_EVENT_KIND_DONE,
              phase: JobPhase.JOB_PHASE_DONE,
              result: {
                nodesCreated: totalNodesCreated,
                relationshipsCreated: totalRelsCreated,
                reposProcessed: 1,
              },
            });
            break;
          }

          case 'error':
            channel.push({
              ...emptyEvent(),
              kind: JobEventKind.JOB_EVENT_KIND_ERROR,
              message: event.message,
              errors: event.errors ?? [event.message],
            });
            break;
        }
      }
    };

    // Fire-and-forget so the stream is returned immediately
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
