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
