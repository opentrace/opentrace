import { getNodeColor } from "./nodeColors";
import type { TraverseEntry } from "./parsers";

interface Props {
  entries: TraverseEntry[];
}

/** Hierarchical tree view with depth-based indentation and relationship labels */
export default function TraverseResult({ entries }: Props) {
  if (entries.length === 0) {
    return <p className="result-empty">No results found.</p>;
  }

  return (
    <div className="result-traverse">
      {entries.map((entry, i) => {
        const { node, relationship, depth } = entry;
        const color = getNodeColor(node.type);

        return (
          <div
            key={`${node.id}-${i}`}
            className="result-traverse-entry"
            style={{ paddingLeft: depth * 16 }}
          >
            {relationship && relationship.type && (
              <div className="result-traverse-rel">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
                </svg>
                <span>{relationship.type}</span>
              </div>
            )}
            <div className="result-node-card result-node-card-compact">
              <div className="result-node-header">
                <span
                  className="result-type-badge"
                  style={{ borderColor: color, color }}
                >
                  {node.type}
                </span>
                <span className="result-node-name">{node.name}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
