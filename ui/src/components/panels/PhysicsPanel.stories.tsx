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
import PhysicsPanel from './PhysicsPanel';

const meta: Meta<typeof PhysicsPanel> = {
  title: 'Panels/PhysicsPanel',
  component: PhysicsPanel,
  tags: ['autodocs'],
  args: {
    onRepulsionChange: fn(),
    onLabelsVisibleChange: fn(),
    onColorModeChange: fn(),
    onFlatModeChange: fn(),
    onStopPhysics: fn(),
    onStartPhysics: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 260, background: '#161b22', padding: 12, borderRadius: 8 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof PhysicsPanel>;

export const Default: Story = {
  args: {
    repulsion: 100,
    labelsVisible: true,
    colorMode: 'type',
    isPhysicsRunning: true,
  },
};

export const PhysicsStopped: Story = {
  args: {
    repulsion: 150,
    labelsVisible: false,
    colorMode: 'community',
    isPhysicsRunning: false,
  },
};

export const PixiMode: Story = {
  args: {
    repulsion: 100,
    labelsVisible: true,
    colorMode: 'type',
    isPhysicsRunning: true,
    pixiMode: true,
    linkDistance: 200,
    onLinkDistanceChange: fn(),
    centerStrength: 0.3,
    onCenterStrengthChange: fn(),
    edgesEnabled: true,
    onEdgesEnabledChange: fn(),
    layoutMode: 'spread' as const,
    onLayoutModeChange: fn(),
    zoomSizeExponent: 0.8,
    onZoomSizeExponentChange: fn(),
    onReheat: fn(),
    onFitToScreen: fn(),
  },
};
