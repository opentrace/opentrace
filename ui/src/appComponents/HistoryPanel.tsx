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

import { useMemo, useState } from 'react';
import { getNodeColor } from '@opentrace/components/utils';
import type { HistoryEntry, HistorySource } from './historyTypes';
import './HistoryPanel.css';

interface HistoryPanelProps {
  entries: HistoryEntry[];
  onSelectNode: (nodeId: string) => void;
  onClear: () => void;
}

function formatTimeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function HistoryPanel({
  entries,
  onSelectNode,
  onClear,
}: HistoryPanelProps) {
  const [filter, setFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState<HistorySource | 'all'>(
    'all',
  );

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (sourceFilter !== 'all' && e.source !== sourceFilter) return false;
      if (!filter) return true;
      const q = filter.toLowerCase();
      return (
        e.name.toLowerCase().includes(q) || e.type.toLowerCase().includes(q)
      );
    });
  }, [entries, filter, sourceFilter]);

  return (
    <div className="history-panel">
      <div className="history-panel-header">
        <span className="history-panel-header-title">Selection History</span>
        {entries.length > 0 && (
          <button className="history-panel-clear" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      {entries.length > 0 && (
        <div className="history-panel-filter">
          <input
            className="history-panel-filter-input"
            type="text"
            placeholder="Filter by name or type..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="history-panel-source-toggles">
            {(['all', 'user', 'chat'] as const).map((s) => (
              <button
                key={s}
                className={`history-panel-source-btn${sourceFilter === s ? ' history-panel-source-btn--active' : ''}`}
                onClick={() => setSourceFilter(s)}
              >
                {s === 'all' ? 'All' : s === 'user' ? 'User' : 'Chat'}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="history-panel-list">
        {entries.length === 0 ? (
          <div className="history-panel-empty">
            No nodes selected yet. Click a node in the graph or use chat to
            start building your history.
          </div>
        ) : filtered.length === 0 ? (
          <div className="history-panel-empty">
            No matches for &ldquo;{filter}&rdquo;
          </div>
        ) : (
          filtered.map((entry, i) => (
            <button
              key={`${entry.id}-${entry.timestamp}-${i}`}
              className="history-panel-item"
              onClick={() => onSelectNode(entry.id)}
            >
              <span
                className="history-panel-item-dot"
                style={{ background: getNodeColor(entry.type) }}
              />
              <div className="history-panel-item-info">
                <div className="history-panel-item-name">{entry.name}</div>
                <div className="history-panel-item-meta">
                  <span
                    className={`history-panel-item-source history-panel-item-source--${entry.source}`}
                  >
                    {entry.source}
                  </span>
                  <span>&middot;</span>
                  <span className="history-panel-item-type">{entry.type}</span>
                  <span>&middot;</span>
                  <span>{formatTimeAgo(entry.timestamp)}</span>
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
