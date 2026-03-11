import { getNodeColor } from "../chat/results/nodeColors";
import { getLinkColor } from "../chat/results/linkColors";

interface TypeEntry {
  type: string;
  count: number;
}

interface FilterPanelProps {
  nodeTypes: TypeEntry[];
  linkTypes: TypeEntry[];
  hiddenNodeTypes: Set<string>;
  hiddenLinkTypes: Set<string>;
  onToggleNodeType: (type: string) => void;
  onToggleLinkType: (type: string) => void;
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
  onToggleNodeType,
  onToggleLinkType,
  onShowAllNodes,
  onHideAllNodes,
  onShowAllLinks,
  onHideAllLinks,
}: FilterPanelProps) {
  const allNodesHidden = hiddenNodeTypes.size === nodeTypes.length;
  const allLinksHidden = hiddenLinkTypes.size === linkTypes.length;

  return (
    <div className="filter-panel">
      <div className="filter-section">
        <div className="filter-section-header">
          <span className="filter-section-title">Node Types</span>
          <button
            className="filter-toggle-all"
            onClick={allNodesHidden ? onShowAllNodes : onHideAllNodes}
          >
            {allNodesHidden ? "Show all" : "Hide all"}
          </button>
        </div>
        <div className="filter-list">
          {nodeTypes.map(({ type, count }) => {
            const hidden = hiddenNodeTypes.has(type);
            return (
              <label key={type} className={`filter-item ${hidden ? "hidden" : ""}`}>
                <input
                  type="checkbox"
                  checked={!hidden}
                  onChange={() => onToggleNodeType(type)}
                />
                <span
                  className="filter-dot"
                  style={{ backgroundColor: hidden ? "var(--muted)" : getNodeColor(type) }}
                />
                <span className="filter-type-name">{type}</span>
                <span className="filter-count">{count}</span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="filter-section">
        <div className="filter-section-header">
          <span className="filter-section-title">Relationships</span>
          <button
            className="filter-toggle-all"
            onClick={allLinksHidden ? onShowAllLinks : onHideAllLinks}
          >
            {allLinksHidden ? "Show all" : "Hide all"}
          </button>
        </div>
        <div className="filter-list">
          {linkTypes.map(({ type, count }) => {
            const hidden = hiddenLinkTypes.has(type);
            return (
              <label key={type} className={`filter-item ${hidden ? "hidden" : ""}`}>
                <input
                  type="checkbox"
                  checked={!hidden}
                  onChange={() => onToggleLinkType(type)}
                />
                <span
                  className="filter-line"
                  style={{ backgroundColor: hidden ? "var(--muted)" : getLinkColor(type) }}
                />
                <span className="filter-type-name">{type.toLowerCase()}</span>
                <span className="filter-count">{count}</span>
              </label>
            );
          })}
          {linkTypes.length === 0 && (
            <span className="filter-empty">No relationships</span>
          )}
        </div>
      </div>
    </div>
  );
}
