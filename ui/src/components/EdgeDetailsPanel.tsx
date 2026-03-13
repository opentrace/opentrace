import type { LinkObject, NodeObject } from 'react-force-graph-2d';
import type { GraphNode, GraphLink } from '../types/graph';
import { getLinkColor } from '../chat/results/linkColors';
import { getNodeColor } from '../chat/results/nodeColors';
import './EdgeDetailsPanel.css';

type Node = NodeObject<GraphNode>;
type Link = LinkObject<GraphNode, GraphLink>;

/** Extract the string ID from a link endpoint (handles both string and object forms). */
function endpointId(endpoint: string | number | Node | undefined): string {
  if (typeof endpoint === 'object' && endpoint !== null) return endpoint.id;
  return String(endpoint);
}

/** Extract the full node object from a link endpoint, if available. */
function endpointNode(
  endpoint: string | number | Node | undefined,
): Node | null {
  if (typeof endpoint === 'object' && endpoint !== null)
    return endpoint as Node;
  return null;
}

interface EdgeDetailsPanelProps {
  link: Link;
  onSelectNode?: (nodeId: string) => void;
}

export default function EdgeDetailsPanel({
  link,
  onSelectNode,
}: EdgeDetailsPanelProps) {
  const label = (link as unknown as GraphLink).label || 'unknown';
  const color = getLinkColor(label);

  const sourceId = endpointId(link.source);
  const targetId = endpointId(link.target);
  const sourceNode = endpointNode(link.source);
  const targetNode = endpointNode(link.target);

  const sourceName = sourceNode?.name || sourceId;
  const targetName = targetNode?.name || targetId;
  const sourceType = sourceNode?.type;
  const targetType = targetNode?.type;

  return (
    <div className="edge-details-content">
      {/* ── Header: relationship type badge ── */}
      <div className="edge-detail-header">
        <span className="edge-type-badge" style={{ backgroundColor: color }}>
          {label}
        </span>
        <span className="edge-detail-label">Relationship</span>
      </div>

      {/* ── Direction diagram ── */}
      <div className="edge-direction">
        <button
          className="edge-endpoint edge-endpoint--source"
          onClick={() => onSelectNode?.(sourceId)}
          title={`Select ${sourceName}`}
        >
          {sourceType && (
            <span
              className="edge-endpoint-type"
              style={{ backgroundColor: getNodeColor(sourceType) }}
            >
              {sourceType}
            </span>
          )}
          <span className="edge-endpoint-name">{sourceName}</span>
        </button>

        <div className="edge-arrow">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
          <span className="edge-arrow-label" style={{ color }}>
            {label}
          </span>
        </div>

        <button
          className="edge-endpoint edge-endpoint--target"
          onClick={() => onSelectNode?.(targetId)}
          title={`Select ${targetName}`}
        >
          {targetType && (
            <span
              className="edge-endpoint-type"
              style={{ backgroundColor: getNodeColor(targetType) }}
            >
              {targetType}
            </span>
          )}
          <span className="edge-endpoint-name">{targetName}</span>
        </button>
      </div>

      {/* ── Edge properties ── */}
      {(() => {
        const props = (link as unknown as GraphLink).properties;
        if (!props || Object.keys(props).length === 0) return null;
        const patch = typeof props.patch === 'string' ? props.patch : null;
        const otherProps = Object.entries(props).filter(([k]) => k !== 'patch');
        return (
          <div className="edge-props-section">
            <h4>Edge Properties</h4>
            {otherProps.map(([k, v]) => (
              <div key={k} className="detail-row">
                <span className="label">{k}</span>
                <span className="value">{String(v)}</span>
              </div>
            ))}
            {patch && (
              <div className="edge-patch">
                <h4>Patch</h4>
                <pre className="edge-patch-code">{patch}</pre>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Source node properties ── */}
      {sourceNode?.properties &&
        Object.keys(sourceNode.properties).length > 0 && (
          <div className="edge-node-section">
            <h4>
              Source Node
              <span className="edge-node-section-name">{sourceName}</span>
            </h4>
            {Object.entries(sourceNode.properties)
              .filter(
                ([k]) =>
                  k !== 'has_embedding' &&
                  k !== 'source_uri' &&
                  k !== 'source_name',
              )
              .slice(0, 5)
              .map(([k, v]) => (
                <div key={k} className="detail-row">
                  <span className="label">{k}</span>
                  <span className="value">{String(v)}</span>
                </div>
              ))}
          </div>
        )}

      {/* ── Target node properties ── */}
      {targetNode?.properties &&
        Object.keys(targetNode.properties).length > 0 && (
          <div className="edge-node-section">
            <h4>
              Target Node
              <span className="edge-node-section-name">{targetName}</span>
            </h4>
            {Object.entries(targetNode.properties)
              .filter(
                ([k]) =>
                  k !== 'has_embedding' &&
                  k !== 'source_uri' &&
                  k !== 'source_name',
              )
              .slice(0, 5)
              .map(([k, v]) => (
                <div key={k} className="detail-row">
                  <span className="label">{k}</span>
                  <span className="value">{String(v)}</span>
                </div>
              ))}
          </div>
        )}

      {/* ── IDs footer ── */}
      <div className="edge-ids-footer">
        <div className="detail-row">
          <span className="label">Source ID</span>
          <span className="id-value">{sourceId}</span>
        </div>
        <div className="detail-row">
          <span className="label">Target ID</span>
          <span className="id-value">{targetId}</span>
        </div>
      </div>
    </div>
  );
}
