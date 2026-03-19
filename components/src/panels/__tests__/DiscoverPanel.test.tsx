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
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import DiscoverPanel from '../DiscoverPanel';
import type { DiscoverPanelProps, TreeNodeData } from '../types';

afterEach(cleanup);

// react-window needs a sized container — mock offsetHeight/offsetWidth
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    value: 600,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    value: 300,
  });
});

const repoNode: TreeNodeData = {
  id: 'repo-1',
  type: 'Repository',
  name: 'my-repo',
};

const dirNode: TreeNodeData = {
  id: 'dir-1',
  type: 'Directory',
  name: 'src',
};

const fileNode: TreeNodeData = {
  id: 'file-1',
  type: 'File',
  name: 'index.ts',
};

const funcNode: TreeNodeData = {
  id: 'func-1',
  type: 'Function',
  name: 'main',
};

function makeProps(
  overrides?: Partial<DiscoverPanelProps>,
): DiscoverPanelProps {
  return {
    roots: [repoNode],
    childrenMap: new Map([
      ['repo-1', [dirNode]],
      ['dir-1', [fileNode]],
    ]),
    expanded: new Set(['repo-1', 'dir-1']),
    onToggleExpand: vi.fn(),
    onSelectNode: vi.fn(),
    ...overrides,
  };
}

describe('DiscoverPanel', () => {
  it('renders empty state when no roots', () => {
    const { getByText } = render(
      React.createElement(DiscoverPanel, makeProps({ roots: [] })),
    );
    expect(getByText('No repositories indexed yet.')).toBeDefined();
  });

  it('renders tree rows for expanded nodes', () => {
    const { getByText } = render(
      React.createElement(DiscoverPanel, makeProps()),
    );
    expect(getByText('my-repo')).toBeDefined();
    expect(getByText('src')).toBeDefined();
    expect(getByText('index.ts')).toBeDefined();
  });

  it('fires onToggleExpand when expand button is clicked', () => {
    const onToggleExpand = vi.fn();
    const { container } = render(
      React.createElement(
        DiscoverPanel,
        makeProps({
          expanded: new Set(), // nothing expanded
          onToggleExpand,
        }),
      ),
    );
    const expandBtns = container.querySelectorAll('.filter-expand-btn');
    expect(expandBtns.length).toBeGreaterThan(0);
    fireEvent.click(expandBtns[0]);
    expect(onToggleExpand).toHaveBeenCalledWith('repo-1');
  });

  it('fires onSelectNode when a node name is clicked', () => {
    const onSelectNode = vi.fn();
    const { getByText } = render(
      React.createElement(DiscoverPanel, makeProps({ onSelectNode })),
    );
    fireEvent.click(getByText('my-repo'));
    expect(onSelectNode).toHaveBeenCalledWith('repo-1');
  });

  it('highlights the selected node', () => {
    const { container } = render(
      React.createElement(
        DiscoverPanel,
        makeProps({ selectedNodeId: 'repo-1' }),
      ),
    );
    const selectedRow = container.querySelector('.discover-tree-row--selected');
    expect(selectedRow).not.toBeNull();
  });

  it('does not render children of collapsed nodes', () => {
    const { queryByText } = render(
      React.createElement(
        DiscoverPanel,
        makeProps({ expanded: new Set() }), // nothing expanded
      ),
    );
    // Only root should be visible
    expect(queryByText('my-repo')).not.toBeNull();
    expect(queryByText('src')).toBeNull();
    expect(queryByText('index.ts')).toBeNull();
  });

  it('shows non-expandable nodes with a spacer instead of expand button', () => {
    // funcNode (Function) is not in EXPANDABLE_TYPES, so it gets a spacer
    const { container } = render(
      React.createElement(
        DiscoverPanel,
        makeProps({
          roots: [funcNode],
          childrenMap: new Map(),
          expanded: new Set(),
        }),
      ),
    );
    const spacers = container.querySelectorAll('.filter-expand-spacer');
    expect(spacers.length).toBeGreaterThan(0);
  });

  describe('filter', () => {
    it('renders filter input', () => {
      const { container } = render(
        React.createElement(DiscoverPanel, makeProps()),
      );
      const input = container.querySelector('.discover-filter-input');
      expect(input).not.toBeNull();
    });

    it('filters tree by text input', () => {
      const { container, queryByText } = render(
        React.createElement(DiscoverPanel, makeProps()),
      );
      const input = container.querySelector('.discover-filter-input')!;
      fireEvent.change(input, { target: { value: 'index' } });
      // 'index.ts' should still be visible, 'my-repo' too (ancestor match)
      expect(queryByText('index.ts')).not.toBeNull();
    });

    it('shows "No matches" when filter matches nothing', () => {
      const { container, getByText } = render(
        React.createElement(DiscoverPanel, makeProps()),
      );
      const input = container.querySelector('.discover-filter-input')!;
      fireEvent.change(input, { target: { value: 'zzz-nonexistent' } });
      expect(getByText('No matches')).toBeDefined();
    });

    it('shows clear button when filter has text', () => {
      const { container } = render(
        React.createElement(DiscoverPanel, makeProps()),
      );
      const input = container.querySelector('.discover-filter-input')!;
      fireEvent.change(input, { target: { value: 'test' } });
      const clearBtn = container.querySelector('.discover-filter-clear');
      expect(clearBtn).not.toBeNull();
    });

    it('clears filter when clear button is clicked', () => {
      const { container, queryByText } = render(
        React.createElement(DiscoverPanel, makeProps()),
      );
      const input = container.querySelector(
        '.discover-filter-input',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'zzz' } });
      expect(queryByText('No matches')).not.toBeNull();
      const clearBtn = container.querySelector('.discover-filter-clear')!;
      fireEvent.click(clearBtn);
      expect(input.value).toBe('');
    });
  });

  describe('graph toggle', () => {
    it('shows graph-only toggle when graphNodeIds is provided', () => {
      const { container } = render(
        React.createElement(
          DiscoverPanel,
          makeProps({ graphNodeIds: ['repo-1'] }),
        ),
      );
      const toggle = container.querySelector('.discover-graph-toggle');
      expect(toggle).not.toBeNull();
    });

    it('does not show graph-only toggle when graphNodeIds is undefined', () => {
      const { container } = render(
        React.createElement(DiscoverPanel, makeProps()),
      );
      const toggle = container.querySelector('.discover-graph-toggle');
      expect(toggle).toBeNull();
    });

    it('filters to in-graph nodes when toggle is on', () => {
      const { container, queryByText } = render(
        React.createElement(
          DiscoverPanel,
          makeProps({ graphNodeIds: ['repo-1', 'file-1'] }),
        ),
      );
      const checkbox = container.querySelector('.discover-graph-toggle input')!;
      fireEvent.click(checkbox);
      // repo-1 is in graph, dir-1 should still show because file-1 (descendant) is in graph
      expect(queryByText('my-repo')).not.toBeNull();
    });
  });

  describe('loading nodes', () => {
    it('shows loading placeholder for nodes being loaded', () => {
      const { getByText } = render(
        React.createElement(
          DiscoverPanel,
          makeProps({
            expanded: new Set(['repo-1', 'dir-1', 'file-1']),
            childrenMap: new Map([
              ['repo-1', [dirNode]],
              ['dir-1', [fileNode]],
              // file-1 has no children yet (loading)
            ]),
            loadingNodes: new Set(['file-1']),
          }),
        ),
      );
      expect(getByText('Loading...')).toBeDefined();
    });
  });

  describe('hop map highlighting', () => {
    it('applies hop highlight class to nodes in hopMap', () => {
      const { container } = render(
        React.createElement(
          DiscoverPanel,
          makeProps({
            graphNodeIds: ['repo-1', 'dir-1', 'file-1'],
            hopMap: new Map([
              ['repo-1', 0],
              ['dir-1', 1],
              ['file-1', 2],
            ]),
          }),
        ),
      );
      const hopRows = container.querySelectorAll('.discover-tree-row--hop');
      // Selected node (hop 0) doesn't get --hop class unless selectedNodeId is set
      // All nodes with hopMap entries get --hop class
      expect(hopRows.length).toBeGreaterThan(0);
    });
  });

  describe('isExpandable', () => {
    it('respects custom isExpandable predicate', () => {
      const onToggleExpand = vi.fn();
      const mdFile: TreeNodeData = {
        id: 'md-1',
        type: 'File',
        name: 'README.md',
      };
      const tsFile: TreeNodeData = {
        id: 'ts-1',
        type: 'File',
        name: 'index.ts',
      };
      const { container } = render(
        React.createElement(
          DiscoverPanel,
          makeProps({
            roots: [mdFile, tsFile],
            childrenMap: new Map(),
            expanded: new Set(),
            // Only .ts files are expandable
            isExpandable: (node: TreeNodeData) =>
              node.type === 'File' && node.name.endsWith('.ts'),
            onToggleExpand,
          }),
        ),
      );
      const expandBtns = container.querySelectorAll('.filter-expand-btn');
      // Only index.ts should have an expand button, README.md should not
      expect(expandBtns.length).toBe(1);
    });
  });

  describe('displayName', () => {
    it('shows only the last path segment', () => {
      const deepFile: TreeNodeData = {
        id: 'deep-1',
        type: 'File',
        name: 'src/components/App.tsx',
      };
      const { getByText } = render(
        React.createElement(
          DiscoverPanel,
          makeProps({
            roots: [deepFile],
            childrenMap: new Map(),
            expanded: new Set(),
          }),
        ),
      );
      expect(getByText('App.tsx')).toBeDefined();
    });
  });
});
