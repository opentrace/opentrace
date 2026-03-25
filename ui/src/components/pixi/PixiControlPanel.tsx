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

/**
 * Floating control panel for the Pixi.js graph renderer.
 *
 * Provides sliders for force parameters, buttons for simulation control,
 * and toggles for visual features (edges, bloom, labels, communities).
 */

import { memo, useCallback, useState } from 'react';

// ─── Types ──────────────────────────────────────────────────────────────

export interface PixiControlPanelProps {
  // Simulation state
  simRunning: boolean;
  nodeCount: number;
  edgeCount: number;
  communityCount: number;

  // Force defaults
  defaultChargeStrength: number;
  defaultLinkDistance: number;

  // Visual state
  edgesEnabled: boolean;
  bloomEnabled: boolean;
  bloomStrength: number;
  showLabels: boolean;
  communityGravityEnabled: boolean;
  communityGravityStrength: number;

  // Callbacks — simulation
  onReheat: () => void;
  onToggleSim: () => void;
  onFitToScreen: () => void;
  onChargeStrengthChange: (value: number) => void;
  onLinkDistanceChange: (value: number) => void;
  onCenterStrengthChange: (value: number) => void;

  // Callbacks — visual
  onEdgesEnabledChange: (enabled: boolean) => void;
  onBloomEnabledChange: (enabled: boolean) => void;
  onBloomStrengthChange: (value: number) => void;
  onShowLabelsChange: (enabled: boolean) => void;
  onCommunityGravityEnabledChange: (enabled: boolean) => void;
  onCommunityGravityStrengthChange: (value: number) => void;
}

// ─── Styles ─────────────────────────────────────────────────────────────

const toggleBtnStyle: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  width: 32,
  height: 32,
  padding: 0,
  cursor: 'pointer',
  background: 'rgba(13, 17, 23, 0.85)',
  color: '#8b949e',
  border: '1px solid #21262d',
  borderRadius: 6,
  zIndex: 51,
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 50,
  right: 12,
  color: '#8b949e',
  fontSize: 13,
  background: 'rgba(13, 17, 23, 0.85)',
  padding: '12px 16px',
  borderRadius: 8,
  border: '1px solid #21262d',
  zIndex: 50,
  pointerEvents: 'auto',
  maxHeight: 'calc(100% - 64px)',
  overflowY: 'auto',
  width: 240,
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  margin: '4px 0',
};

const rangeStyle: React.CSSProperties = {
  width: 140,
  verticalAlign: 'middle',
};

const buttonStyle: React.CSSProperties = {
  marginTop: 4,
  marginRight: 4,
  padding: '4px 12px',
  cursor: 'pointer',
  background: '#21262d',
  color: '#e6edf3',
  border: '1px solid #30363d',
  borderRadius: 4,
  fontSize: 12,
};

const sectionStyle: React.CSSProperties = {
  marginTop: 8,
  borderTop: '1px solid #30363d',
  paddingTop: 8,
};

const statusStyle: React.CSSProperties = {
  color: '#58a6ff',
  fontSize: 11,
  marginTop: 4,
};

const valStyle: React.CSSProperties = {
  color: '#e6edf3',
  fontWeight: 600,
};

// ─── Component ──────────────────────────────────────────────────────────

function PixiControlPanel(props: PixiControlPanelProps) {
  const {
    simRunning,
    nodeCount,
    edgeCount,
    communityCount,
    defaultChargeStrength,
    defaultLinkDistance,
    edgesEnabled,
    bloomEnabled,
    bloomStrength,
    showLabels,
    communityGravityEnabled,
    communityGravityStrength,
    onReheat,
    onToggleSim,
    onFitToScreen,
    onChargeStrengthChange,
    onLinkDistanceChange,
    onCenterStrengthChange,
    onEdgesEnabledChange,
    onBloomEnabledChange,
    onBloomStrengthChange,
    onShowLabelsChange,
    onCommunityGravityEnabledChange,
    onCommunityGravityStrengthChange,
  } = props;

  const [open, setOpen] = useState(false);
  const [chargeValue, setChargeValue] = useState(defaultChargeStrength);
  const [linkDistValue, setLinkDistValue] = useState(defaultLinkDistance);
  const [centerValue, setCenterValue] = useState(30);

  const handleCharge = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = +e.target.value;
      setChargeValue(v);
      onChargeStrengthChange(v);
    },
    [onChargeStrengthChange],
  );

  const handleLinkDist = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = +e.target.value;
      setLinkDistValue(v);
      onLinkDistanceChange(v);
    },
    [onLinkDistanceChange],
  );

  const handleCenter = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = +e.target.value;
      setCenterValue(v);
      onCenterStrengthChange(v / 100);
    },
    [onCenterStrengthChange],
  );

  return (
    <>
      {/* Toggle button — gear icon */}
      <button
        style={{
          ...toggleBtnStyle,
          color: open ? '#e6edf3' : '#8b949e',
          borderColor: open ? '#30363d' : '#21262d',
        }}
        onClick={() => setOpen((o) => !o)}
        title="Graph settings"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {/* Panel — only visible when open */}
      {open && (
        <div style={panelStyle}>
          {/* Stats */}
          <div style={{ fontSize: 12, marginBottom: 6, lineHeight: 1.6 }}>
            <span style={valStyle}>{nodeCount.toLocaleString()}</span> nodes{' '}
            <span style={valStyle}>{edgeCount.toLocaleString()}</span> edges
          </div>

          {/* Force sliders */}
          <label style={labelStyle}>
            Repel:{' '}
            <input
              type="range"
              min={-500}
              max={-5}
              value={chargeValue}
              onChange={handleCharge}
              style={rangeStyle}
            />
          </label>
          <label style={labelStyle}>
            Link dist:{' '}
            <input
              type="range"
              min={5}
              max={500}
              value={linkDistValue}
              onChange={handleLinkDist}
              style={rangeStyle}
            />
          </label>
          <label style={labelStyle}>
            Center:{' '}
            <input
              type="range"
              min={1}
              max={100}
              value={centerValue}
              onChange={handleCenter}
              style={rangeStyle}
            />
          </label>

          {/* Buttons */}
          <div style={{ marginTop: 6 }}>
            <button style={buttonStyle} onClick={onReheat}>
              Reheat
            </button>
            <button style={buttonStyle} onClick={onToggleSim}>
              {simRunning ? 'Stop' : 'Resume'}
            </button>
            <button style={buttonStyle} onClick={onFitToScreen}>
              Fit to screen
            </button>
          </div>

          {/* Edge / Bloom */}
          <div style={sectionStyle}>
            <label style={{ ...labelStyle, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={edgesEnabled}
                onChange={(e) => onEdgesEnabledChange(e.target.checked)}
              />{' '}
              Show edges
            </label>
            <label style={{ ...labelStyle, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={bloomEnabled}
                onChange={(e) => onBloomEnabledChange(e.target.checked)}
              />{' '}
              Bloom glow
            </label>
            {bloomEnabled && (
              <label style={labelStyle}>
                Bloom:{' '}
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(bloomStrength * 100)}
                  onChange={(e) => onBloomStrengthChange(+e.target.value / 100)}
                  style={{ ...rangeStyle, width: 100 }}
                />
              </label>
            )}
          </div>

          {/* Community clusters */}
          <div style={sectionStyle}>
            <label style={{ ...labelStyle, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={communityGravityEnabled}
                onChange={(e) =>
                  onCommunityGravityEnabledChange(e.target.checked)
                }
              />{' '}
              Community clusters
            </label>
            {communityGravityEnabled && (
              <label style={labelStyle}>
                Gravity:{' '}
                <input
                  type="range"
                  min={0}
                  max={50}
                  value={Math.round(communityGravityStrength * 100)}
                  onChange={(e) =>
                    onCommunityGravityStrengthChange(+e.target.value / 100)
                  }
                  style={{ ...rangeStyle, width: 100 }}
                />
              </label>
            )}
            <label style={{ ...labelStyle, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showLabels}
                onChange={(e) => onShowLabelsChange(e.target.checked)}
              />{' '}
              Show labels
            </label>
            <div style={statusStyle}>{communityCount} communities detected</div>
          </div>
        </div>
      )}
    </>
  );
}

export default memo(PixiControlPanel);
