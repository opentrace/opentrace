import { Fragment } from 'react';
import { getNodeColor } from './nodeColors';
import type { NodeResult } from './parsers';

interface Props {
  node: NodeResult;
  onNodeSelect?: (nodeId: string) => void;
}

/** Hidden property keys (already shown in the header) */
const HIDDEN = new Set(['display_name', 'name']);

/** Clean single-node detail view with filled badge header and 2-column properties */
export default function GetNodeResult({ node, onNodeSelect }: Props) {
  const color = getNodeColor(node.type);
  const props = node.properties
    ? Object.entries(node.properties).filter(([k]) => !HIDDEN.has(k))
    : [];

  return (
    <div className="result-get-node">
      <div
        className="result-get-node-header"
        onClick={() => onNodeSelect?.(node.id)}
      >
        <span className="result-type-badge" style={{ background: color }}>
          {node.type}
        </span>
        <span className="result-node-name">{node.name}</span>
      </div>
      <div className="result-node-id">{node.id}</div>
      {props.length > 0 && (
        <div className="result-props-table">
          {props.map(([key, value]) => (
            <Fragment key={key}>
              <span className="result-props-key">{key}</span>
              <span className="result-props-value">{String(value)}</span>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
