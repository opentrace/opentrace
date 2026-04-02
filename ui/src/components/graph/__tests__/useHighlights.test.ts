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
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import Graph from 'graphology';
import { useHighlights } from '../useHighlights';
import type { GraphNode, GraphLink, FilterState } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyFilter(): FilterState {
  return {
    hiddenNodeTypes: new Set(),
    hiddenLinkTypes: new Set(),
    hiddenSubTypes: new Set(),
    hiddenCommunities: new Set(),
  };
}

function makeGraph(): Graph {
  return new Graph();
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('useHighlights', () => {
  it('returns empty sets for an empty graph', () => {
    const graph = makeGraph();
    const { result } = renderHook(() =>
      useHighlights(graph, true, [], [], '', null, 1, emptyFilter()),
    );
    expect(result.current.highlightNodes.size).toBe(0);
    expect(result.current.highlightLinks.size).toBe(0);
    expect(result.current.labelNodes.size).toBe(0);
    expect(result.current.hopMap.size).toBe(0);
  });

  it('search query matches node names', () => {
    const graph = makeGraph();
    const nodes: GraphNode[] = [
      { id: 'n1', name: 'AuthService', type: 'Service' },
      { id: 'n2', name: 'UserRepo', type: 'Repository' },
      { id: 'n3', name: 'AuthMiddleware', type: 'Module' },
    ];
    const { result } = renderHook(() =>
      useHighlights(graph, true, nodes, [], 'auth', null, 1, emptyFilter()),
    );
    expect(result.current.highlightNodes.has('n1')).toBe(true);
    expect(result.current.highlightNodes.has('n3')).toBe(true);
    expect(result.current.highlightNodes.has('n2')).toBe(false);
  });

  it('search is case-insensitive', () => {
    const graph = makeGraph();
    const nodes: GraphNode[] = [
      { id: 'n1', name: 'AuthService', type: 'Service' },
    ];
    const { result } = renderHook(() =>
      useHighlights(
        graph,
        true,
        nodes,
        [],
        'AUTHSERVICE',
        null,
        1,
        emptyFilter(),
      ),
    );
    expect(result.current.highlightNodes.has('n1')).toBe(true);
    expect(result.current.labelNodes.has('n1')).toBe(true);
  });

  it('selected node highlights BFS neighborhood at depth 1', () => {
    const graph = makeGraph();
    const nodes: GraphNode[] = [
      { id: 'a', name: 'A', type: 'Service' },
      { id: 'b', name: 'B', type: 'Service' },
      { id: 'c', name: 'C', type: 'Service' },
    ];
    const links: GraphLink[] = [
      { source: 'a', target: 'b', label: 'CALLS' },
      { source: 'b', target: 'c', label: 'CALLS' },
    ];
    const { result } = renderHook(() =>
      useHighlights(graph, true, nodes, links, '', 'a', 1, emptyFilter()),
    );
    // a and b should be highlighted; c is 2 hops away
    expect(result.current.highlightNodes.has('a')).toBe(true);
    expect(result.current.highlightNodes.has('b')).toBe(true);
    expect(result.current.highlightNodes.has('c')).toBe(false);
    expect(result.current.hopMap.get('a')).toBe(0);
    expect(result.current.hopMap.get('b')).toBe(1);
  });

  it('selected node highlights BFS neighborhood at depth 2', () => {
    const graph = makeGraph();
    const nodes: GraphNode[] = [
      { id: 'a', name: 'A', type: 'Service' },
      { id: 'b', name: 'B', type: 'Service' },
      { id: 'c', name: 'C', type: 'Service' },
      { id: 'd', name: 'D', type: 'Service' },
    ];
    const links: GraphLink[] = [
      { source: 'a', target: 'b', label: 'CALLS' },
      { source: 'b', target: 'c', label: 'CALLS' },
      { source: 'c', target: 'd', label: 'CALLS' },
    ];
    const { result } = renderHook(() =>
      useHighlights(graph, true, nodes, links, '', 'a', 2, emptyFilter()),
    );
    expect(result.current.highlightNodes.has('a')).toBe(true);
    expect(result.current.highlightNodes.has('b')).toBe(true);
    expect(result.current.highlightNodes.has('c')).toBe(true);
    expect(result.current.highlightNodes.has('d')).toBe(false);
    expect(result.current.hopMap.get('c')).toBe(2);
  });

  it('label nodes limited to min(2, hops)', () => {
    const graph = makeGraph();
    const nodes: GraphNode[] = [
      { id: 'a', name: 'A', type: 'Service' },
      { id: 'b', name: 'B', type: 'Service' },
      { id: 'c', name: 'C', type: 'Service' },
      { id: 'd', name: 'D', type: 'Service' },
    ];
    const links: GraphLink[] = [
      { source: 'a', target: 'b', label: 'CALLS' },
      { source: 'b', target: 'c', label: 'CALLS' },
      { source: 'c', target: 'd', label: 'CALLS' },
    ];
    // hops=3, so labelDepth = min(2, 3) = 2
    const { result } = renderHook(() =>
      useHighlights(graph, true, nodes, links, '', 'a', 3, emptyFilter()),
    );
    // d is at hop 3 — highlighted but NOT labeled
    expect(result.current.highlightNodes.has('d')).toBe(true);
    expect(result.current.labelNodes.has('d')).toBe(false);
    // b is at hop 1 — labeled
    expect(result.current.labelNodes.has('b')).toBe(true);
    // c is at hop 2 — labeled (depth < labelDepth means depth 0 and 1 add labels)
    // Actually the code does `if (depth < labelDepth)` so depth=0 and depth=1 add labels
    // c is discovered at depth=1 (from b's perspective) — wait, let me re-check:
    // depth=0 frontier=[a], discovers b at depth+1=1, depth<2 so label b
    // depth=1 frontier=[b], discovers c at depth+1=2, depth<2 is false for depth=1? No, depth=1 < 2 is true
    // depth=2 frontier=[c], discovers d at depth+1=3, depth<2 is false for depth=2
    expect(result.current.labelNodes.has('c')).toBe(true);
  });

  it('filter state excludes hidden link types from adjacency', () => {
    const graph = makeGraph();
    const nodes: GraphNode[] = [
      { id: 'a', name: 'A', type: 'Service' },
      { id: 'b', name: 'B', type: 'Service' },
      { id: 'c', name: 'C', type: 'Service' },
    ];
    const links: GraphLink[] = [
      { source: 'a', target: 'b', label: 'CALLS' },
      { source: 'a', target: 'c', label: 'DEFINES' },
    ];
    const filter = emptyFilter();
    filter.hiddenLinkTypes.add('DEFINES');

    const { result } = renderHook(() =>
      useHighlights(graph, true, nodes, links, '', 'a', 1, filter),
    );
    // b reachable via CALLS, c not reachable because DEFINES is hidden
    expect(result.current.highlightNodes.has('b')).toBe(true);
    expect(result.current.highlightNodes.has('c')).toBe(false);
  });
});
