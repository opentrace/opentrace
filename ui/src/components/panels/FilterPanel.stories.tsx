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

import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import FilterPanel from './FilterPanel';

const meta: Meta<typeof FilterPanel> = {
  title: 'Panels/FilterPanel',
  component: FilterPanel,
  tags: ['autodocs'],
  args: {
    onToggle: fn(),
    onShowAll: fn(),
    onHideAll: fn(),
  },
};
export default meta;

type Story = StoryObj<typeof FilterPanel>;

export const NodeTypes: Story = {
  args: {
    title: 'Node Types',
    items: [
      { key: 'Service', label: 'Service', count: 12, color: '#58a6ff', hidden: false },
      { key: 'Function', label: 'Function', count: 85, color: '#f78166', hidden: false },
      { key: 'File', label: 'File', count: 34, color: '#3fb950', hidden: false },
      { key: 'Class', label: 'Class', count: 22, color: '#d2a8ff', hidden: false },
      { key: 'Module', label: 'Module', count: 8, color: '#f0883e', hidden: true },
    ],
  },
};

export const WithChildren: Story = {
  args: {
    title: 'Node Types',
    items: [
      {
        key: 'Service',
        label: 'Service',
        count: 15,
        color: '#58a6ff',
        hidden: false,
        children: [
          { key: 'Service:http', label: 'HTTP', count: 8, color: '#58a6ff', hidden: false },
          { key: 'Service:grpc', label: 'gRPC', count: 5, color: '#58a6ff', hidden: false },
          { key: 'Service:worker', label: 'Worker', count: 2, color: '#58a6ff', hidden: true },
        ],
      },
      { key: 'Database', label: 'Database', count: 3, color: '#ffa657', hidden: false },
    ],
  },
};

export const EdgeTypes: Story = {
  args: {
    title: 'Edge Types',
    indicator: 'line',
    items: [
      { key: 'CALLS', label: 'CALLS', count: 120, color: '#8b949e', hidden: false },
      { key: 'IMPORTS', label: 'IMPORTS', count: 45, color: '#6e7681', hidden: false },
      { key: 'CONTAINS', label: 'CONTAINS', count: 200, color: '#484f58', hidden: true },
    ],
  },
};

export const AllHidden: Story = {
  args: {
    title: 'Node Types',
    items: [
      { key: 'Service', label: 'Service', count: 12, color: '#58a6ff', hidden: true },
      { key: 'Function', label: 'Function', count: 85, color: '#f78166', hidden: true },
      { key: 'File', label: 'File', count: 34, color: '#3fb950', hidden: true },
    ],
  },
};

export const Empty: Story = {
  args: {
    title: 'Communities',
    items: [],
    emptyMessage: 'No communities detected',
  },
};
