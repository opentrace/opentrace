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

import { AddRepoModal } from '@opentrace/components';
import type { JobMessage } from '../job';
import { OpenTraceLogo } from './OpenTraceLogo';

export const VersionFooter = () => (
  <footer className="version-footer">
    v{__APP_VERSION__} &middot; {new Date(__BUILD_TIME__).toLocaleString()}
  </footer>
);

export const CopyrightFooter = () => (
  <footer className="copyright-footer">
    &copy; {new Date().getFullYear()} OpenTrace
  </footer>
);

export const EmptyStateHeader = () => (
  <div className="empty-state-header">
    <img
      src="/opentrace-logo.svg"
      alt="OpenTrace"
      className="empty-state-header-logo"
    />
    <span className="empty-state-header-title">OpenTrace</span>
  </div>
);

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

export const GraphLoadingState = () => (
  <div className="graph-viewport">
    <div className="loading">
      <OpenTraceLogo size={64} />
      <span>Loading graph...</span>
      <VersionFooter />
    </div>
  </div>
);

export const GraphErrorState = ({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}) => (
  <div className="graph-viewport">
    <div className="loading">
      <p>Failed to load graph: {error}</p>
      <button onClick={onRetry}>Retry</button>
      <VersionFooter />
    </div>
  </div>
);

export const GraphSearchEmpty = ({
  searchQuery,
  onClearSearch,
}: {
  searchQuery: string;
  onClearSearch: () => void;
}) => (
  <div className="graph-viewport">
    <div className="empty-state-overlay">
      <div className="empty-state-content">
        <img
          src="/opentrace-logo.svg"
          alt="OpenTrace"
          className="empty-state-logo"
        />
        <h1>No results</h1>
        <p>
          No nodes matched <strong>{searchQuery}</strong>. Try a different
          search or clear to see the full graph.
        </p>
        <button className="empty-state-add-btn" onClick={onClearSearch}>
          Clear Search
        </button>
      </div>
    </div>
    <CopyrightFooter />
    <VersionFooter />
  </div>
);

interface GraphInitialEmptyProps {
  showAddRepo: boolean;
  showFullModal: boolean;
  onAddRepoOpen: () => void;
  onAddRepoClose: () => void;
  onJobSubmit: (message: JobMessage) => void;
  onValidateRepo: (url: string) => string | null;
  /** Indexing progress modal contents — passed through when shown. */
  indexingProgress: React.ReactNode;
}

export const GraphInitialEmpty = ({
  showAddRepo,
  showFullModal,
  onAddRepoOpen,
  onAddRepoClose,
  onJobSubmit,
  onValidateRepo,
  indexingProgress,
}: GraphInitialEmptyProps) => (
  <div className="graph-viewport">
    <EmptyStateHeader />

    {showAddRepo && (
      <AddRepoModal
        onClose={onAddRepoClose}
        onSubmit={onJobSubmit}
        dismissable={false}
        onValidate={onValidateRepo}
      />
    )}

    {!showAddRepo && (
      <div className="empty-state-overlay">
        <div className="empty-state-content">
          <p>No data in the graph yet.</p>
          <button className="empty-state-add-btn" onClick={onAddRepoOpen}>
            <PlusIcon />
            Add Repository
          </button>
        </div>
      </div>
    )}

    {showFullModal && indexingProgress}

    <CopyrightFooter />
    <VersionFooter />
  </div>
);
