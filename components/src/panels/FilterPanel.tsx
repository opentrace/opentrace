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

import { useCallback, useState } from 'react';
import { getNodeColor } from '../colors/nodeColors';
import { getLinkColor } from '../colors/linkColors';
import type { FilterPanelProps, SubTypeEntry } from './types';
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

  /** Compute parent checkbox state for a node type that has sub-types. */
  const getSubTypeState = useCallback(
    (type: string, subs: SubTypeEntry[]): 'all' | 'none' | 'some' => {
      const keys = subs.map((s) => `${type}:${s.subType}`);
      const hiddenCount = keys.filter((k) => hiddenSubTypes.has(k)).length;
      if (hiddenCount === 0) return 'all';
      if (hiddenCount === keys.length) return 'none';
      return 'some';
    },
    [hiddenSubTypes],
  );

  // Compute allNodesHidden accounting for sub-type-driven types
  const allNodesHidden = nodeTypes.every(({ type }) => {
    const subs = subTypesByNodeType.get(type);
    if (subs && subs.length > 0) {
      return getSubTypeState(type, subs) === 'none';
    }
    return hiddenNodeTypes.has(type);
  });

  const showCommunities =
    colorMode === 'community' &&
    communities &&
    communities.length > 0 &&
    hiddenCommunities &&
    onToggleCommunity;

  const allCommunitiesHidden =
    showCommunities &&
    communities!.every((c) => hiddenCommunities!.has(c.communityId));

  return (
    <div className="filter-panel">
      {showCommunities && (
        <div className="filter-section">
          <div className="filter-section-header">
            <span className="filter-section-title">Communities</span>
            <button
              className="filter-toggle-all"
              onClick={
                allCommunitiesHidden
                  ? onShowAllCommunities
                  : onHideAllCommunities
              }
            >
              {allCommunitiesHidden ? 'Show all' : 'Hide all'}
            </button>
          </div>
          <div className="filter-list">
            {communities!.map(({ communityId, label, count, color }) => {
              const hidden = hiddenCommunities!.has(communityId);
              return (
                <label
                  key={communityId}
                  className={`filter-item ${hidden ? 'hidden' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={!hidden}
                    onChange={() => onToggleCommunity!(communityId)}
                  />
                  <span className="filter-expand-spacer" />
                  <span
                    className="filter-dot"
                    style={{
                      backgroundColor: hidden ? 'var(--muted)' : color,
                    }}
                  />
                  <span className="filter-type-name">{label}</span>
                  <span className="filter-count">{count}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      <div className="filter-section">
        <div className="filter-section-header">
          <span className="filter-section-title">Node Types</span>
          <button
            className="filter-toggle-all"
            onClick={allNodesHidden ? onShowAllNodes : onHideAllNodes}
          >
            {allNodesHidden ? 'Show all' : 'Hide all'}
          </button>
        </div>
        <div className="filter-list">
          {nodeTypes.map(({ type, count }) => {
            const subTypes = subTypesByNodeType.get(type);
            const hasSubTypes = subTypes && subTypes.length > 0;
            const isExpanded = expandedTypes.has(type);

            // Derive parent checked state
            let hidden: boolean;
            let indeterminate = false;
            if (hasSubTypes) {
              const state = getSubTypeState(type, subTypes);
              hidden = state === 'none';
              indeterminate = state === 'some';
            } else {
              hidden = hiddenNodeTypes.has(type);
            }

            return (
              <div key={type} className="filter-type-group">
                <label
                  className={`filter-item ${hidden ? 'hidden' : ''} ${indeterminate ? 'partial' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={!hidden && !indeterminate}
                    ref={(el) => {
                      if (el) el.indeterminate = indeterminate;
                    }}
                    onChange={() => onToggleNodeType(type)}
                  />
                  {hasSubTypes ? (
                    <button
                      className="filter-expand-btn"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        toggleExpanded(type);
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
                  <span
                    className="filter-dot"
                    style={{
                      backgroundColor: hidden
                        ? 'var(--muted)'
                        : getNodeColor(type),
                    }}
                  />
                  <span className="filter-type-name">{type}</span>
                  <span className="filter-count">{count}</span>
                </label>
                {hasSubTypes && isExpanded && (
                  <div className="filter-subtypes">
                    {subTypes.map(({ subType, count: subCount }) => {
                      const subKey = `${type}:${subType}`;
                      const subHidden = hiddenSubTypes.has(subKey);
                      return (
                        <label
                          key={subKey}
                          className={`filter-item filter-subitem ${subHidden ? 'hidden' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={!subHidden}
                            onChange={() => onToggleSubType(subKey)}
                          />
                          <span
                            className="filter-dot filter-dot--small"
                            style={{
                              backgroundColor: subHidden
                                ? 'var(--muted)'
                                : getNodeColor(type),
                              opacity: subHidden ? 1 : 0.7,
                            }}
                          />
                          <span className="filter-type-name">{subType}</span>
                          <span className="filter-count">{subCount}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="filter-list">
        {items.map((item) => {
          const hasChildren = item.children && item.children.length > 0;
          const isExpanded = expandedKeys.has(item.key);

      <div className="filter-section">
        <div className="filter-section-header">
          <span className="filter-section-title">Edges</span>
          <button
            className="filter-toggle-all"
            onClick={allLinksHidden ? onShowAllLinks : onHideAllLinks}
          >
            {allLinksHidden ? 'Show all' : 'Hide all'}
          </button>
        </div>
        <div className="filter-list">
          {linkTypes.map(({ type, count }) => {
            const hidden = hiddenLinkTypes.has(type);
            return (
              <label
                key={type}
                className={`filter-item ${hidden ? 'hidden' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={!hidden}
                  onChange={() => onToggleLinkType(type)}
                />
                <span
                  className="filter-line"
                  style={{
                    backgroundColor: hidden
                      ? 'var(--muted)'
                      : getLinkColor(type),
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
