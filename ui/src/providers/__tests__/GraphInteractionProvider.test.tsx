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
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import React from 'react';
import type { GraphNode } from '@opentrace/components/utils';

// Drive the graph data / version / streaming flags from the test. isStreaming
// stays true so useCommunities never spawns a Louvain worker (jsdom has none).
const graphState = {
  graphData: { nodes: [] as GraphNode[], links: [] },
  graphVersion: 0,
  isStreaming: true,
  lastSearchQuery: '',
  stats: null,
  loadGraph: vi.fn(),
};
vi.mock('../GraphDataProvider', () => ({
  useGraph: () => graphState,
}));

import {
  GraphInteractionProvider,
  useGraphInteraction,
  type GraphInteractionState,
} from '../GraphInteractionProvider';

afterEach(() => {
  cleanup();
  localStorage.clear();
  graphState.graphData = { nodes: [], links: [] };
  graphState.graphVersion = 0;
  graphState.lastSearchQuery = '';
});

let ctx: GraphInteractionState;
function Probe() {
  // Capture the context for assertions. Assign in an effect (not during
  // render) so we don't reassign a module-scoped binding mid-render, which
  // the react-hooks/globals lint rule (correctly) forbids.
  const value = useGraphInteraction();
  React.useEffect(() => {
    ctx = value;
  });
  return null;
}

function renderProvider() {
  return render(
    React.createElement(
      GraphInteractionProvider,
      null,
      React.createElement(Probe),
    ),
  );
}

function variable(id: string, kind: string): GraphNode {
  return { id, name: id, type: 'Variable', properties: { kind } } as GraphNode;
}
function dependency(id: string, registry: string): GraphNode {
  return {
    id,
    name: id,
    type: 'Dependency',
    properties: { registry },
  } as GraphNode;
}

describe('GraphInteractionProvider default sub-type hiding', () => {
  it('hides Variable/Dependency sub-types present at the initial load', () => {
    graphState.graphData = { nodes: [variable('v1', 'const')], links: [] };
    graphState.graphVersion = 1;
    renderProvider();
    expect(ctx.hiddenNodeTypes.has('Variable')).toBe(true);
    expect(ctx.hiddenSubTypes.has('Variable:const')).toBe(true);
  });

  it('default-hides sub-types that stream in AFTER the skeleton commit (same graphVersion)', () => {
    // Skeleton commit: only one Variable kind known so far
    graphState.graphData = { nodes: [variable('v1', 'const')], links: [] };
    graphState.graphVersion = 1;
    const { rerender } = renderProvider();
    expect(ctx.hiddenSubTypes.has('Variable:const')).toBe(true);

    // Progressive pages stream in new sub-types without bumping the version
    graphState.graphData = {
      nodes: [
        variable('v1', 'const'),
        variable('v2', 'let'),
        dependency('d1', 'npm'),
      ],
      links: [],
    };
    rerender(
      React.createElement(
        GraphInteractionProvider,
        null,
        React.createElement(Probe),
      ),
    );
    expect(ctx.hiddenSubTypes.has('Variable:let')).toBe(true);
    expect(ctx.hiddenSubTypes.has('Dependency:npm')).toBe(true);
  });

  it('does not re-hide a sub-type the user unhid mid-stream', () => {
    graphState.graphData = { nodes: [variable('v1', 'const')], links: [] };
    graphState.graphVersion = 1;
    const { rerender } = renderProvider();
    expect(ctx.hiddenSubTypes.has('Variable:const')).toBe(true);

    // User explicitly unhides Variable:const
    act(() => {
      ctx.setHiddenSubTypes((prev) => {
        const next = new Set(prev);
        next.delete('Variable:const');
        return next;
      });
    });
    expect(ctx.hiddenSubTypes.has('Variable:const')).toBe(false);

    // More nodes stream in — including more of the unhidden sub-type and a
    // brand-new one. Only the new one gets default-hidden.
    graphState.graphData = {
      nodes: [
        variable('v1', 'const'),
        variable('v2', 'const'),
        variable('v3', 'global'),
      ],
      links: [],
    };
    rerender(
      React.createElement(
        GraphInteractionProvider,
        null,
        React.createElement(Probe),
      ),
    );
    expect(ctx.hiddenSubTypes.has('Variable:const')).toBe(false);
    expect(ctx.hiddenSubTypes.has('Variable:global')).toBe(true);
  });

  it('re-applies defaults on a new full load (fresh graphVersion)', () => {
    graphState.graphData = { nodes: [variable('v1', 'const')], links: [] };
    graphState.graphVersion = 1;
    const { rerender } = renderProvider();
    act(() => {
      ctx.setHiddenSubTypes((prev) => {
        const next = new Set(prev);
        next.delete('Variable:const');
        return next;
      });
    });
    expect(ctx.hiddenSubTypes.has('Variable:const')).toBe(false);

    // Repo switch / re-index: new full load bumps the version
    graphState.graphVersion = 2;
    rerender(
      React.createElement(
        GraphInteractionProvider,
        null,
        React.createElement(Probe),
      ),
    );
    expect(ctx.hiddenSubTypes.has('Variable:const')).toBe(true);
  });

  it('skips defaults for search loads (query set)', () => {
    graphState.graphData = { nodes: [variable('v1', 'const')], links: [] };
    graphState.graphVersion = 1;
    graphState.lastSearchQuery = 'foo';
    renderProvider();
    expect(ctx.hiddenSubTypes.has('Variable:const')).toBe(false);
    expect(ctx.hiddenNodeTypes.has('Variable')).toBe(false);
  });
});
