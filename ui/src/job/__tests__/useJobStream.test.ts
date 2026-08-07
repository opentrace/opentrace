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

// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useJobStream } from '../useJobStream';
import { EventChannel } from '../eventChannel';
import type { JobService, JobStream } from '../types';
import { JobEventKind, JobPhase, type JobEvent } from '../../gen/agent_service';

function makeEvent(overrides: Partial<JobEvent>): JobEvent {
  return {
    kind: JobEventKind.JOB_EVENT_KIND_UNSPECIFIED,
    phase: JobPhase.JOB_PHASE_UNSPECIFIED,
    message: '',
    result: undefined,
    errors: [],
    detail: undefined,
    nodes: [],
    relationships: [],
    ...overrides,
  };
}

/** A JobStream backed by an EventChannel, cancel() mirrors the real
 *  BrowserJobService behaviour (closeAndDrop). */
function makeStream(): { channel: EventChannel<JobEvent>; stream: JobStream } {
  const channel = new EventChannel<JobEvent>();
  const stream: JobStream = {
    [Symbol.asyncIterator]: () => channel[Symbol.asyncIterator](),
    cancel: () => channel.closeAndDrop(),
  };
  return { channel, stream };
}

const flush = () => act(async () => {});

describe('useJobStream', () => {
  it('drives state from stream events', async () => {
    const { channel, stream } = makeStream();
    const service: JobService = {
      startJob: vi.fn().mockResolvedValue(stream),
    };
    const { result } = renderHook(() => useJobStream(service));

    await act(async () => {
      await result.current.start({ type: 'index-repo', repoUrl: 'x' });
    });
    expect(result.current.state.status).toBe('running');

    channel.push(
      makeEvent({
        kind: JobEventKind.JOB_EVENT_KIND_DONE,
        result: { nodesCreated: 5, relationshipsCreated: 3, reposProcessed: 1 },
      }),
    );
    channel.close();
    await waitFor(() => expect(result.current.state.status).toBe('done'));
    expect(result.current.state.nodesCreated).toBe(5);
  });

  it('cancel() prevents buffered events from resurrecting the progress UI', async () => {
    const { channel, stream } = makeStream();
    const service: JobService = {
      startJob: vi.fn().mockResolvedValue(stream),
    };
    const { result } = renderHook(() => useJobStream(service));

    await act(async () => {
      await result.current.start({ type: 'index-repo', repoUrl: 'x' });
    });

    // Buffer events the consumer hasn't drained yet, then cancel.
    channel.push(
      makeEvent({
        kind: JobEventKind.JOB_EVENT_KIND_GRAPH_READY,
        result: { nodesCreated: 9, relationshipsCreated: 9, reposProcessed: 1 },
      }),
    );
    channel.push(makeEvent({ kind: JobEventKind.JOB_EVENT_KIND_DONE }));
    act(() => {
      result.current.cancel();
    });
    expect(result.current.state.status).toBe('idle');

    await flush();
    await flush();
    // Without closeAndDrop + generation guard, the buffered GRAPH_READY/DONE
    // would flip status back to 'persisted'/'done' after reset.
    expect(result.current.state.status).toBe('idle');
    expect(result.current.state.nodesCreated).toBe(0);
  });

  it("a superseded job's buffered deltas do not reach the new job's handlers", async () => {
    const first = makeStream();
    const second = makeStream();
    const service: JobService = {
      startJob: vi
        .fn()
        .mockResolvedValueOnce(first.stream)
        .mockResolvedValueOnce(second.stream),
    };
    const onGraphDelta = vi.fn();
    const { result } = renderHook(() =>
      useJobStream(service, { onGraphDelta }),
    );

    await act(async () => {
      await result.current.start({ type: 'index-repo', repoUrl: 'a' });
    });

    // Old job has undrained node batches buffered...
    first.channel.push(
      makeEvent({
        kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
        nodes: [{ id: 'old', type: 'File', name: 'old', propertiesJson: '' }],
      }),
    );

    // ...when a new job starts.
    await act(async () => {
      await result.current.start({ type: 'index-repo', repoUrl: 'b' });
    });
    await flush();
    await flush();

    // The old job's delta must not pollute the new live stream.
    expect(onGraphDelta).not.toHaveBeenCalled();

    // The new stream still works.
    second.channel.push(
      makeEvent({
        kind: JobEventKind.JOB_EVENT_KIND_PROGRESS,
        nodes: [{ id: 'new', type: 'File', name: 'new', propertiesJson: '' }],
      }),
    );
    await waitFor(() => expect(onGraphDelta).toHaveBeenCalledTimes(1));
    expect(onGraphDelta.mock.calls[0][0][0].id).toBe('new');
  });

  it("an old consume loop's exit does not clear the new stream's ref (new cancel still works)", async () => {
    const first = makeStream();
    const second = makeStream();
    const service: JobService = {
      startJob: vi
        .fn()
        .mockResolvedValueOnce(first.stream)
        .mockResolvedValueOnce(second.stream),
    };
    const { result } = renderHook(() => useJobStream(service));

    await act(async () => {
      await result.current.start({ type: 'index-repo', repoUrl: 'a' });
    });
    await act(async () => {
      await result.current.start({ type: 'index-repo', repoUrl: 'b' });
    });
    // Let the first (superseded) loop run its finally block.
    await flush();
    await flush();

    // If the old loop nulled streamRef, cancel() would be a no-op and the
    // second channel would stay open. closeAndDrop is idempotent, so probe
    // by pushing then cancelling: consumer must end without seeing events.
    const cancelSpy = vi.spyOn(second.stream, 'cancel');
    act(() => {
      result.current.cancel();
    });
    expect(cancelSpy).toHaveBeenCalled();
  });
});
