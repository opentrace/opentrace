import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from '@storybook/test';
import ChatParts from './ChatParts';
import type { MessagePart } from './types';

const meta: Meta<typeof ChatParts> = {
  title: 'Chat/ChatParts',
  component: ChatParts,
  tags: ['autodocs'],
  args: {
    onNodeSelect: fn(),
  },
};
export default meta;

type Story = StoryObj<typeof ChatParts>;

const mixedParts: MessagePart[] = [
  {
    type: 'thought',
    content: 'Let me search for services in the graph to understand the architecture.',
  },
  {
    type: 'tool_call',
    id: 'tc-1',
    name: 'search_graph',
    args: JSON.stringify({ query: 'Service', type: 'Service' }),
    result: JSON.stringify({
      results: [
        { id: 'n-1', name: 'UserService', type: 'Service', score: 0.95 },
        { id: 'n-2', name: 'OrderService', type: 'Service', score: 0.88 },
      ],
    }),
    status: 'success',
    startTime: Date.now() - 5000,
    endTime: Date.now() - 3000,
  },
  {
    type: 'text',
    content: `I found **2 services** in the system:\n\n- **UserService** — handles user authentication and profiles\n- **OrderService** — manages order processing and payments\n\nWould you like me to explore the dependencies of either service?`,
  },
];

export const FullConversation: Story = {
  args: {
    parts: mixedParts,
  },
};

export const TextOnly: Story = {
  args: {
    parts: [
      {
        type: 'text',
        content: `Here's an overview of the system architecture:\n\n## Services\n- **UserService** — Authentication\n- **OrderService** — Order management\n- **PaymentGateway** — Payment processing\n\n## Databases\n- PostgreSQL for transactional data\n- Redis for caching and sessions`,
      },
    ],
  },
};

export const Streaming: Story = {
  args: {
    parts: [
      {
        type: 'text',
        content: 'Analyzing the dependency graph to find potential',
      },
    ],
    streaming: true,
  },
};
