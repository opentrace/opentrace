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

import type { JobState } from '../job';
import { HelpMenuButton } from './HelpMenuButton';
import JobMinimizedBar from './JobMinimizedBar';
import ThemeSelector from './ThemeSelector';

const PlusIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const FilterIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
  </svg>
);

const CompassIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
  </svg>
);

const InfoIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </svg>
);

const ExportIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

const SpinnerIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    style={{ animation: 'spin 0.8s linear infinite' }}
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

const SparklesIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
    <path d="M20 3v4" />
    <path d="M22 5h-4" />
    <path d="M4 17v2" />
    <path d="M5 18H3" />
  </svg>
);

const SettingsIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

export const GitHubStarButton = () => (
  <a
    className="github-star-btn"
    href="https://github.com/opentrace/opentrace"
    target="_blank"
    rel="noopener noreferrer"
    title="Star on GitHub"
  >
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
    <span className="star-label">Star</span>
  </a>
);

interface GraphToolbarActionButtonsProps {
  /** Caller-supplied passthrough actions rendered before the built-in buttons. */
  toolbarActions?: React.ReactNode;
  // Job
  jobState: JobState;
  jobExpanded: boolean;
  onJobExpand: () => void;
  onJobCancel: () => void;
  // Add repo
  onAddRepoOpen: () => void;
  // Export
  hasGraphData: boolean;
  canExport: boolean;
  exporting: boolean;
  onExportOpen: () => void;
  // Toggles
  showChat: boolean;
  onToggleChat: () => void;
  showHelp: boolean;
  onToggleHelp: () => void;
  showSettings: boolean;
  onToggleSettings: () => void;
}

export const GraphToolbarActionButtons = ({
  toolbarActions,
  jobState,
  jobExpanded,
  onJobExpand,
  onJobCancel,
  onAddRepoOpen,
  hasGraphData,
  canExport,
  exporting,
  onExportOpen,
  showChat,
  onToggleChat,
  showHelp,
  onToggleHelp,
  showSettings,
  onToggleSettings,
}: GraphToolbarActionButtonsProps) => {
  const showJobMinimized =
    (jobState.status === 'enriching' || jobState.status === 'done') &&
    !jobExpanded;

  return (
    <>
      {toolbarActions}
      {showJobMinimized ? (
        <JobMinimizedBar
          state={jobState}
          onClick={onJobExpand}
          onCancel={onJobCancel}
        />
      ) : (
        <button
          className="add-repo-btn"
          onClick={onAddRepoOpen}
          title="Add Repository"
        >
          <PlusIcon />
          <span className="ot-menu-label">Add Repository</span>
        </button>
      )}
      {hasGraphData && canExport && (
        <button
          className="export-db-btn"
          title="Export database"
          disabled={exporting}
          onClick={onExportOpen}
        >
          {exporting ? <SpinnerIcon /> : <ExportIcon />}
          <span className="ot-menu-label">
            {exporting ? 'Exporting…' : 'Export'}
          </span>
        </button>
      )}
      <ThemeSelector />
      <button
        className={`chat-toggle-btn ${showChat ? 'active' : ''}`}
        onClick={onToggleChat}
        title="Toggle AI Chat"
        data-testid="chat-toggle-btn"
      >
        <SparklesIcon />
        <span className="ot-menu-label">AI Chat</span>
      </button>
      <HelpMenuButton showHelp={showHelp} onToggleHelp={onToggleHelp} />
      <button
        className={`settings-toggle-btn ${showSettings ? 'active' : ''}`}
        onClick={onToggleSettings}
        title="Settings"
      >
        <SettingsIcon />
        <span className="ot-menu-label">Settings</span>
      </button>
    </>
  );
};

interface BuildMobilePanelTabsArgs {
  showDetails: boolean;
}

// eslint-disable-next-line react-refresh/only-export-components -- co-located helper for the toolbar's mobile panel tabs
export const buildMobilePanelTabs = ({
  showDetails,
}: BuildMobilePanelTabsArgs) => [
  { key: 'filters', label: 'Filters', icon: <FilterIcon /> },
  { key: 'discover', label: 'Discover', icon: <CompassIcon /> },
  {
    key: 'details',
    label: 'Details',
    visible: showDetails,
    icon: <InfoIcon />,
  },
];
