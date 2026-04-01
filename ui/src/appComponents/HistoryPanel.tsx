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
    const q = filter.toLowerCase().trim();
    return entries.filter((e) => {
      if (sourceFilter !== 'all' && e.source !== sourceFilter) return false;
      if (!q) return true;
      return (
        e.name.toLowerCase().includes(q) || e.type.toLowerCase().includes(q)
      );
    });
  }, [entries, filter, sourceFilter]);

  return (
    <div className="history-panel">
      <div className="history-filter-bar">
        <div className="history-filter-wrap">
          <input
            className="history-filter-input"
            type="text"
            placeholder="Filter history..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter && (
            <button
              type="button"
              className="history-filter-clear"
              onClick={() => setFilter('')}
              title="Clear filter"
            >
              &times;
            </button>
          )}
        </div>
      </div>
      {entries.length > 0 && (
        <div className="history-source-toggle">
          <div className="history-source-toggles">
            {(['all', 'user', 'chat'] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={`history-source-btn${sourceFilter === s ? ' history-source-btn--active' : ''}`}
                onClick={() => setSourceFilter(s)}
              >
                {s === 'all' ? 'All' : s === 'user' ? 'User' : 'Chat'}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="history-clear-all"
            onClick={onClear}
            title="Clear history"
          >
            Clear All
          </button>
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
              type="button"
              className="history-row"
              onClick={() => onSelectNode(entry.id)}
            >
              <span
                className="history-row-dot"
                style={{ background: getNodeColor(entry.type) }}
              />
              <span className="history-row-name">{entry.name}</span>
              <span
                className={`history-row-source history-row-source--${entry.source}`}
              >
                {entry.source}
              </span>
              <span className="history-row-type">{entry.type}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
