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
import { renderHook } from '@testing-library/react';
import React from 'react';

// Mock KuzuGraphStore and crossOriginIsolated
vi.mock('../kuzuStore', () => ({
  KuzuGraphStore: vi.fn().mockImplementation(() => ({
    fetchGraph: vi.fn().mockResolvedValue({ nodes: [], links: [] }),
    fetchStats: vi.fn().mockResolvedValue({
      total_nodes: 0,
      total_edges: 0,
      nodes_by_type: {},
    }),
    clearGraph: vi.fn().mockResolvedValue(undefined),
    importBatch: vi.fn().mockResolvedValue({
      nodes_created: 0,
      relationships_created: 0,
    }),
    storeSource: vi.fn(),
    fetchSource: vi.fn().mockResolvedValue(null),
    searchNodes: vi.fn().mockResolvedValue([]),
    listNodes: vi.fn().mockResolvedValue([]),
    getNode: vi.fn().mockResolvedValue(null),
    traverse: vi.fn().mockResolvedValue([]),
  })),
}));

// Must mock crossOriginIsolated before importing context
vi.stubGlobal('crossOriginIsolated', true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StoreContext', () => {
  it('useStore outside provider throws', async () => {
    // Dynamic import after mocks are set up
    const { useStore } = await import('../context');
    expect(() => {
      renderHook(() => useStore());
    }).toThrow('useStore() must be used within <StoreProvider>');
  });

  it('useStore inside provider returns store', async () => {
    const { useStore, StoreProvider } = await import('../context');
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(StoreProvider, null, children);

    const { result } = renderHook(() => useStore(), { wrapper });
    expect(result.current.store).toBeDefined();
    expect(typeof result.current.store.fetchGraph).toBe('function');
  });
});
