import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from '@storybook/test';
import IndexingProgress from './IndexingProgress';
import type { IndexingState, StageConfig } from './types';

const meta: Meta<typeof IndexingProgress> = {
  title: 'Indexing/IndexingProgress',
  component: IndexingProgress,
  tags: ['autodocs'],
  args: {
    onClose: fn(),
    onCancel: fn(),
  },
};
export default meta;

type Story = StoryObj<typeof IndexingProgress>;

const stageConfig: StageConfig[] = [
  { key: 'fetch', label: 'Fetching archive' },
  { key: 'extract', label: 'Extracting files' },
  { key: 'parse', label: 'Parsing symbols' },
  { key: 'resolve', label: 'Resolving calls' },
  { key: 'upload', label: 'Uploading to graph' },
];

const runningState: IndexingState = {
  status: 'running',
  nodesCreated: 234,
  relationshipsCreated: 567,
  error: null,
  stages: {
    fetch: { status: 'completed', current: 4200000, total: 4200000, message: '4.0 MB downloaded', format: 'bytes' },
    extract: { status: 'completed', current: 312, total: 312, message: '312 files' },
    parse: { status: 'active', current: 180, total: 312, message: 'src/utils/helpers.ts' },
  },
};

export const Running: Story = {
  args: {
    state: runningState,
    stages: stageConfig,
    title: 'Indexing Repository',
  },
};

export const FetchingWithBytes: Story = {
  args: {
    state: {
      status: 'running',
      nodesCreated: 0,
      relationshipsCreated: 0,
      error: null,
      stages: {
        fetch: { status: 'active', current: 1500000, total: 4200000, message: 'Downloading...', format: 'bytes' },
      },
    },
    stages: stageConfig,
  },
};

export const Completed: Story = {
  args: {
    state: {
      status: 'done',
      nodesCreated: 1234,
      relationshipsCreated: 3456,
      error: null,
      stages: {
        fetch: { status: 'completed', current: 4200000, total: 4200000, message: '4.0 MB', format: 'bytes' },
        extract: { status: 'completed', current: 312, total: 312, message: '312 files' },
        parse: { status: 'completed', current: 312, total: 312, message: 'Done' },
        resolve: { status: 'completed', current: 890, total: 890, message: '890 calls resolved' },
        upload: { status: 'completed', current: 1234, total: 1234, message: 'Complete' },
      },
    },
    stages: stageConfig,
    title: 'Complete',
    message: 'Loading graph...',
  },
};

export const Error: Story = {
  args: {
    state: {
      status: 'error',
      nodesCreated: 150,
      relationshipsCreated: 300,
      error: 'Failed to fetch archive: 403 Forbidden. The repository may be private — try adding an access token.',
      stages: {
        fetch: { status: 'active', current: 0, total: 0, message: '' },
      },
    },
    stages: stageConfig,
    title: 'Indexing Failed',
  },
};

export const WithMinimize: Story = {
  args: {
    state: runningState,
    stages: stageConfig,
    onMinimize: fn(),
  },
};
