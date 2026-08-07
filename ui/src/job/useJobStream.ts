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

import { useCallback, useRef, useState, useEffect } from 'react';
import { JobEventKind, JobPhase } from '../gen/agent_service';
import type {
  JobResult,
  ProgressDetail,
  IndexedNode,
  IndexedRelationship,
} from '../gen/agent_service';
import type { JobMessage, JobService, JobStream } from './types';
import { isOomJobError } from './browserJobService';

/** Hooks for the live-build graph stream — the browser pipeline emits node /
 *  relationship batches inline with progress so the graph builds during index. */
export interface JobStreamHandlers {
  onGraphDelta?: (
    nodes: IndexedNode[],
    relationships: IndexedRelationship[],
  ) => void;
  onLiveEnd?: (opts?: { clear?: boolean; reload?: boolean }) => void;
}

export type StageStatus = 'pending' | 'active' | 'completed';

export interface StageState {
  status: StageStatus;
  current: number;
  total: number;
  message: string;
  fileName?: string;
  format?: 'count' | 'bytes';
}

export interface JobState {
  status: 'idle' | 'running' | 'persisted' | 'enriching' | 'done' | 'error';
  phase: JobPhase;
  message: string;
  detail: ProgressDetail;
  nodesCreated: number;
  relationshipsCreated: number;
  result: JobResult | null;
  error: string | null;
  stages: Partial<Record<JobPhase, StageState>>;
}

const EMPTY_DETAIL: ProgressDetail = {
  current: 0,
  total: 0,
  fileName: '',
  nodesCreated: 0,
  relationshipsCreated: 0,
};

const INITIAL_STATE: JobState = {
  status: 'idle',
  phase: JobPhase.JOB_PHASE_UNSPECIFIED,
  message: '',
  detail: EMPTY_DETAIL,
  nodesCreated: 0,
  relationshipsCreated: 0,
  result: null,
  error: null,
  stages: {},
};

export function useJobStream(
  jobService: JobService,
  handlers?: JobStreamHandlers,
) {
  const [state, setState] = useState<JobState>(INITIAL_STATE);
  const streamRef = useRef<JobStream | null>(null);
  // Generation counter guarding the consume loop. Bumped whenever the
  // current stream is superseded (start/attach/cancel/reset), so a stale
  // loop that is still draining buffered events from a dead job neither
  // applies them to React state / onGraphDelta nor clears a streamRef it
  // no longer owns.
  const generationRef = useRef(0);
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  /** Consume a JobStream: drive the React state machine from its
   *  events. Shared by `start` (new submissions) and `attach`
   *  (Fix #14 resume-after-reload). */
  const consumeStream = useCallback((stream: JobStream) => {
    const generation = ++generationRef.current;
    streamRef.current = stream;
    (async () => {
      try {
        for await (const event of stream) {
          // A newer stream (or cancel/reset) superseded this loop — stop
          // applying this job's events to shared state.
          if (generationRef.current !== generation) break;
          // Live-build: events carrying node/relationship batches feed the
          // building graph. A pure batch event (PROGRESS, no detail) has no
          // stage semantics — forward it and skip the switch.
          if (event.nodes.length || event.relationships.length) {
            handlersRef.current?.onGraphDelta?.(
              event.nodes,
              event.relationships,
            );
            if (
              event.kind === JobEventKind.JOB_EVENT_KIND_PROGRESS &&
              !event.detail
            ) {
              continue;
            }
          }
          switch (event.kind) {
            case JobEventKind.JOB_EVENT_KIND_PROGRESS: {
              const d = event.detail ?? EMPTY_DETAIL;
              setState((s) => {
                // Don't reopen a completed stage with new progress events
                // (e.g. enrichment batches fire "submitting" after parse already completed it)
                const existing = s.stages[event.phase];
                const stageUpdate =
                  existing?.status === 'completed'
                    ? {
                        ...existing,
                        current: d.current,
                        total: d.total,
                        message: event.message,
                      }
                    : {
                        status: 'active' as StageStatus,
                        current: d.current,
                        total: d.total,
                        message: event.message,
                        fileName: d.fileName || undefined,
                        ...(event.phase === JobPhase.JOB_PHASE_FETCHING
                          ? { format: 'bytes' as const }
                          : {}),
                      };
                return {
                  ...s,
                  // Keep "enriching" status during enrichment progress updates
                  status: s.status === 'enriching' ? 'enriching' : s.status,
                  phase: event.phase,
                  message: event.message,
                  detail: d,
                  nodesCreated: d.nodesCreated || s.nodesCreated,
                  relationshipsCreated:
                    d.relationshipsCreated || s.relationshipsCreated,
                  stages: { ...s.stages, [event.phase]: stageUpdate },
                };
              });
              break;
            }
            case JobEventKind.JOB_EVENT_KIND_STAGE_COMPLETE:
              setState((s) => ({
                ...s,
                stages: {
                  ...s.stages,
                  [event.phase]: {
                    ...s.stages[event.phase],
                    status: 'completed' as StageStatus,
                    message: event.message,
                  },
                },
              }));
              break;
            case JobEventKind.JOB_EVENT_KIND_GRAPH_READY:
              handlersRef.current?.onLiveEnd?.();
              setState((s) => ({
                ...s,
                status: 'persisted',
                nodesCreated: event.result?.nodesCreated ?? s.nodesCreated,
                relationshipsCreated:
                  event.result?.relationshipsCreated ?? s.relationshipsCreated,
                result: event.result ?? null,
              }));
              break;
            case JobEventKind.JOB_EVENT_KIND_DONE:
              setState((s) => {
                // Mark all remaining active stages as completed
                const finalStages = { ...s.stages };
                for (const key of Object.keys(
                  finalStages,
                ) as unknown as JobPhase[]) {
                  if (finalStages[key]?.status === 'active') {
                    finalStages[key] = {
                      ...finalStages[key]!,
                      status: 'completed',
                    };
                  }
                }
                return {
                  ...s,
                  status: 'done',
                  phase: JobPhase.JOB_PHASE_DONE,
                  nodesCreated: event.result?.nodesCreated ?? s.nodesCreated,
                  relationshipsCreated:
                    event.result?.relationshipsCreated ??
                    s.relationshipsCreated,
                  result: event.result ?? null,
                  stages: finalStages,
                };
              });
              break;
            case JobEventKind.JOB_EVENT_KIND_ERROR:
              // A failed job may have persisted a partial graph before dying —
              // reload from the store so the canvas shows the authoritative
              // state rather than a stranded live fragment. EXCEPT on OOM:
              // the WASM instance is likely corrupted and another store query
              // would crash the tab again.
              handlersRef.current?.onLiveEnd?.({
                reload: !isOomJobError(event.message),
              });
              setState((s) => {
                // Mark all remaining active stages as completed to stop spinners
                const finalStages = { ...s.stages };
                for (const key of Object.keys(
                  finalStages,
                ) as unknown as JobPhase[]) {
                  if (finalStages[key]?.status === 'active') {
                    finalStages[key] = {
                      ...finalStages[key]!,
                      status: 'completed',
                    };
                  }
                }
                return {
                  ...s,
                  status: 'error',
                  error: event.message,
                  stages: finalStages,
                };
              });
              break;
          }
        }
      } catch (err) {
        // Log stream errors — cancelled streams are expected, but other
        // errors (e.g. stack overflow) need to be visible for debugging
        console.error('[useJobStream] stream error:', err);
      } finally {
        // Only clear the ref if this loop still owns it — a superseded
        // loop finishing late must not null out the NEW stream's ref.
        if (generationRef.current === generation) {
          streamRef.current = null;
        }
      }
    })();
  }, []);

  const start = useCallback(
    async (message: JobMessage) => {
      // Supersede any running consume loop NOW — the new stream is only
      // created after an await, and the old loop must not pollute the new
      // job's state (or the live graph) in the meantime.
      generationRef.current++;
      streamRef.current?.cancel();
      setState({ ...INITIAL_STATE, status: 'running' });
      let stream: JobStream;
      try {
        stream = await jobService.startJob(message);
      } catch (err) {
        setState((s) => ({
          ...s,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        }));
        return;
      }
      consumeStream(stream);
    },
    [jobService, consumeStream],
  );

  /** Resume an already-running server-mode index job by id. Used by
   *  the SPA on mount when the agent reports an active job (Fix #14).
   *  No-op when the wired JobService doesn't implement
   *  `attachToServerIndexJob` (older code paths / in-browser mode). */
  const attach = useCallback(
    async (jobId: string) => {
      const svc = jobService as JobService & {
        attachToServerIndexJob?: (id: string) => Promise<JobStream>;
      };
      if (!svc.attachToServerIndexJob) return;
      generationRef.current++;
      streamRef.current?.cancel();
      setState({ ...INITIAL_STATE, status: 'running' });
      let stream: JobStream;
      try {
        stream = await svc.attachToServerIndexJob(jobId);
      } catch (err) {
        setState((s) => ({
          ...s,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        }));
        return;
      }
      consumeStream(stream);
    },
    [jobService, consumeStream],
  );

  const cancel = useCallback(() => {
    // Supersede the consume loop so buffered events from the cancelled job
    // can't resurrect the progress UI after the reset below.
    generationRef.current++;
    streamRef.current?.cancel();
    streamRef.current = null;
    handlersRef.current?.onLiveEnd?.({ clear: true });
    setState(INITIAL_STATE);
  }, []);

  /** Transition persisted → enriching (auto-minimize). No-op if already moved past persisted. */
  const minimize = useCallback(() => {
    setState((s) =>
      s.status === 'persisted' ? { ...s, status: 'enriching' } : s,
    );
  }, []);

  /** Return to idle state (dismiss completed job). */
  const reset = useCallback(() => {
    generationRef.current++;
    streamRef.current?.cancel();
    streamRef.current = null;
    handlersRef.current?.onLiveEnd?.({ clear: true });
    setState(INITIAL_STATE);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      generationRef.current++;
      streamRef.current?.cancel();
    };
  }, []);

  return { state, start, attach, cancel, minimize, reset };
}
