import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from '@storybook/test';
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
