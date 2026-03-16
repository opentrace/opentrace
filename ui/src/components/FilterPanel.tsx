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
import { getNodeColor } from '../chat/results/nodeColors';
import { getLinkColor } from '../chat/results/linkColors';

interface TypeEntry {
  type: string;
  count: number;
}

interface SubTypeEntry {
  subType: string;
  count: number;
}

interface CommunityEntry {
  communityId: number;
  label: string;
  count: number;
  color: string;
}

interface FilterPanelProps {
  nodeTypes: TypeEntry[];
  linkTypes: TypeEntry[];
  hiddenNodeTypes: Set<string>;
  hiddenLinkTypes: Set<string>;
  subTypesByNodeType: Map<string, SubTypeEntry[]>;
  hiddenSubTypes: Set<string>;
  onToggleNodeType: (type: string) => void;
  onToggleLinkType: (type: string) => void;
  onToggleSubType: (key: string) => void;
  onShowAllNodes: () => void;
  onHideAllNodes: () => void;
  onShowAllLinks: () => void;
  onHideAllLinks: () => void;
  colorMode?: 'type' | 'community';
  communities?: CommunityEntry[];
  hiddenCommunities?: Set<number>;
  onToggleCommunity?: (cid: number) => void;
  onShowAllCommunities?: () => void;
  onHideAllCommunities?: () => void;
}

export default function FilterPanel({
  nodeTypes,
  linkTypes,
  hiddenNodeTypes,
  hiddenLinkTypes,
  subTypesByNodeType,
  hiddenSubTypes,
  onToggleNodeType,
  onToggleLinkType,
  onToggleSubType,
  onShowAllNodes,
  onHideAllNodes,
  onShowAllLinks,
  onHideAllLinks,
  colorMode,
  communities,
  hiddenCommunities,
  onToggleCommunity,
  onShowAllCommunities,
  onHideAllCommunities,
}: FilterPanelProps) {
  const allLinksHidden = hiddenLinkTypes.size === linkTypes.length;
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());

  const toggleExpanded = (type: string) => {
    setExpandedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
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
                />
                <span className="filter-type-name">{type.toLowerCase()}</span>
                <span className="filter-count">{count}</span>
              </label>
            );
          })}
          {linkTypes.length === 0 && (
            <span className="filter-empty">No edges</span>
          )}
        </div>
      </div>
    </div>
  );
}
