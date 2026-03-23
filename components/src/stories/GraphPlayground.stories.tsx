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

export const Microservices: Story = {
  args: {
    dataset: ds('Microservices'),
    renderer: 'sigma',
    width: 900,
    height: 600,
  },
};

export const CodeStructure: Story = {
  args: {
    dataset: ds('Code Structure'),
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
    dataset: ds('Microservices'),
    renderer: 'pixi',
    width: 900,
    height: 600,
  },
};
