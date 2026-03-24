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
import { fn } from 'storybook/test';
import ChatToolCall from './ChatToolCall';

const meta: Meta<typeof ChatToolCall> = {
  title: 'Chat/ChatToolCall',
  component: ChatToolCall,
  tags: ['autodocs'],
  args: {
    onNodeSelect: fn(),
  },
};
export default meta;

type Story = StoryObj<typeof ChatToolCall>;

export const SearchActive: Story = {
  args: {
    part: {
      type: 'tool_call',
      id: 'tc-1',
      name: 'search_graph',
      args: JSON.stringify({ query: 'UserService', type: 'Service' }),
      status: 'active',
      startTime: Date.now() - 1200,
    },
  },
};

export const SearchSuccess: Story = {
  args: {
    part: {
      type: 'tool_call',
      id: 'tc-2',
      name: 'search_graph',
      args: JSON.stringify({ query: 'UserService', type: 'Service' }),
      result: JSON.stringify({
        results: [
          { id: 'n-1', name: 'UserService', type: 'Service', score: 0.95 },
          { id: 'n-2', name: 'UserServiceTest', type: 'Class', score: 0.72 },
        ],
      }),
      status: 'success',
      startTime: Date.now() - 3000,
      endTime: Date.now() - 1800,
    },
  },
};

export const GetNodeSuccess: Story = {
  args: {
    part: {
      type: 'tool_call',
      id: 'tc-3',
      name: 'get_node',
      args: JSON.stringify({ id: 'n-1' }),
      result: JSON.stringify({
        id: 'n-1',
        name: 'UserService',
        type: 'Service',
        properties: { language: 'TypeScript', path: 'src/services/user.ts' },
      }),
      status: 'success',
      startTime: Date.now() - 2000,
      endTime: Date.now() - 1500,
    },
  },
};

export const ToolError: Story = {
  args: {
    part: {
      type: 'tool_call',
      id: 'tc-4',
      name: 'traverse_graph',
      args: JSON.stringify({ nodeId: 'nonexistent', direction: 'outgoing' }),
      result: 'Node not found: nonexistent',
      status: 'error',
      startTime: Date.now() - 1000,
      endTime: Date.now() - 800,
    },
  },
};

export const AgentActive: Story = {
  args: {
    part: {
      type: 'tool_call',
      id: 'tc-5',
      name: 'code_explorer',
      args: JSON.stringify({ query: 'How does the authentication flow work?' }),
      status: 'active',
      startTime: Date.now() - 5000,
      progressSteps: [
        'Searching for auth-related services',
        'Found UserService and AuthMiddleware',
        'Tracing request flow through auth chain',
        'Analyzing token validation logic',
      ],
    },
  },
};

export const AgentComplete: Story = {
  args: {
    part: {
      type: 'tool_call',
      id: 'tc-6',
      name: 'code_explorer',
      args: JSON.stringify({ query: 'How does the authentication flow work?' }),
      result: `## Authentication Flow

The authentication system uses a **JWT-based flow** with the following components:

1. **AuthMiddleware** — validates tokens on every request
2. **UserService** — handles login/signup and token generation
3. **TokenStore** — Redis-backed token blacklist for revocation

### Request Flow
\`\`\`
Client → AuthMiddleware → UserService → AuthDB
                       ↘ TokenStore (Redis)
\`\`\`

The middleware checks the \`Authorization\` header, validates the JWT signature, and passes the decoded user context downstream.`,
      status: 'success',
      startTime: Date.now() - 12000,
      endTime: Date.now() - 500,
      progressSteps: [
        'Searching for auth-related services',
        'Found UserService and AuthMiddleware',
        'Tracing request flow through auth chain',
        'Analyzing token validation logic',
      ],
    },
  },
};
