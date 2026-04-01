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
import { shouldHideNode } from '../useGraphFilters';
import type { GraphNode, FilterState, GetSubTypeFn } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────

function makeFilterState(overrides: Partial<FilterState> = {}): FilterState {
  return {
    hiddenNodeTypes: new Set<string>(),
    hiddenLinkTypes: new Set<string>(),
    hiddenSubTypes: new Set<string>(),
    hiddenCommunities: new Set<number>(),
    ...overrides,
  };
}

const noSubTypes = new Map<string, { subType: string; count: number }[]>();
const noAssignments: Record<string, number> = {};
const defaultGetSubType: GetSubTypeFn = (node) => {
  const ext = node.name.match(/\.(\w+)$/)?.[1];
  return ext ?? null;
};

// ─── Tests ────────────────────────────────────────────────────────────

describe('shouldHideNode', () => {
  it('returns false when filter state is empty', () => {
    const node: GraphNode = { id: 'n1', name: 'foo.ts', type: 'File' };
    const result = shouldHideNode(
      node,
      makeFilterState(),
      noAssignments,
      noSubTypes,
      defaultGetSubType,
    );
    expect(result).toBe(false);
  });

  it('hides a node whose type is in hiddenNodeTypes', () => {
    const node: GraphNode = { id: 'n1', name: 'AuthService', type: 'Service' };
    const filterState = makeFilterState({
      hiddenNodeTypes: new Set(['Service']),
    });
    expect(
      shouldHideNode(
        node,
        filterState,
        noAssignments,
        noSubTypes,
        defaultGetSubType,
      ),
    ).toBe(true);
  });

  it('hides a node whose community is in hiddenCommunities', () => {
    const node: GraphNode = { id: 'n1', name: 'foo.ts', type: 'File' };
    const assignments: Record<string, number> = { n1: 3 };
    const filterState = makeFilterState({
      hiddenCommunities: new Set([3]),
    });
    expect(
      shouldHideNode(
        node,
        filterState,
        assignments,
        noSubTypes,
        defaultGetSubType,
      ),
    ).toBe(true);
  });

  it('hides a node whose sub-type is in hiddenSubTypes', () => {
    const node: GraphNode = { id: 'n1', name: 'foo.ts', type: 'File' };
    const availableSubTypes = new Map([
      [
        'File',
        [
          { subType: 'ts', count: 5 },
          { subType: 'go', count: 3 },
        ],
      ],
    ]);
    const filterState = makeFilterState({
      hiddenSubTypes: new Set(['File:ts']),
    });
    expect(
      shouldHideNode(
        node,
        filterState,
        noAssignments,
        availableSubTypes,
        defaultGetSubType,
      ),
    ).toBe(true);
  });

  it('does not hide a node when filters target a different type', () => {
    const node: GraphNode = { id: 'n1', name: 'main.go', type: 'File' };
    const filterState = makeFilterState({
      hiddenNodeTypes: new Set(['Service']),
      hiddenCommunities: new Set([99]),
    });
    expect(
      shouldHideNode(
        node,
        filterState,
        noAssignments,
        noSubTypes,
        defaultGetSubType,
      ),
    ).toBe(false);
  });

  it('does not hide by sub-type when the node type has no available sub-types', () => {
    const node: GraphNode = { id: 'n1', name: 'MyService', type: 'Service' };
    const filterState = makeFilterState({
      hiddenSubTypes: new Set(['Service:grpc']),
    });
    // No sub-types registered for Service, so sub-type filter is skipped
    expect(
      shouldHideNode(
        node,
        filterState,
        noAssignments,
        noSubTypes,
        defaultGetSubType,
      ),
    ).toBe(false);
  });

  it('ignores hiddenNodeTypes when the type has sub-types', () => {
    const node: GraphNode = { id: 'n1', name: 'foo.go', type: 'File' };
    const availableSubTypes = new Map([
      [
        'File',
        [
          { subType: 'ts', count: 5 },
          { subType: 'go', count: 3 },
        ],
      ],
    ]);
    const filterState = makeFilterState({
      hiddenNodeTypes: new Set(['File']),
      hiddenSubTypes: new Set(['File:ts']), // different sub-type
    });
    // Sub-type filters take precedence — File:go is not hidden
    expect(
      shouldHideNode(
        node,
        filterState,
        noAssignments,
        availableSubTypes,
        defaultGetSubType,
      ),
    ).toBe(false);
  });

  it('shows node after hide-all then unhiding its sub-type', () => {
    const node: GraphNode = { id: 'n1', name: 'data.json', type: 'File' };
    const availableSubTypes = new Map([
      [
        'File',
        [
          { subType: 'json', count: 2 },
          { subType: 'ts', count: 5 },
          { subType: 'go', count: 3 },
        ],
      ],
    ]);
    // Simulates: hide-all sets both hiddenNodeTypes and hiddenSubTypes,
    // then user un-hides .json only
    const filterState = makeFilterState({
      hiddenNodeTypes: new Set(['File', 'Function', 'Class']),
      hiddenSubTypes: new Set(['File:ts', 'File:go']), // .json removed
    });
    expect(
      shouldHideNode(
        node,
        filterState,
        noAssignments,
        availableSubTypes,
        defaultGetSubType,
      ),
    ).toBe(false);
  });

  it('hides node without sub-type when all sub-types are hidden', () => {
    // A file with no extension
    const node: GraphNode = { id: 'n1', name: 'Makefile', type: 'File' };
    const availableSubTypes = new Map([
      [
        'File',
        [
          { subType: 'ts', count: 5 },
          { subType: 'go', count: 3 },
        ],
      ],
    ]);
    const filterState = makeFilterState({
      hiddenSubTypes: new Set(['File:ts', 'File:go']),
    });
    expect(
      shouldHideNode(
        node,
        filterState,
        noAssignments,
        availableSubTypes,
        defaultGetSubType,
      ),
    ).toBe(true);
  });
});
