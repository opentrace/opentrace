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
 * Server-mode job service.
 *
 * When the UI is connected to an `opentrace serve` instance, indexing must
 * run on the server (the browser pipeline's writes are no-ops against a
 * ServerGraphStore). This service POSTs to `/api/index`, polls the job
 * status, and translates the server's stdout lines into the same JobEvent
 * stream the browser pipeline emits — so IndexingProgress and useJobStream
 * work unchanged.
 *
 * Only URL-based indexing is supported in server mode; directory/import jobs
 * can't be streamed to a remote server and are rejected.
 */

import { JobEventKind, JobPhase } from '../gen/opentrace/v1/agent_service';
import type { JobEvent, JobResult } from '../gen/opentrace/v1/agent_service';
import type { ServerGraphStore } from '../store/serverStore';
import { EventChannel } from './eventChannel';
import type { JobMessage, JobService, JobStream } from './types';

/** Poll interval for the index status endpoint. */
const POLL_INTERVAL_MS = 800;

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

/** Map a CLI stdout line to a coarse pipeline phase, or null if unknown. */
function phaseForLine(line: string): JobPhase | null {
  const l = line.toLowerCase();
  if (l.includes('clon') || l.includes('fetch')) {
    return JobPhase.JOB_PHASE_FETCHING;
  }
  if (l.includes('scan')) return JobPhase.JOB_PHASE_FETCHING;
  if (l.includes('process')) return JobPhase.JOB_PHASE_PARSING;
  if (l.includes('resolv')) return JobPhase.JOB_PHASE_RESOLVING;
  if (l.includes('saved') || l.includes('submit') || l.includes('persist')) {
    return JobPhase.JOB_PHASE_SUBMITTING;
  }
  return null;
}

/** Extract `(nodes, relationships)` from a summary line, if present. */
function parseCounts(line: string): { nodes: number; rels: number } | null {
  const m = line.match(/(\d+)\s+nodes.*?(\d+)\s+relationships/i);
  if (!m) return null;
  return { nodes: Number(m[1]), rels: Number(m[2]) };
}

export class ServerJobService implements JobService {
  private readonly store: ServerGraphStore;
  private readonly pollIntervalMs: number;

  constructor(
    store: ServerGraphStore,
    pollIntervalMs: number = POLL_INTERVAL_MS,
  ) {
    this.store = store;
    this.pollIntervalMs = pollIntervalMs;
  }

  async startJob(message: JobMessage): Promise<JobStream> {
    if (message.type !== 'index-repo' && message.type !== 'reindex-repo') {
      throw new Error(
        `Server mode supports indexing repositories by URL only (got "${message.type}"). ` +
          `Index a local directory or import a file in browser mode instead.`,
      );
    }

    const channel = new EventChannel<JobEvent>();
    let cancelled = false;

    // Start the job up front so a 4xx (e.g. 409 already-running) surfaces as
    // a rejected promise that useJobStream renders as an error.
    const { jobId } = await this.store.startIndexJob({
      pathOrUrl: message.repoUrl,
      ref: message.ref,
      token: message.token,
    });

    const run = async () => {
      let seen = 0;
      let currentPhase: JobPhase | null = null;
      let nodesCreated = 0;
      let relationshipsCreated = 0;

      const pushProgress = (phase: JobPhase, msg: string) => {
        channel.push({
          ...emptyEvent(),
          kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
          phase,
          message: msg,
          detail: {
            current: 0,
            total: 0,
            fileName: '',
            nodesCreated,
            relationshipsCreated,
          },
        });
      };

      const consumeLines = (lines: string[]) => {
        for (let i = seen; i < lines.length; i++) {
          const line = lines[i];
          const counts = parseCounts(line);
          if (counts) {
            nodesCreated = counts.nodes;
            relationshipsCreated = counts.rels;
          }
          const phase = phaseForLine(line);
          if (phase !== null && phase !== currentPhase) {
            if (currentPhase !== null) {
              channel.push({
                ...emptyEvent(),
                kind: JobEventKind.JOB_EVENT_KIND_STAGE_COMPLETE,
                phase: currentPhase,
                message: '',
              });
            }
            currentPhase = phase;
            pushProgress(phase, line);
          } else if (currentPhase !== null) {
            pushProgress(currentPhase, line);
          }
        }
        seen = lines.length;
      };

      try {
        while (true) {
          if (cancelled) {
            channel.close();
            return;
          }
          const status = await this.store.getIndexJob(jobId);
          consumeLines(status.lines);

          if (status.status === 'done') {
            const result: JobResult = {
              nodesCreated,
              relationshipsCreated,
              reposProcessed: 1,
            };
            channel.push({
              ...emptyEvent(),
              kind: JobEventKind.JOB_EVENT_KIND_GRAPH_READY,
              result,
            });
            channel.push({
              ...emptyEvent(),
              kind: JobEventKind.JOB_EVENT_KIND_DONE,
              phase: JobPhase.JOB_PHASE_DONE,
              result,
            });
            channel.close();
            return;
          }

          if (status.status === 'error') {
            const msg =
              status.error ||
              status.lines[status.lines.length - 1] ||
              'Indexing failed';
            channel.push({
              ...emptyEvent(),
              kind: JobEventKind.JOB_EVENT_KIND_ERROR,
              message: msg,
              errors: [msg],
            });
            channel.close();
            return;
          }

          await new Promise((r) => setTimeout(r, this.pollIntervalMs));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        channel.push({
          ...emptyEvent(),
          kind: JobEventKind.JOB_EVENT_KIND_ERROR,
          message: msg,
          errors: [msg],
        });
        channel.close();
      }
    };

    void run();

    const stream: JobStream = {
      [Symbol.asyncIterator]: () => channel[Symbol.asyncIterator](),
      cancel: () => {
        // Stops UI polling. The server subprocess keeps running to completion;
        // the next connect/reload will reflect whatever it produced.
        cancelled = true;
        channel.close();
      },
    };
    return stream;
  }
}
