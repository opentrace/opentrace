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
}: FilterPanelProps) {
  const allLinksHidden = hiddenLinkTypes.size === linkTypes.length;
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());

  const toggleExpanded = (type: string) => {
    setExpandedTypes((prev) => {
      const next = new Set(prev);
      next.has(type) ? next.delete(type) : next.add(type);
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

  return (
    <div className="filter-panel">
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
