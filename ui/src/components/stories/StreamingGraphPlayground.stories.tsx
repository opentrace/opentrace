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
import StreamingGraphPlayground from './StreamingGraphPlayground';
import { DATASETS } from './datasets';

const meta: Meta<typeof StreamingGraphPlayground> = {
  title: 'Graph/StreamingGraphPlayground',
  component: StreamingGraphPlayground,
  parameters: {
    layout: 'centered',
  },
  argTypes: {
    dataset: {
      options: DATASETS.map((d) => d.name),
      mapping: Object.fromEntries(DATASETS.map((d) => [d.name, d])),
      control: { type: 'select' },
    },
    batchSize: {
      control: { type: 'range', min: 1, max: 50, step: 1 },
    },
    intervalMs: {
      control: { type: 'range', min: 200, max: 5000, step: 100 },
    },
  },
};
export default meta;

type Story = StoryObj<typeof StreamingGraphPlayground>;

const ds = (name: string) => DATASETS.find((d) => d.name === name)!;

/** Small dataset — streams 2 nodes every 1s so you can watch each batch arrive. */
export const WebApp: Story = {
  name: 'Web App (slow stream)',
  args: {
    dataset: ds('Web App'),
    batchSize: 2,
    intervalMs: 1000,
    width: 900,
    height: 600,
  },
};

/** Medium dataset — streams 10 nodes every 1.5s. */
export const GoMonorepo: Story = {
  name: 'Go Monorepo',
  args: {
    dataset: ds('Go Monorepo'),
    batchSize: 10,
    intervalMs: 1500,
    width: 900,
    height: 600,
  },
};

/** 100 nodes — fast stream (20 nodes/batch, 500ms interval). */
export const Fast100: Story = {
  name: '100 nodes (fast)',
  args: {
    dataset: ds('100 nodes'),
    batchSize: 20,
    intervalMs: 500,
    width: 900,
    height: 600,
  },
};

/** 500 nodes — moderate stream. */
export const Nodes500: Story = {
  name: '500 nodes',
  args: {
    dataset: ds('500 nodes'),
    batchSize: 25,
    intervalMs: 1000,
    width: 1000,
    height: 700,
  },
};

/** 2,000 nodes — batch stream simulating a real indexing job. */
export const Nodes2000: Story = {
  name: '2,000 nodes',
  args: {
    dataset: ds('2,000 nodes'),
    batchSize: 50,
    intervalMs: 1500,
    width: 1000,
    height: 700,
  },
};

/** 20,000 nodes — large stream, 500 nodes per batch every 2s. */
export const Nodes20000: Story = {
  name: '20,000 nodes',
  tags: ['!test'],
  args: {
    dataset: ds('20,000 nodes'),
    batchSize: 500,
    intervalMs: 2000,
    width: 1200,
    height: 800,
  },
};

/** 20,000 nodes in 3D mode — streams 500 nodes per batch every 2s with perspective. */
export const Nodes20000_3D: Story = {
  name: '20,000 nodes (3D)',
  tags: ['!test'],
  args: {
    dataset: ds('20,000 nodes'),
    batchSize: 500,
    intervalMs: 2000,
    mode3d: true,
    width: 1200,
    height: 800,
  },
};
