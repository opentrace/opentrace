import type { Meta, StoryObj } from '@storybook/react-vite';
import MermaidDiagram from './MermaidDiagram';

const meta: Meta<typeof MermaidDiagram> = {
  title: 'Chat/MermaidDiagram',
  component: MermaidDiagram,
  tags: ['autodocs'],
};
export default meta;

type Story = StoryObj<typeof MermaidDiagram>;

export const FlowChart: Story = {
  args: {
    code: `graph TD
    A[Client] --> B[API Gateway]
    B --> C[UserService]
    B --> D[OrderService]
    C --> E[(PostgreSQL)]
    D --> E
    D --> F[(Redis)]`,
  },
};

export const SequenceDiagram: Story = {
  args: {
    code: `sequenceDiagram
    participant C as Client
    participant A as API Gateway
    participant U as UserService
    participant D as Database
    C->>A: POST /login
    A->>U: Validate credentials
    U->>D: Query user
    D-->>U: User data
    U-->>A: JWT token
    A-->>C: 200 OK + token`,
  },
};

export const InvalidSyntax: Story = {
  args: {
    code: 'this is not valid mermaid syntax }{}{',
  },
};
