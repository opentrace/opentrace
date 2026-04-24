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

import { PanelResizeHandle } from '@opentrace/components';
import { useResizablePanel } from '../hooks/useResizablePanel';
import './HelpDrawer.css';

interface HelpDrawerProps {
  onClose: () => void;
  onOpenAddRepo: () => void;
  onOpenChat: () => void;
  onOpenSettings: () => void;
}

export default function HelpDrawer({
  onClose,
  onOpenAddRepo,
  onOpenChat,
  onOpenSettings,
}: HelpDrawerProps) {
  const { width: panelWidth, handleMouseDown } = useResizablePanel({
    storageKey: 'ot_help_drawer_width',
    defaultWidth: 380,
    minWidth: 320,
    maxWidth: 640,
    side: 'left',
  });

  return (
    <div
      className="help-drawer"
      style={
        { '--help-drawer-width': `${panelWidth}px` } as React.CSSProperties
      }
    >
      <PanelResizeHandle side="left" onMouseDown={handleMouseDown} />
      <div className="panel-header">
        <h3>Getting Started</h3>
        <button className="close-btn" onClick={onClose}>
          &times;
        </button>
      </div>

      <div className="help-content">
        <section className="help-section">
          <h4>Graph Navigation</h4>
          <dl className="help-shortcuts">
            <dt>Pan</dt>
            <dd>Click &amp; drag on the canvas</dd>
            <dt>Zoom</dt>
            <dd>Scroll wheel or pinch</dd>
            <dt>Select node</dt>
            <dd>Click a node</dd>
            <dt>Deselect</dt>
            <dd>Click empty canvas</dd>
          </dl>
        </section>

        <section className="help-section">
          <h4>Search &amp; Filtering</h4>
          <dl className="help-shortcuts">
            <dt>Search</dt>
            <dd>Type a node name and press Enter</dd>
            <dt>Hops</dt>
            <dd>Control how many connections deep to traverse</dd>
            <dt>Show All</dt>
            <dd>Reset search to show the full graph</dd>
            <dt>Filters</dt>
            <dd>Toggle node types and communities in the side panels</dd>
          </dl>
        </section>

        <section className="help-section">
          <h4>Toolbar</h4>
          <div className="help-actions">
            <button className="help-action-btn" onClick={onOpenAddRepo}>
              <svg
                width="16"
                height="16"
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
              <div className="help-action-text">
                <strong>Add Repository</strong>
                <span>Index a GitHub repo or local directory</span>
              </div>
            </button>
            <button className="help-action-btn" onClick={onOpenChat}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
              </svg>
              <div className="help-action-text">
                <strong>AI Chat</strong>
                <span>Ask questions about the codebase using AI</span>
              </div>
            </button>
            <button className="help-action-btn" onClick={onOpenSettings}>
              <svg
                width="16"
                height="16"
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
              <div className="help-action-text">
                <strong>Settings</strong>
                <span>
                  Configure visualization limits, AI summarization, and
                  animation
                </span>
              </div>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
