import type { Preview } from '@storybook/react-vite';

// Import component CSS so stories render correctly
import '../src/panels/GraphBadge.css';
import '../src/panels/GraphLegend.css';
import '../src/panels/GraphToolbar.css';
import '../src/panels/FilterPanel.css';
import '../src/panels/DiscoverPanel.css';
import '../src/panels/PhysicsPanel.css';
import '../src/indexing/indexing-base.css';
import '../src/indexing/AddRepoModal.css';
import '../src/indexing/IndexingProgress.css';
import '../src/chat/parts.css';
import '../src/chat/markdown.css';
import '../src/chat/MermaidDiagram.css';
import '../src/chat/results/results.css';
import '../src/chat/results/ReviewResult.css';
import '../src/chat/results/SuggestCommentResult.css';

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    a11y: {
      test: 'todo',
    },
    backgrounds: {
      default: 'dark',
      values: [
        { name: 'dark', value: '#0d1117' },
        { name: 'light', value: '#ffffff' },
      ],
    },
  },
};

export default preview;
