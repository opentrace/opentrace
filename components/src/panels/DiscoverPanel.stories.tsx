import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from '@storybook/test';
import DiscoverPanel from './DiscoverPanel';
import type { TreeNodeData } from './types';

const meta: Meta<typeof DiscoverPanel> = {
  title: 'Panels/DiscoverPanel',
  component: DiscoverPanel,
  tags: ['autodocs'],
  args: {
    onToggleExpand: fn(),
    onSelectNode: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 300, height: 500, background: '#161b22', borderRadius: 8, overflow: 'hidden' }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof DiscoverPanel>;

const roots: TreeNodeData[] = [
  { id: 'repo-1', name: 'opentrace/opentrace', type: 'Repository' },
];

const children: Map<string, TreeNodeData[]> = new Map([
  [
    'repo-1',
    [
      { id: 'dir-agent', name: 'agent', type: 'Directory' },
      { id: 'dir-ui', name: 'ui', type: 'Directory' },
      { id: 'dir-api', name: 'api', type: 'Directory' },
      { id: 'file-readme', name: 'README.md', type: 'File' },
    ],
  ],
  [
    'dir-agent',
    [
      { id: 'file-main', name: 'main.py', type: 'File' },
      { id: 'class-agent', name: 'Agent', type: 'Class' },
      { id: 'fn-load', name: 'load_data', type: 'Function' },
    ],
  ],
  [
    'dir-ui',
    [
      { id: 'file-app', name: 'App.tsx', type: 'File' },
      { id: 'class-graph', name: 'GraphView', type: 'Class' },
    ],
  ],
]);

export const Default: Story = {
  args: {
    roots,
    childrenMap: children,
    expanded: new Set(['repo-1']),
  },
};

export const FullyExpanded: Story = {
  args: {
    roots,
    childrenMap: children,
    expanded: new Set(['repo-1', 'dir-agent', 'dir-ui']),
  },
};

export const WithSelection: Story = {
  args: {
    roots,
    childrenMap: children,
    expanded: new Set(['repo-1', 'dir-agent']),
    selectedNodeId: 'class-agent',
  },
};

export const WithGraphFilter: Story = {
  args: {
    roots,
    childrenMap: children,
    expanded: new Set(['repo-1', 'dir-agent']),
    graphNodeIds: ['repo-1', 'dir-agent', 'class-agent', 'fn-load'],
  },
};

export const Empty: Story = {
  args: {
    roots: [],
    childrenMap: new Map(),
    expanded: new Set(),
  },
};
