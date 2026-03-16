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
    fetchGraph: vi.fn().mockResolvedValue({ nodes: [], links: [] }),
    fetchStats: vi
      .fn()
      .mockResolvedValue({ total_nodes: 0, total_edges: 0, nodes_by_type: {} }),
    clearGraph: vi.fn().mockResolvedValue(undefined),
    importBatch: vi
      .fn()
      .mockResolvedValue({ nodes_created: 0, relationships_created: 0 }),
    storeSource: vi.fn(),
    fetchSource: vi.fn().mockResolvedValue(null),
    searchNodes: vi.fn().mockResolvedValue([]),
    listNodes: vi.fn().mockResolvedValue([]),
    getNode: vi.fn().mockResolvedValue(null),
    traverse: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as GraphStore;
}
