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

import { describe, it, expect, vi } from 'vitest';
import { JobEventKind, JobPhase } from '../../gen/opentrace/v1/agent_service';
import type { JobEvent } from '../../gen/opentrace/v1/agent_service';
import type { ServerGraphStore, IndexJobStatus } from '../../store/serverStore';
import { ServerJobService } from '../serverJobService';

/** Build a ServerGraphStore stub whose getIndexJob walks a scripted sequence. */
function makeStore(statuses: IndexJobStatus[]) {
  let i = 0;
  const startIndexJob = vi.fn().mockResolvedValue({
    jobId: 'job-1',
    status: 'running',
  });
  const getIndexJob = vi.fn(async () => {
    const s = statuses[Math.min(i, statuses.length - 1)];
    i++;
    return s;
  });
  return {
    store: { startIndexJob, getIndexJob } as unknown as ServerGraphStore,
    startIndexJob,
    getIndexJob,
  };
}

async function collect(stream: AsyncIterable<JobEvent>): Promise<JobEvent[]> {
  const events: JobEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

describe('ServerJobService', () => {
  it('streams progress then GRAPH_READY + DONE with parsed counts', async () => {
    const { store, startIndexJob } = makeStore([
      {
        jobId: 'job-1',
        status: 'running',
        lines: ['Scanning directory tree', 'Processing 10 files'],
        exitCode: null,
        error: null,
      },
      {
        jobId: 'job-1',
        status: 'done',
        lines: [
          'Scanning directory tree',
          'Processing 10 files',
          'Saved 42 nodes, 17 relationships',
        ],
        exitCode: 0,
        error: null,
      },
    ]);

    const svc = new ServerJobService(store, 1);
    const stream = await svc.startJob({
      type: 'index-repo',
      repoUrl: 'https://github.com/owner/repo',
      ref: 'main',
    });
    const events = await collect(stream);

    expect(startIndexJob).toHaveBeenCalledWith({
      pathOrUrl: 'https://github.com/owner/repo',
      ref: 'main',
      token: undefined,
    });

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain(JobEventKind.JOB_EVENT_KIND_PROGRESS);
    expect(kinds).toContain(JobEventKind.JOB_EVENT_KIND_GRAPH_READY);
    expect(kinds[kinds.length - 1]).toBe(JobEventKind.JOB_EVENT_KIND_DONE);

    const done = events[events.length - 1];
    expect(done.result?.nodesCreated).toBe(42);
    expect(done.result?.relationshipsCreated).toBe(17);

    // The "Scanning" line should have surfaced a fetching-phase progress event.
    const fetching = events.find(
      (e) =>
        e.kind === JobEventKind.JOB_EVENT_KIND_PROGRESS &&
        e.phase === JobPhase.JOB_PHASE_FETCHING,
    );
    expect(fetching).toBeDefined();
  });

  it('emits an ERROR event when the job fails', async () => {
    const { store } = makeStore([
      {
        jobId: 'job-1',
        status: 'error',
        lines: ['boom'],
        exitCode: 2,
        error: 'Indexer exited with code 2',
      },
    ]);
    const svc = new ServerJobService(store, 1);
    const stream = await svc.startJob({
      type: 'index-repo',
      repoUrl: 'https://github.com/o/r',
    });
    const events = await collect(stream);
    const last = events[events.length - 1];
    expect(last.kind).toBe(JobEventKind.JOB_EVENT_KIND_ERROR);
    expect(last.message).toContain('code 2');
  });

  it('rejects non-URL job types', async () => {
    const { store } = makeStore([]);
    const svc = new ServerJobService(store, 1);
    await expect(
      svc.startJob({
        type: 'index-directory',
        files: [] as unknown as FileList,
        name: 'x',
      }),
    ).rejects.toThrow(/URL only/);
  });

  it('propagates a start failure (e.g. 409 already running)', async () => {
    const startIndexJob = vi
      .fn()
      .mockRejectedValue(
        new Error('Server error 409: An index job is already running'),
      );
    const store = { startIndexJob } as unknown as ServerGraphStore;
    const svc = new ServerJobService(store, 1);
    await expect(
      svc.startJob({ type: 'index-repo', repoUrl: 'https://github.com/o/r' }),
    ).rejects.toThrow(/409/);
  });
});
