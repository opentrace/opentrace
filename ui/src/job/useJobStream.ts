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
import { JobEventKind, JobPhase } from '../gen/opentrace/v1/agent_service';
import type {
  JobResult,
  ProgressDetail,
} from '../gen/opentrace/v1/agent_service';
import type { JobMessage, JobService, JobStream } from './types';

export type StageStatus = 'pending' | 'active' | 'completed';

export interface StageState {
  status: StageStatus;
  current: number;
  total: number;
  message: string;
  fileName?: string;
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

export function useJobStream(jobService: JobService) {
  const [state, setState] = useState<JobState>(INITIAL_STATE);
  const streamRef = useRef<JobStream | null>(null);

  const start = useCallback(
    async (message: JobMessage) => {
      // Cancel any existing stream
      streamRef.current?.cancel();

      setState({
        ...INITIAL_STATE,
        status: 'running',
      });

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
      streamRef.current = stream;

      // Detached async loop — runs concurrently, setState drives re-renders
      (async () => {
        try {
          for await (const event of stream) {
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
                setState((s) => ({
                  ...s,
                  status: 'persisted',
                  nodesCreated: event.result?.nodesCreated ?? s.nodesCreated,
                  relationshipsCreated:
                    event.result?.relationshipsCreated ??
                    s.relationshipsCreated,
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
        } catch {
          // Stream was cancelled or errored — already handled by channel
        } finally {
          streamRef.current = null;
        }
      })();
    },
    [jobService],
  );

  const cancel = useCallback(() => {
    streamRef.current?.cancel();
    streamRef.current = null;
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
    streamRef.current?.cancel();
    streamRef.current = null;
    setState(INITIAL_STATE);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      streamRef.current?.cancel();
    };
  }, []);

  return { state, start, cancel, minimize, reset };
}
