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

import { useState } from 'react';
import type { FilterPanelProps } from './types';
import './FilterPanel.css';

export default function FilterPanel({
  title,
  items,
  onToggle,
  onShowAll,
  onHideAll,
  indicator = 'dot',
  emptyMessage,
}: FilterPanelProps) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  const toggleExpanded = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const allHidden =
    items.length > 0 &&
    items.every((item) => {
      if (item.children && item.children.length > 0) {
        return item.children.every((c) => c.hidden);
      }
      return item.hidden;
    });

  return (
    <div className="filter-section">
      <div className="filter-section-header">
        <span className="filter-section-title">{title}</span>
        <button
          className="filter-toggle-all"
          onClick={allHidden ? onShowAll : onHideAll}
        >
          {allHidden ? 'Show all' : 'Hide all'}
        </button>
      </div>
      <div className="filter-list">
        {items.map((item) => {
          const hasChildren = item.children && item.children.length > 0;
          const isExpanded = expandedKeys.has(item.key);

          // Derive indeterminate state from children
          let hidden = item.hidden;
          let indeterminate = false;
          if (hasChildren) {
            const hiddenCount = item.children!.filter((c) => c.hidden).length;
            if (hiddenCount === item.children!.length) hidden = true;
            else if (hiddenCount > 0) indeterminate = true;
            else hidden = false;
          }

          return (
            <div key={item.key} className="filter-type-group">
              <label
                className={`filter-item ${hidden ? 'hidden' : ''} ${indeterminate ? 'partial' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={!hidden && !indeterminate}
                  ref={(el) => {
                    if (el) el.indeterminate = indeterminate;
                  }}
                  onChange={() => onToggle(item.key)}
                />
                {hasChildren ? (
                  <button
                    className="filter-expand-btn"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      toggleExpanded(item.key);
                    }}
                    title={isExpanded ? 'Collapse' : 'Expand sub-types'}
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      className={`filter-expand-icon ${isExpanded ? 'filter-expand-icon--open' : ''}`}
                    >
                      <path
                        d="M3 2 L7 5 L3 8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                    </svg>
                  </button>
                ) : (
                  <span className="filter-expand-spacer" />
                )}
                {indicator === 'line' ? (
                  <span
                    className="filter-line"
                    style={{
                      backgroundColor: hidden ? 'var(--muted)' : item.color,
                    }}
                  />
                ) : (
                  <span
                    className="filter-dot"
                    style={{
                      backgroundColor: hidden ? 'var(--muted)' : item.color,
                    }}
                  />
                )}
                <span className="filter-type-name">{item.label}</span>
                <span className="filter-count">{item.count}</span>
              </label>
              {hasChildren && isExpanded && (
                <div className="filter-subtypes">
                  {item.children!.map((child) => (
                    <label
                      key={child.key}
                      className={`filter-item filter-subitem ${child.hidden ? 'hidden' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={!child.hidden}
                        onChange={() => onToggle(child.key)}
                      />
                      <span
                        className="filter-dot filter-dot--small"
                        style={{
                          backgroundColor: child.hidden
                            ? 'var(--muted)'
                            : child.color,
                          opacity: child.hidden ? 1 : 0.7,
                        }}
                      />
                      <span className="filter-type-name">{child.label}</span>
                      <span className="filter-count">{child.count}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {items.length === 0 && emptyMessage && (
          <span className="filter-empty">{emptyMessage}</span>
        )}
      </div>
    </div>
  );
}
