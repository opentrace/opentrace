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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { createMockStore } from '../../__tests__/mockStore';

// Mock the store module to return our mock store.
// hasData() returns true so the hook fetches on mount (simulates existing data).
const mockStore = createMockStore({ hasData: () => true });
vi.mock('../../store', () => ({
  useStore: () => ({ store: mockStore }),
}));

// Mock the device helper so we can drive the mobile node cap deterministically
// (real detection returns false in jsdom, and the real cap is 20k — too many to
// stream in a test).
vi.mock('../../config/device', () => ({
  isConstrainedDevice: vi.fn(() => false),
  MOBILE_LIVE_NODE_CAP: 3,
}));

import { useGraphData } from '../useGraphData';
import { isConstrainedDevice } from '../../config/device';

const node = (id: string) => ({ id, name: id, type: 'Function' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockStore.fetchGraph).mockResolvedValue({ nodes: [], links: [] });
  vi.mocked(mockStore.fetchStats).mockResolvedValue({
    total_nodes: 0,
    total_edges: 0,
    nodes_by_type: {},
  });
});

describe('useGraphData', () => {
  it('starts with loading=true and empty data', () => {
    const { result } = renderHook(() => useGraphData());
    // Initial state before fetchGraph resolves
    expect(result.current.loading).toBe(true);
    expect(result.current.graphData.nodes).toEqual([]);
    expect(result.current.graphData.links).toEqual([]);
  });

  it('sets loading=false and populates data after fetch', async () => {
    const nodes = [{ id: 'n1', name: 'Auth', type: 'Repository' }];
    const links = [{ source: 'n1', target: 'n2', label: 'CALLS' }];
    vi.mocked(mockStore.fetchGraph).mockResolvedValue({ nodes, links });

    const { result } = renderHook(() => useGraphData());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.graphData.nodes).toEqual(nodes);
    expect(result.current.graphData.links).toEqual(links);
    expect(result.current.error).toBeNull();
  });

  it('sets error on fetch failure', async () => {
    vi.mocked(mockStore.fetchGraph).mockRejectedValue(
      new Error('Connection failed'),
    );

    const { result } = renderHook(() => useGraphData());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe('Connection failed');
  });

  it('loadGraph passes query and hops to store', async () => {
    const { result } = renderHook(() => useGraphData());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.loadGraph('auth', 2);
    });

    expect(mockStore.fetchGraph).toHaveBeenCalledWith('auth', 2);
  });

  it('ignores a stale load that resolves after a newer one', async () => {
    type GD = Awaited<ReturnType<typeof mockStore.fetchGraph>>;
    const { result } = renderHook(() => useGraphData());
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Two overlapping loads with manually controlled resolution.
    let resolveA!: (v: GD) => void;
    let resolveB!: (v: GD) => void;
    const pA = new Promise<GD>((r) => {
      resolveA = r;
    });
    const pB = new Promise<GD>((r) => {
      resolveB = r;
    });
    vi.mocked(mockStore.fetchGraph)
      .mockReturnValueOnce(pA)
      .mockReturnValueOnce(pB);

    let loadA!: Promise<void>;
    let loadB!: Promise<void>;
    act(() => {
      loadA = result.current.loadGraph('A');
      loadB = result.current.loadGraph('B');
    });

    // Newer load (B) resolves first, then the stale (A) resolves last.
    await act(async () => {
      resolveB({ nodes: [{ id: 'B', name: 'B', type: 'X' }], links: [] });
      await loadB;
      resolveA({ nodes: [{ id: 'A', name: 'A', type: 'X' }], links: [] });
      await loadA;
    });

    // The stale A result must not clobber B.
    expect(result.current.graphData.nodes).toEqual([
      { id: 'B', name: 'B', type: 'X' },
    ]);
    expect(result.current.lastSearchQuery).toBe('B');
  });

  describe('live-stream mobile node cap', () => {
    it('streams every node on an unconstrained (desktop) device', async () => {
      vi.mocked(isConstrainedDevice).mockReturnValue(false);
      const { result } = renderHook(() => useGraphData());
      act(() => {
        result.current.startLiveStream();
        result.current.pushLiveBatch(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          [node('a'), node('b'), node('c'), node('d'), node('e')] as any,
          [],
        );
      });
      await waitFor(() => {
        expect(result.current.graphData.nodes.length).toBe(5);
      });
    });

    it('caps the live working set at MOBILE_LIVE_NODE_CAP on a constrained device', async () => {
      vi.mocked(isConstrainedDevice).mockReturnValue(true);
      const { result } = renderHook(() => useGraphData());
      act(() => {
        result.current.startLiveStream();
        result.current.pushLiveBatch(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          [node('a'), node('b'), node('c'), node('d'), node('e')] as any,
          [],
        );
      });
      // Cap is mocked to 3 — only the first 3 nodes reach React state.
      await waitFor(() => {
        expect(result.current.graphData.nodes.length).toBe(3);
      });
      expect(result.current.graphData.nodes.map((n) => n.id)).toEqual([
        'a',
        'b',
        'c',
      ]);
    });

    it('drops links whose endpoint was capped out (no unbounded deferral)', async () => {
      vi.mocked(isConstrainedDevice).mockReturnValue(true);
      const { result } = renderHook(() => useGraphData());
      act(() => {
        result.current.startLiveStream();
        result.current.pushLiveBatch(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          [node('a'), node('b'), node('c'), node('d')] as any,
          // a→b both kept; c→d has d capped out → dropped, not deferred.
          [
            { sourceId: 'a', targetId: 'b', type: 'CALLS' },
            { sourceId: 'c', targetId: 'd', type: 'CALLS' },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ] as any,
        );
      });
      await waitFor(() => {
        expect(result.current.graphData.nodes.length).toBe(3);
      });
      expect(result.current.graphData.links.length).toBe(1);
      expect(result.current.graphData.links[0]).toMatchObject({
        source: 'a',
        target: 'b',
      });
    });
  });
});
