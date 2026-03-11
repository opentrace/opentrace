import { getNodeColor } from "./nodeColors";
import type { NodeResult } from "./parsers";

interface Props {
  node: NodeResult;
}

/** Hidden property keys (already shown in the header) */
const HIDDEN = new Set(["display_name", "name"]);

/** Detailed single-node card with full properties table */
export default function GetNodeResult({ node }: Props) {
  const color = getNodeColor(node.type);
  const props = node.properties
    ? Object.entries(node.properties).filter(([k]) => !HIDDEN.has(k))
    : [];

  return (
    <div className="result-get-node">
      <div className="result-node-card">
        <div className="result-node-header">
          <span
            className="result-type-badge"
            style={{ borderColor: color, color }}
          >
            {node.type}
          </span>
          <span className="result-node-name">{node.name}</span>
        </div>
        <div className="result-node-id">{node.id}</div>
      </div>
      {props.length > 0 && (
        <div className="result-props-table">
          {props.map(([key, value]) => (
            <div key={key} className="result-props-row">
              <span className="result-props-key">{key}</span>
              <span className="result-props-value">{String(value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
