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
import GraphLegend from './GraphLegend';

const meta: Meta<typeof GraphLegend> = {
  title: 'Panels/GraphLegend',
  component: GraphLegend,
  tags: ['autodocs'],
};
export default meta;

type Story = StoryObj<typeof GraphLegend>;

export const FewItems: Story = {
  args: {
    items: [
      { label: 'Service', count: 12, color: '#58a6ff' },
      { label: 'Function', count: 85, color: '#f78166' },
      { label: 'File', count: 34, color: '#3fb950' },
    ],
  },
};

export const WithOverflow: Story = {
  args: {
    items: [
      { label: 'Service', count: 12, color: '#58a6ff' },
      { label: 'Function', count: 85, color: '#f78166' },
      { label: 'File', count: 34, color: '#3fb950' },
      { label: 'Class', count: 22, color: '#d2a8ff' },
      { label: 'Module', count: 8, color: '#f0883e' },
      { label: 'Directory', count: 44, color: '#79c0ff' },
      { label: 'Database', count: 3, color: '#ffa657' },
      { label: 'Endpoint', count: 16, color: '#ff7b72' },
    ],
    maxVisible: 5,
  },
};

export const WithLinkItems: Story = {
  args: {
    items: [
      { label: 'Service', count: 12, color: '#58a6ff' },
      { label: 'Function', count: 85, color: '#f78166' },
      { label: 'File', count: 34, color: '#3fb950' },
    ],
    linkItems: [
      { label: 'CALLS', count: 120, color: '#8b949e' },
      { label: 'IMPORTS', count: 45, color: '#6e7681' },
    ],
  },
};

export const LongLabels: Story = {
  args: {
    items: [
      { label: 'InstrumentedService', count: 5, color: '#58a6ff' },
      { label: 'DatabaseTable', count: 18, color: '#3fb950' },
      { label: 'PullRequestReview', count: 7, color: '#d2a8ff' },
    ],
  },
};
