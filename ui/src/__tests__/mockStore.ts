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

import { vi } from 'vitest';
import type { GraphStore } from '../store/types';

export function createMockStore(
  overrides?: Partial<Record<keyof GraphStore, unknown>>,
): GraphStore {
  return {
    hasData: vi.fn().mockReturnValue(false),
    fetchGraph: vi.fn().mockResolvedValue({ nodes: [], links: [] }),
    fetchStats: vi
      .fn()
      .mockResolvedValue({ total_nodes: 0, total_edges: 0, nodes_by_type: {} }),
    clearGraph: vi.fn().mockResolvedValue(undefined),
    importBatch: vi
      .fn()
      .mockResolvedValue({ nodes_created: 0, relationships_created: 0 }),
    flush: vi.fn().mockResolvedValue(undefined),
    storeSource: vi.fn(),
    fetchSource: vi.fn().mockResolvedValue(null),
    searchNodes: vi.fn().mockResolvedValue([]),
    listNodes: vi.fn().mockResolvedValue([]),
    getNode: vi.fn().mockResolvedValue(null),
    traverse: vi.fn().mockResolvedValue([]),
    fetchMetadata: vi.fn().mockResolvedValue([]),
    findPath: vi.fn().mockResolvedValue({ path: null, length: null }),
    findOrphans: vi.fn().mockResolvedValue({ orphans: [], count: 0 }),
    findViaRelationshipToType: vi
      .fn()
      .mockResolvedValue({ pairs: [], count: 0 }),
    countBy: vi
      .fn()
      .mockResolvedValue({ count: 0, node_type: 'Function', scope: 'global' }),
    overview: vi.fn().mockResolvedValue({
      counts_by_type: {},
      top_concepts: [],
      recently_updated: [],
      vault_scope: null,
    }),
    search: vi.fn().mockResolvedValue({ hits: [], count: 0, query: '' }),
    provenance: vi.fn().mockResolvedValue({
      node_id: '',
      node_type: null,
      kind: 'unknown',
      code: null,
      wiki: null,
    }),
    grep: vi.fn().mockResolvedValue({
      matches: [],
      count: 0,
      scope: '',
      mode: 'error',
      error: 'mock',
    }),
    ...overrides,
  } as GraphStore;
}
