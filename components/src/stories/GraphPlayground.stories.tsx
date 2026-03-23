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
import GraphPlayground from './GraphPlayground';
import { DATASETS } from './datasets';

const meta: Meta<typeof GraphPlayground> = {
  title: 'Graph/GraphPlayground',
  component: GraphPlayground,
  parameters: {
    layout: 'centered',
  },
  argTypes: {
    dataset: {
      options: DATASETS.map((d) => d.name),
      mapping: Object.fromEntries(DATASETS.map((d) => [d.name, d])),
      control: { type: 'select' },
    },
    renderer: {
      options: ['sigma', 'pixi'],
      control: { type: 'radio' },
    },
  },
};
export default meta;

type Story = StoryObj<typeof GraphPlayground>;

/** Helper to find dataset by name */
const ds = (name: string) => DATASETS.find((d) => d.name === name)!;

export const WebApp: Story = {
  name: 'Web App',
  args: {
    dataset: ds('Web App'),
    renderer: 'sigma',
    width: 900,
    height: 600,
  },
};

export const GoMonorepo: Story = {
  name: 'Go Monorepo',
  args: {
    dataset: ds('Go Monorepo'),
    renderer: 'sigma',
    width: 900,
    height: 600,
  },
};

export const Minimal: Story = {
  args: {
    dataset: ds('Minimal'),
    renderer: 'sigma',
    width: 600,
    height: 400,
  },
};

export const Nodes100: Story = {
  name: '100 nodes',
  args: {
    dataset: ds('100 nodes'),
    renderer: 'sigma',
    width: 900,
    height: 600,
  },
};

export const Nodes500: Story = {
  name: '500 nodes',
  args: {
    dataset: ds('500 nodes'),
    renderer: 'sigma',
    width: 1000,
    height: 700,
  },
};

export const Nodes2000: Story = {
  name: '2,000 nodes',
  args: {
    dataset: ds('2,000 nodes'),
    renderer: 'sigma',
    width: 1000,
    height: 700,
  },
};

export const Nodes5000: Story = {
  name: '5,000 nodes',
  args: {
    dataset: ds('5,000 nodes'),
    renderer: 'sigma',
    width: 1100,
    height: 750,
  },
};

export const Nodes10000: Story = {
  name: '10,000 nodes',
  args: {
    dataset: ds('10,000 nodes'),
    renderer: 'pixi',
    width: 1100,
    height: 750,
  },
};

export const Nodes15000: Story = {
  name: '15,000 nodes',
  args: {
    dataset: ds('15,000 nodes'),
    renderer: 'pixi',
    width: 1200,
    height: 800,
  },
};

export const Nodes20000: Story = {
  name: '20,000 nodes',
  tags: ['!test'],
  args: {
    dataset: ds('20,000 nodes'),
    renderer: 'pixi',
    width: 1200,
    height: 800,
  },
};

export const Nodes25000: Story = {
  name: '25,000 nodes',
  tags: ['!test'],
  args: {
    dataset: ds('25,000 nodes'),
    renderer: 'pixi',
    width: 1200,
    height: 800,
  },
};

export const Nodes30000: Story = {
  name: '30,000 nodes',
  tags: ['!test'],
  args: {
    dataset: ds('30,000 nodes'),
    renderer: 'pixi',
    width: 1200,
    height: 800,
  },
};

export const PixiRenderer: Story = {
  name: 'Pixi.js Renderer',
  tags: ['!test'],
  args: {
    dataset: ds('Web App'),
    renderer: 'pixi',
    width: 900,
    height: 600,
  },
};
