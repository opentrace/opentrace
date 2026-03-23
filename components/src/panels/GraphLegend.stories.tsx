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
