import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from '@storybook/test';
import ChatTemplates from './ChatTemplates';

const meta: Meta<typeof ChatTemplates> = {
  title: 'Chat/ChatTemplates',
  component: ChatTemplates,
  tags: ['autodocs'],
  args: {
    onSelect: fn(),
  },
};
export default meta;

type Story = StoryObj<typeof ChatTemplates>;

export const Default: Story = {};
