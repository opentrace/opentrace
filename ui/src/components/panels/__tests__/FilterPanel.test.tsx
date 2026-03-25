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
    title: 'Node Types',
    items: [
      {
        key: 'Repository',
        label: 'Repository',
        count: 5,
        color: '#10b981',
        hidden: false,
      },
      {
        key: 'Class',
        label: 'Class',
        count: 3,
        color: '#3b82f6',
        hidden: false,
      },
    ],
    onToggle: vi.fn(),
    onShowAll: vi.fn(),
    onHideAll: vi.fn(),
    ...overrides,
  };
}

describe('FilterPanel', () => {
  it('renders title and items', () => {
    const { getByText } = render(React.createElement(FilterPanel, makeProps()));
    expect(getByText('Node Types')).toBeDefined();
    expect(getByText('Repository')).toBeDefined();
    expect(getByText('Class')).toBeDefined();
  });

  it('renders correct counts', () => {
    const { getByText } = render(React.createElement(FilterPanel, makeProps()));
    expect(getByText('5')).toBeDefined();
    expect(getByText('3')).toBeDefined();
  });

  it('fires onToggle when a checkbox is clicked', () => {
    const onToggle = vi.fn();
    const { container } = render(
      React.createElement(FilterPanel, makeProps({ onToggle })),
    );
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    fireEvent.click(checkboxes[0]);
    expect(onToggle).toHaveBeenCalledWith('Repository');
  });

  it('calls onHideAll when "Hide all" is clicked', () => {
    const onHideAll = vi.fn();
    const { getByText } = render(
      React.createElement(FilterPanel, makeProps({ onHideAll })),
    );
    fireEvent.click(getByText('Hide all'));
    expect(onHideAll).toHaveBeenCalled();
  });

  it('shows "Show all" when all items are hidden', () => {
    const onShowAll = vi.fn();
    const { getByText } = render(
      React.createElement(
        FilterPanel,
        makeProps({
          items: [
            {
              key: 'Repository',
              label: 'Repository',
              count: 5,
              color: '#10b981',
              hidden: true,
            },
            {
              key: 'Class',
              label: 'Class',
              count: 3,
              color: '#3b82f6',
              hidden: true,
            },
          ],
          onShowAll,
        }),
      ),
    );
    fireEvent.click(getByText('Show all'));
    expect(onShowAll).toHaveBeenCalled();
  });

  it('renders empty message when items is empty', () => {
    const { getByText } = render(
      React.createElement(
        FilterPanel,
        makeProps({ items: [], emptyMessage: 'No edges' }),
      ),
    );
    expect(getByText('No edges')).toBeDefined();
  });

  it('renders line indicator when indicator is "line"', () => {
    const { container } = render(
      React.createElement(FilterPanel, makeProps({ indicator: 'line' })),
    );
    expect(container.querySelectorAll('.filter-line').length).toBe(2);
    expect(container.querySelectorAll('.filter-dot').length).toBe(0);
  });

  it('renders dot indicator by default', () => {
    const { container } = render(React.createElement(FilterPanel, makeProps()));
    expect(container.querySelectorAll('.filter-dot').length).toBe(2);
  });

  describe('children (sub-types)', () => {
    const itemsWithChildren: FilterPanelProps = makeProps({
      items: [
        {
          key: 'Class',
          label: 'Class',
          count: 3,
          color: '#3b82f6',
          hidden: false,
          children: [
            {
              key: 'Class:Controller',
              label: 'Controller',
              count: 2,
              color: '#3b82f6',
              hidden: false,
            },
            {
              key: 'Class:Service',
              label: 'Service',
              count: 1,
              color: '#3b82f6',
              hidden: false,
            },
          ],
        },
      ],
    });

    it('shows expand button for items with children', () => {
      const { container } = render(
        React.createElement(FilterPanel, itemsWithChildren),
      );
      const expandBtns = container.querySelectorAll('.filter-expand-btn');
      expect(expandBtns.length).toBe(1);
    });

    it('shows children after expand is clicked', () => {
      const { container, getByText } = render(
        React.createElement(FilterPanel, itemsWithChildren),
      );
      const expandBtn = container.querySelector('.filter-expand-btn')!;
      fireEvent.click(expandBtn);
      expect(getByText('Controller')).toBeDefined();
      expect(getByText('Service')).toBeDefined();
    });

    it('fires onToggle with child key when child checkbox is clicked', () => {
      const onToggle = vi.fn();
      const { container } = render(
        React.createElement(FilterPanel, { ...itemsWithChildren, onToggle }),
      );
      // Expand first
      fireEvent.click(container.querySelector('.filter-expand-btn')!);
      // Click child checkbox
      const subCheckbox = container.querySelector(
        '.filter-subtypes input[type="checkbox"]',
      )!;
      fireEvent.click(subCheckbox);
      expect(onToggle).toHaveBeenCalledWith('Class:Controller');
    });

    it('shows indeterminate state when some children are hidden', () => {
      const { container } = render(
        React.createElement(
          FilterPanel,
          makeProps({
            items: [
              {
                key: 'Class',
                label: 'Class',
                count: 3,
                color: '#3b82f6',
                hidden: false,
                children: [
                  {
                    key: 'Class:Controller',
                    label: 'Controller',
                    count: 2,
                    color: '#3b82f6',
                    hidden: true,
                  },
                  {
                    key: 'Class:Service',
                    label: 'Service',
                    count: 1,
                    color: '#3b82f6',
                    hidden: false,
                  },
                ],
              },
            ],
          }),
        ),
      );
      const classItem = container.querySelector('.filter-item.partial');
      expect(classItem).not.toBeNull();
    });

    it('shows all-hidden state when all children are hidden', () => {
      const { container } = render(
        React.createElement(
          FilterPanel,
          makeProps({
            items: [
              {
                key: 'Class',
                label: 'Class',
                count: 3,
                color: '#3b82f6',
                hidden: false,
                children: [
                  {
                    key: 'Class:Controller',
                    label: 'Controller',
                    count: 2,
                    color: '#3b82f6',
                    hidden: true,
                  },
                  {
                    key: 'Class:Service',
                    label: 'Service',
                    count: 1,
                    color: '#3b82f6',
                    hidden: true,
                  },
                ],
              },
            ],
          }),
        ),
      );
      const classItem = container.querySelector('.filter-item.hidden');
      expect(classItem).not.toBeNull();
    });
  });
});
