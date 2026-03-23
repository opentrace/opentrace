import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import GraphToolbar from './GraphToolbar';

const meta: Meta<typeof GraphToolbar> = {
  title: 'Panels/GraphToolbar',
  component: GraphToolbar,
  tags: ['autodocs'],
  args: {
    onSearchQueryChange: fn(),
    onSearch: fn(),
    onReset: fn(),
    onHopsChange: fn(),
    onMobilePanelTab: fn(),
  },
};
export default meta;

type Story = StoryObj<typeof GraphToolbar>;

const Logo = () => (
  <span style={{ fontWeight: 700, color: '#e6edf3', fontSize: 16 }}>
    OpenTrace
  </span>
);

export const Default: Story = {
  args: {
    logo: <Logo />,
    searchQuery: '',
    hops: 2,
    nodeCount: 42,
    edgeCount: 87,
  },
};

export const WithSearch: Story = {
  args: {
    logo: <Logo />,
    searchQuery: 'UserService',
    hops: 3,
    nodeCount: 12,
    edgeCount: 28,
    totalNodes: 42,
    totalEdges: 87,
    showResetButton: true,
  },
};

export const WithMobileTabs: Story = {
  args: {
    logo: <Logo />,
    searchQuery: '',
    hops: 2,
    nodeCount: 42,
    edgeCount: 87,
    mobilePanelTabs: [
      { key: 'discover', label: 'Discover', icon: '🔍' },
      { key: 'filters', label: 'Filters', icon: '⚙️' },
      { key: 'chat', label: 'Chat', icon: '💬' },
    ],
  },
};

export const WithActions: Story = {
  args: {
    logo: <Logo />,
    searchQuery: '',
    hops: 2,
    nodeCount: 42,
    edgeCount: 87,
    actions: (
      <button style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #30363d', background: '#21262d', color: '#e6edf3', cursor: 'pointer' }}>
        Settings
      </button>
    ),
    persistentActions: (
      <button style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #30363d', background: '#21262d', color: '#e6edf3', cursor: 'pointer' }}>
        + Add
      </button>
    ),
  },
};
