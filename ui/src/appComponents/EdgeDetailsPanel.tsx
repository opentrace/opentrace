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

import type { SelectedEdge } from '@opentrace/components/utils';
import { getLinkColor, getNodeColor } from '@opentrace/components/utils';
import './EdgeDetailsPanel.css';

interface EdgeDetailsPanelProps {
  link: SelectedEdge;
  onSelectNode?: (nodeId: string) => void;
}

export default function EdgeDetailsPanel({
  link,
  onSelectNode,
}: EdgeDetailsPanelProps) {
  const label = link.label || 'unknown';
  const color = getLinkColor(label);

  const sourceId = link.source;
  const targetId = link.target;
  const sourceNode = link.sourceNode;
  const targetNode = link.targetNode;

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
        const props = link.properties;
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
                  k !== 'sourceUri' &&
                  k !== 'provider',
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
                  k !== 'sourceUri' &&
                  k !== 'provider',
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
