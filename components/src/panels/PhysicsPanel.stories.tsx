import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from '@storybook/test';
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
    flatMode: false,
    isPhysicsRunning: true,
  },
};

export const PhysicsStopped: Story = {
  args: {
    repulsion: 150,
    labelsVisible: false,
    colorMode: 'community',
    flatMode: true,
    isPhysicsRunning: false,
  },
};

export const PixiMode: Story = {
  args: {
    repulsion: 100,
    labelsVisible: true,
    colorMode: 'type',
    flatMode: false,
    isPhysicsRunning: true,
    pixiMode: true,
    linkDistance: 200,
    onLinkDistanceChange: fn(),
    centerStrength: 0.3,
    onCenterStrengthChange: fn(),
    edgesEnabled: true,
    onEdgesEnabledChange: fn(),
    communityGravityEnabled: true,
    onCommunityGravityEnabledChange: fn(),
    communityGravityStrength: 0.15,
    onCommunityGravityStrengthChange: fn(),
    zoomSizeExponent: 0.8,
    onZoomSizeExponentChange: fn(),
    onReheat: fn(),
    onFitToScreen: fn(),
  },
};
