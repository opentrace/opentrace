// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import FilterPanel from '../FilterPanel';

afterEach(cleanup);

const defaultProps = {
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
};

describe('FilterPanel', () => {
  it('renders node and link types', () => {
    const { getByText } = render(
      React.createElement(FilterPanel, defaultProps),
    );
    expect(getByText('Repository')).toBeDefined();
    expect(getByText('Class')).toBeDefined();
    expect(getByText('calls')).toBeDefined(); // lowercased in display
    expect(getByText('reads')).toBeDefined();
  });

  it('toggle callbacks fire on checkbox click', () => {
    const onToggleNodeType = vi.fn();
    const { container } = render(
      React.createElement(FilterPanel, {
        ...defaultProps,
        onToggleNodeType,
      }),
    );
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    // First checkbox is for first node type (Repository)
    fireEvent.click(checkboxes[0]);
    expect(onToggleNodeType).toHaveBeenCalledWith('Repository');
  });

  it('Hide all button calls onHideAllNodes', () => {
    const onHideAllNodes = vi.fn();
    const { getAllByText } = render(
      React.createElement(FilterPanel, {
        ...defaultProps,
        onHideAllNodes,
      }),
    );
    // First "Hide all" is for Node Types, second is for Edges
    fireEvent.click(getAllByText('Hide all')[0]);
    expect(onHideAllNodes).toHaveBeenCalled();
  });

  it('Show all button appears when all nodes are hidden', () => {
    const onShowAllNodes = vi.fn();
    const { getAllByText } = render(
      React.createElement(FilterPanel, {
        ...defaultProps,
        hiddenNodeTypes: new Set(['Repository', 'Class']),
        onShowAllNodes,
      }),
    );
    // "Show all" for node types section
    const showButtons = getAllByText('Show all');
    fireEvent.click(showButtons[0]);
    expect(onShowAllNodes).toHaveBeenCalled();
  });

  it('renders with correct counts', () => {
    const { getByText } = render(
      React.createElement(FilterPanel, defaultProps),
    );
    expect(getByText('5')).toBeDefined();
    expect(getByText('3')).toBeDefined();
    expect(getByText('10')).toBeDefined();
  });
});
