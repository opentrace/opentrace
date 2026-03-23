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
import PixiControlPanel from './PixiControlPanel';

const meta: Meta<typeof PixiControlPanel> = {
  title: 'Pixi/PixiControlPanel',
  component: PixiControlPanel,
  tags: ['autodocs'],
  args: {
    onReheat: fn(),
    onToggleSim: fn(),
    onFitToScreen: fn(),
    onChargeStrengthChange: fn(),
    onLinkDistanceChange: fn(),
    onCenterStrengthChange: fn(),
    onEdgesEnabledChange: fn(),
    onBloomEnabledChange: fn(),
    onBloomStrengthChange: fn(),
    onShowLabelsChange: fn(),
    onCommunityGravityEnabledChange: fn(),
    onCommunityGravityStrengthChange: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ position: 'relative', width: 400, height: 600, background: '#0d1117' }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof PixiControlPanel>;

export const Default: Story = {
  args: {
    simRunning: true,
    nodeCount: 1250,
    edgeCount: 3400,
    communityCount: 8,
    defaultChargeStrength: -100,
    defaultLinkDistance: 200,
    edgesEnabled: true,
    bloomEnabled: false,
    bloomStrength: 0.5,
    showLabels: true,
    communityGravityEnabled: false,
    communityGravityStrength: 0.1,
  },
};

export const SimStopped: Story = {
  args: {
    simRunning: false,
    nodeCount: 500,
    edgeCount: 1200,
    communityCount: 5,
    defaultChargeStrength: -150,
    defaultLinkDistance: 150,
    edgesEnabled: true,
    bloomEnabled: true,
    bloomStrength: 0.7,
    showLabels: false,
    communityGravityEnabled: true,
    communityGravityStrength: 0.2,
  },
};
