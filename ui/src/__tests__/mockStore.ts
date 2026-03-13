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
