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
import { render, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import FilterPanel from '../FilterPanel';
import type { FilterPanelProps } from '../types';

afterEach(cleanup);

function makeProps(overrides?: Partial<FilterPanelProps>): FilterPanelProps {
  return {
    nodeTypes: [
      { type: 'Repository', count: 5 },
      { type: 'Class', count: 3 },
    ],
    linkTypes: [
      { type: 'CALLS', count: 10 },
      { type: 'READS', count: 4 },
    ],
    hiddenNodeTypes: new Set<string>(),
    hiddenLinkTypes: new Set<string>(),
    subTypesByNodeType: new Map(),
    hiddenSubTypes: new Set<string>(),
    onToggleNodeType: vi.fn(),
    onToggleLinkType: vi.fn(),
    onToggleSubType: vi.fn(),
    onShowAllNodes: vi.fn(),
    onHideAllNodes: vi.fn(),
    onShowAllLinks: vi.fn(),
    onHideAllLinks: vi.fn(),
    ...overrides,
  };
}

describe('FilterPanel', () => {
  it('renders node and link types', () => {
    const { getByText } = render(React.createElement(FilterPanel, makeProps()));
    expect(getByText('Repository')).toBeDefined();
    expect(getByText('Class')).toBeDefined();
    expect(getByText('calls')).toBeDefined();
    expect(getByText('reads')).toBeDefined();
  });

  it('renders correct counts', () => {
    const { getByText } = render(React.createElement(FilterPanel, makeProps()));
    expect(getByText('5')).toBeDefined();
    expect(getByText('3')).toBeDefined();
    expect(getByText('10')).toBeDefined();
    expect(getByText('4')).toBeDefined();
  });

  it('fires onToggleNodeType when a node type checkbox is clicked', () => {
    const onToggleNodeType = vi.fn();
    const { container } = render(
      React.createElement(FilterPanel, makeProps({ onToggleNodeType })),
    );
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    fireEvent.click(checkboxes[0]);
    expect(onToggleNodeType).toHaveBeenCalledWith('Repository');
  });

  it('fires onToggleLinkType when an edge type checkbox is clicked', () => {
    const onToggleLinkType = vi.fn();
    const { container } = render(
      React.createElement(FilterPanel, makeProps({ onToggleLinkType })),
    );
    // Node type checkboxes come first (2), then link type checkboxes
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    fireEvent.click(checkboxes[2]); // first link type
    expect(onToggleLinkType).toHaveBeenCalledWith('CALLS');
  });

  it('calls onHideAllNodes when "Hide all" is clicked', () => {
    const onHideAllNodes = vi.fn();
    const { getAllByText } = render(
      React.createElement(FilterPanel, makeProps({ onHideAllNodes })),
    );
    fireEvent.click(getAllByText('Hide all')[0]);
    expect(onHideAllNodes).toHaveBeenCalled();
  });

  it('shows "Show all" when all nodes are hidden', () => {
    const onShowAllNodes = vi.fn();
    const { getAllByText } = render(
      React.createElement(
        FilterPanel,
        makeProps({
          hiddenNodeTypes: new Set(['Repository', 'Class']),
          onShowAllNodes,
        }),
      ),
    );
    const showButtons = getAllByText('Show all');
    fireEvent.click(showButtons[0]);
    expect(onShowAllNodes).toHaveBeenCalled();
  });

  it('calls onHideAllLinks when edges "Hide all" is clicked', () => {
    const onHideAllLinks = vi.fn();
    const { getAllByText } = render(
      React.createElement(FilterPanel, makeProps({ onHideAllLinks })),
    );
    // Second "Hide all" is for edges section
    fireEvent.click(getAllByText('Hide all')[1]);
    expect(onHideAllLinks).toHaveBeenCalled();
  });

  it('shows "Show all" for edges when all links hidden', () => {
    const onShowAllLinks = vi.fn();
    const { getAllByText } = render(
      React.createElement(
        FilterPanel,
        makeProps({
          hiddenLinkTypes: new Set(['CALLS', 'READS']),
          onShowAllLinks,
        }),
      ),
    );
    const showButtons = getAllByText('Show all');
    // Last "Show all" is for edges
    fireEvent.click(showButtons[showButtons.length - 1]);
    expect(onShowAllLinks).toHaveBeenCalled();
  });

  it('renders "No edges" when linkTypes is empty', () => {
    const { getByText } = render(
      React.createElement(FilterPanel, makeProps({ linkTypes: [] })),
    );
    expect(getByText('No edges')).toBeDefined();
  });

  describe('sub-types', () => {
    it('shows expand button for types with sub-types', () => {
      const subs = new Map([
        [
          'Class',
          [
            { subType: 'Controller', count: 2 },
            { subType: 'Service', count: 1 },
          ],
        ],
      ]);
      const { container } = render(
        React.createElement(
          FilterPanel,
          makeProps({ subTypesByNodeType: subs }),
        ),
      );
      const expandBtns = container.querySelectorAll('.filter-expand-btn');
      expect(expandBtns.length).toBe(1);
    });

    it('shows sub-types after expand is clicked', () => {
      const subs = new Map([
        [
          'Class',
          [
            { subType: 'Controller', count: 2 },
            { subType: 'Service', count: 1 },
          ],
        ],
      ]);
      const { container, getByText } = render(
        React.createElement(
          FilterPanel,
          makeProps({ subTypesByNodeType: subs }),
        ),
      );
      const expandBtn = container.querySelector('.filter-expand-btn')!;
      fireEvent.click(expandBtn);
      expect(getByText('Controller')).toBeDefined();
      expect(getByText('Service')).toBeDefined();
    });

    it('fires onToggleSubType when a sub-type checkbox is clicked', () => {
      const onToggleSubType = vi.fn();
      const subs = new Map([['Class', [{ subType: 'Controller', count: 2 }]]]);
      const { container } = render(
        React.createElement(
          FilterPanel,
          makeProps({ subTypesByNodeType: subs, onToggleSubType }),
        ),
      );
      // Expand first
      const expandBtn = container.querySelector('.filter-expand-btn')!;
      fireEvent.click(expandBtn);
      // Find sub-type checkbox (inside .filter-subtypes)
      const subCheckbox = container.querySelector(
        '.filter-subtypes input[type="checkbox"]',
      )!;
      fireEvent.click(subCheckbox);
      expect(onToggleSubType).toHaveBeenCalledWith('Class:Controller');
    });

    it('shows indeterminate state when some sub-types hidden', () => {
      const subs = new Map([
        [
          'Class',
          [
            { subType: 'Controller', count: 2 },
            { subType: 'Service', count: 1 },
          ],
        ],
      ]);
      const { container } = render(
        React.createElement(
          FilterPanel,
          makeProps({
            subTypesByNodeType: subs,
            hiddenSubTypes: new Set(['Class:Controller']),
          }),
        ),
      );
      // The Class filter-item should have .partial class
      const classItem = container.querySelector('.filter-item.partial');
      expect(classItem).not.toBeNull();
    });
  });

  describe('communities', () => {
    const communityProps = {
      colorMode: 'community' as const,
      communities: [
        { communityId: 0, label: 'Frontend', count: 10, color: '#f00' },
        { communityId: 1, label: 'Backend', count: 8, color: '#0f0' },
      ],
      hiddenCommunities: new Set<number>(),
      onToggleCommunity: vi.fn(),
      onShowAllCommunities: vi.fn(),
      onHideAllCommunities: vi.fn(),
    };

    it('renders community section when colorMode is community', () => {
      const { getByText } = render(
        React.createElement(FilterPanel, makeProps(communityProps)),
      );
      expect(getByText('Communities')).toBeDefined();
      expect(getByText('Frontend')).toBeDefined();
      expect(getByText('Backend')).toBeDefined();
    });

    it('does not render community section when colorMode is type', () => {
      const { queryByText } = render(
        React.createElement(
          FilterPanel,
          makeProps({ ...communityProps, colorMode: 'type' }),
        ),
      );
      expect(queryByText('Communities')).toBeNull();
    });

    it('fires onToggleCommunity when community checkbox clicked', () => {
      const onToggleCommunity = vi.fn();
      const { container } = render(
        React.createElement(
          FilterPanel,
          makeProps({ ...communityProps, onToggleCommunity }),
        ),
      );
      const checkboxes = container.querySelectorAll('input[type="checkbox"]');
      // First two checkboxes are communities
      fireEvent.click(checkboxes[0]);
      expect(onToggleCommunity).toHaveBeenCalledWith(0);
    });

    it('shows "Show all" when all communities hidden', () => {
      const onShowAllCommunities = vi.fn();
      const { getAllByText } = render(
        React.createElement(
          FilterPanel,
          makeProps({
            ...communityProps,
            hiddenCommunities: new Set([0, 1]),
            onShowAllCommunities,
          }),
        ),
      );
      // First "Show all" is for communities section
      fireEvent.click(getAllByText('Show all')[0]);
      expect(onShowAllCommunities).toHaveBeenCalled();
    });
  });
});
