import type { Meta, StoryObj } from '@storybook/react-vite';
import ChatThought from './ChatThought';

const meta: Meta<typeof ChatThought> = {
  title: 'Chat/ChatThought',
  component: ChatThought,
  tags: ['autodocs'],
};
export default meta;

type Story = StoryObj<typeof ChatThought>;

export const Short: Story = {
  args: {
    part: {
      type: 'thought',
      content: 'Let me analyze the service dependencies to find potential bottlenecks.',
    },
  },
};

export const Long: Story = {
  args: {
    part: {
      type: 'thought',
      content: `I need to trace the request flow through multiple services to understand the dependency chain.

First, I'll look at the **UserService** which handles authentication. It connects to:
- **AuthDB** for credential storage
- **TokenService** for JWT generation
- **AuditLog** for access tracking

Then the request flows to the **OrderService** which has its own set of dependencies including the payment gateway and inventory system.

This is a complex chain that could benefit from circuit breakers at the boundary between UserService and OrderService.`,
    },
  },
};

export const WithMarkdown: Story = {
  args: {
    part: {
      type: 'thought',
      content: `Looking at the code structure:
- \`src/services/user.ts\` — main service file
- \`src/models/user.ts\` — data model
- The function \`getUserById()\` makes **3 database calls** which could be optimized`,
    },
  },
};
