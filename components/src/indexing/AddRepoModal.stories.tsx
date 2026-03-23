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
