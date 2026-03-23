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
