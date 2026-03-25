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
import GraphBadge from './GraphBadge';

const meta: Meta<typeof GraphBadge> = {
  title: 'Panels/GraphBadge',
  component: GraphBadge,
  tags: ['autodocs'],
};
export default meta;

type Story = StoryObj<typeof GraphBadge>;

export const Default: Story = {
  args: {
    nodeCount: 42,
    edgeCount: 87,
  },
};

export const WithTotals: Story = {
  args: {
    nodeCount: 42,
    edgeCount: 87,
    totalNodes: 1250,
    totalEdges: 3400,
  },
};

export const LargeNumbers: Story = {
  args: {
    nodeCount: 15432,
    edgeCount: 48291,
    totalNodes: 100000,
    totalEdges: 250000,
  },
};

export const Empty: Story = {
  args: {
    nodeCount: 0,
    edgeCount: 0,
  },
};
