import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from '@storybook/test';
import AddRepoModal from './AddRepoModal';

const meta: Meta<typeof AddRepoModal> = {
  title: 'Indexing/AddRepoModal',
  component: AddRepoModal,
  tags: ['autodocs'],
  args: {
    onClose: fn(),
    onSubmit: fn(),
  },
  parameters: {
    layout: 'fullscreen',
  },
};
export default meta;

type Story = StoryObj<typeof AddRepoModal>;

export const Default: Story = {
  args: {},
};

export const NonDismissable: Story = {
  args: {
    dismissable: false,
  },
};

export const WithValidation: Story = {
  args: {
    onValidate: (url: string) => {
      if (url.includes('opentrace'))
        return 'This repository has already been indexed.';
      return null;
    },
  },
};
