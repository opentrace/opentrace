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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useCommunities } from '../useCommunities';
import type { GraphNode, GraphLink, LayoutConfig } from '../types';

// ─── Worker Mock ─────────────────────────────────────────────────────

/**
 * Mock Worker that synchronously runs Louvain inline (same logic as the worker).
 * This avoids needing real Web Worker support in jsdom.
 */
class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;

  postMessage(data: unknown): void {
    // Dynamically import graphology + louvain to compute assignments
    // Use a microtask to simulate async behavior
    Promise.resolve().then(async () => {
      try {
        const { UndirectedGraph } = await import('graphology');
        const { default: louvain } =
          await import('graphology-communities-louvain');

        const { nodes, links, resolution } = data as {
          nodes: { id: string; type: string }[];
          links: { source: string; target: string; label: string }[];
          resolution: number;
        };

        const tempGraph = new UndirectedGraph();
        const nodeIdSet = new Set<string>();
        for (const node of nodes) {
          if (!nodeIdSet.has(node.id)) {
            tempGraph.addNode(node.id);
            nodeIdSet.add(node.id);
          }
        }
        for (const link of links) {
          if (link.source === link.target) continue;
          if (!nodeIdSet.has(link.source) || !nodeIdSet.has(link.target))
            continue;
          if (tempGraph.hasEdge(link.source, link.target)) {
            const w =
              (tempGraph.getEdgeAttribute(
                link.source,
                link.target,
                'weight',
              ) as number) ?? 1;
            tempGraph.setEdgeAttribute(
              link.source,
              link.target,
              'weight',
              w + 1,
            );
          } else {
            tempGraph.addEdge(link.source, link.target, { weight: 1 });
          }
        }

        const assignments = louvain(tempGraph, {
          resolution,
          getEdgeWeight: 'weight',
        });

        this.onmessage?.({ data: { assignments } } as MessageEvent);
      } catch (err) {
        this.onerror?.({ message: String(err) } as ErrorEvent);
      }
    });
  }

  terminate(): void {
    // noop
  }
}

beforeEach(() => {
  vi.stubGlobal('Worker', MockWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Helpers ──────────────────────────────────────────────────────────

function makeMockConfig(overrides: Partial<LayoutConfig> = {}): LayoutConfig {
  return {
    linkDistance: 200,
    chargeStrength: -200,
    simulationTicks: 80,
    clusterStrength: 0.3,
    clusterTicks: 40,
    clusterSeparation: 2.5,
    fa2Enabled: false,
    fa2Gravity: 0.1,
    fa2ScalingRatio: 30,
    fa2SlowDown: 2,
    fa2BarnesHutThreshold: 300,
    fa2BarnesHutTheta: 0.5,
    fa2StrongGravity: false,
    fa2LinLogMode: true,
    fa2OutboundAttraction: true,
    fa2AdjustSizes: true,
    fa2Duration: 3000,
    noverlapMaxNodes: 3000,
    noverlapMaxIterations: 50,
    noverlapRatio: 1.5,
    noverlapMargin: 10,
    noverlapExpansion: 1.5,
    noverlapCommunityIterations: 20,
    louvainResolution: 1.0,
    edgeProgramThreshold: 50000,
    layoutEdgeType: 'DEFINED_IN',
    structuralTypes: ['Repository', 'Directory'],
    getNodeColor: () => '#aaa',
    getLinkColor: () => '#666',
    buildCommunityColorMap: (assignments) => {
      const ids = [...new Set(Object.values(assignments))];
      return new Map(ids.map((cid, i) => [cid, `#color${i}`]));
    },
    buildCommunityNames: (assignments) => {
      const ids = [...new Set(Object.values(assignments))];
      return new Map(ids.map((cid) => [cid, `Community ${cid}`]));
    },
    getCommunityColor: (assignments, colorMap, nodeId) =>
      colorMap.get(assignments[nodeId]) ?? '#default',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('useCommunities', () => {
  it('returns empty data for empty nodes', () => {
    const config = makeMockConfig();
    const { result } = renderHook(() => useCommunities([], [], config));

    expect(result.current.count).toBe(0);
    expect(Object.keys(result.current.assignments)).toHaveLength(0);
    expect(result.current.colorMap.size).toBe(0);
    expect(result.current.names.size).toBe(0);
  });

  it('detects communities from disconnected components', async () => {
    const config = makeMockConfig();
    const nodes: GraphNode[] = [
      { id: 'a', name: 'A', type: 'Service' },
      { id: 'b', name: 'B', type: 'Service' },
      { id: 'c', name: 'C', type: 'Service' },
      { id: 'd', name: 'D', type: 'Service' },
    ];
    const links: GraphLink[] = [
      { source: 'a', target: 'b', label: 'CALLS' },
      { source: 'c', target: 'd', label: 'CALLS' },
    ];

    const { result } = renderHook(() => useCommunities(nodes, links, config));

    await waitFor(() => {
      expect(result.current.count).toBeGreaterThanOrEqual(2);
    });

    expect(result.current.assignments['a']).toBe(
      result.current.assignments['b'],
    );
    expect(result.current.assignments['c']).toBe(
      result.current.assignments['d'],
    );
    expect(result.current.assignments['a']).not.toBe(
      result.current.assignments['c'],
    );
  });

  it('returns correct count matching unique community IDs', async () => {
    const config = makeMockConfig();
    const nodes: GraphNode[] = [
      { id: 'a', name: 'A', type: 'Service' },
      { id: 'b', name: 'B', type: 'Service' },
      { id: 'c', name: 'C', type: 'Service' },
    ];
    const links: GraphLink[] = [{ source: 'a', target: 'b', label: 'CALLS' }];

    const { result } = renderHook(() => useCommunities(nodes, links, config));

    await waitFor(() => {
      expect(result.current.count).toBeGreaterThan(0);
    });

    const uniqueIds = new Set(Object.values(result.current.assignments));
    expect(result.current.count).toBe(uniqueIds.size);
  });

  it('uses layoutConfig callbacks for color and naming', async () => {
    const config = makeMockConfig({
      buildCommunityColorMap: (assignments) => {
        const ids = [...new Set(Object.values(assignments))];
        return new Map(ids.map((cid) => [cid, `custom-${cid}`]));
      },
      buildCommunityNames: (assignments) => {
        const ids = [...new Set(Object.values(assignments))];
        return new Map(ids.map((cid) => [cid, `Group-${cid}`]));
      },
    });
    const nodes: GraphNode[] = [
      { id: 'a', name: 'A', type: 'Service' },
      { id: 'b', name: 'B', type: 'Service' },
    ];
    const links: GraphLink[] = [{ source: 'a', target: 'b', label: 'CALLS' }];

    const { result } = renderHook(() => useCommunities(nodes, links, config));

    await waitFor(() => {
      expect(result.current.count).toBeGreaterThan(0);
    });

    for (const [cid, color] of result.current.colorMap) {
      expect(color).toBe(`custom-${cid}`);
    }
    for (const [cid, name] of result.current.names) {
      expect(name).toBe(`Group-${cid}`);
    }
  });
});
