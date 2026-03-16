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

// Mock the store module to return our mock store
const mockStore = createMockStore();
vi.mock('../../store', () => ({
  useStore: () => ({ store: mockStore }),
}));

import { useGraphData } from '../useGraphData';

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
});
