import { getNodeColor } from "./nodeColors";
import type { NodeResult } from "./parsers";

interface Props {
  nodes: NodeResult[];
}

/** Grid of node cards — used for both search_graph and list_nodes results */
export default function NodeListResult({ nodes }: Props) {
  if (nodes.length === 0) {
    return <p className="result-empty">No nodes found.</p>;
  }

  return (
    <div className="result-node-list">
      {nodes.map((node) => {
        const color = getNodeColor(node.type);
        return (
          <div key={node.id} className="result-node-card">
            <div className="result-node-header">
              <span
                className="result-type-badge"
                style={{ borderColor: color, color }}
              >
                {node.type}
              </span>
              <span className="result-node-name">{node.name}</span>
            </div>
            {node.properties && Object.keys(node.properties).length > 0 && (
              <div className="result-node-props">
                {Object.entries(node.properties).slice(0, 3).map(([k, v]) => (
                  <span key={k} className="result-prop-chip">
                    {k}: {String(v)}
                  </span>
                ))}
                {Object.keys(node.properties).length > 3 && (
                  <span className="result-prop-chip result-prop-more">
                    +{Object.keys(node.properties).length - 3} more
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
