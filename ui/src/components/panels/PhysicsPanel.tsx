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

import { useCallback, useRef, useEffect, useState } from 'react';
import {
  useResizablePanel,
  useResizablePanelHeight,
} from '../../hooks/useResizablePanel';
import PanelResizeHandle from './PanelResizeHandle';
import './PhysicsPanel.css';

interface PhysicsPanelProps {
  repulsion: number;
  onRepulsionChange: (value: number) => void;
  labelsVisible: boolean;
  onLabelsVisibleChange: (visible: boolean) => void;
  colorMode: 'type' | 'community';
  onColorModeChange: (mode: 'type' | 'community') => void;
  flatMode?: boolean;
  onFlatModeChange?: (flat: boolean) => void;
  isPhysicsRunning: boolean;
  onStopPhysics: () => void;
  onStartPhysics: () => void;

  // ── Pixi-specific (optional — only shown when renderer is 'pixi') ──
  pixiMode?: boolean;
  linkDistance?: number;
  onLinkDistanceChange?: (value: number) => void;
  centerStrength?: number;
  onCenterStrengthChange?: (value: number) => void;
  edgesEnabled?: boolean;
  onEdgesEnabledChange?: (enabled: boolean) => void;
  layoutMode?: 'spread' | 'compact';
  onLayoutModeChange?: (mode: 'spread' | 'compact') => void;
  /** Whether community wayfinder labels are visible. Decoupled from
   *  layoutMode (Fix #52) — toggling visibility no longer reflows the
   *  graph, it just shows or hides the cluster labels in place. */
  communityLabelsVisible?: boolean;
  onCommunityLabelsVisibleChange?: (visible: boolean) => void;
  /** Master switch for community processing. When false, Louvain is not
   *  run and the community sub-controls (colors, labels, pull slider)
   *  are visually disabled. Defaults to true for compatibility. */
  communitiesEnabled?: boolean;
  onCommunitiesEnabledChange?: (enabled: boolean) => void;
  // Compact-mode-specific
  radialStrength?: number;
  onRadialStrengthChange?: (value: number) => void;
  communityPull?: number;
  onCommunityPullChange?: (value: number) => void;
  centeringStrength?: number;
  onCenteringStrengthChange?: (value: number) => void;
  circleRadius?: number;
  onCircleRadiusChange?: (value: number) => void;
  zoomSizeExponent?: number;
  onZoomSizeExponentChange?: (value: number) => void;
  labelScale?: number;
  onLabelScaleChange?: (value: number) => void;
  onReheat?: () => void;
  onFitToScreen?: () => void;
  // 3D mode
  mode3d?: boolean;
  onMode3dChange?: (enabled: boolean) => void;
  mode3dAutoRotate?: boolean;
  onMode3dAutoRotateChange?: (enabled: boolean) => void;
  mode3dSpeed?: number;
  onMode3dSpeedChange?: (speed: number) => void;
  mode3dTilt?: number;
  onMode3dTiltChange?: (tilt: number) => void;
}

export default function PhysicsPanel({
  repulsion,
  onRepulsionChange,
  labelsVisible,
  onLabelsVisibleChange,
  colorMode,
  onColorModeChange,
  // flatMode and onFlatModeChange kept in type for backwards compat but not rendered
  isPhysicsRunning,
  onStopPhysics,
  onStartPhysics,
  // Pixi-specific
  pixiMode,
  linkDistance = 200,
  onLinkDistanceChange,
  centerStrength = 0.3,
  onCenterStrengthChange,
  edgesEnabled = true,
  onEdgesEnabledChange,
  layoutMode = 'spread',
  communityLabelsVisible = true,
  onCommunityLabelsVisibleChange,
  communitiesEnabled = true,
  onCommunitiesEnabledChange,
  radialStrength = 8,
  onRadialStrengthChange,
  communityPull = 10,
  onCommunityPullChange,
  centeringStrength = 5,
  onCenteringStrengthChange,
  circleRadius = 32,
  onCircleRadiusChange,
  zoomSizeExponent = 0.8,
  onZoomSizeExponentChange,
  labelScale = 100,
  onLabelScaleChange,
  onReheat,
  onFitToScreen,
  mode3d = false,
  onMode3dChange,
  mode3dAutoRotate = true,
  onMode3dAutoRotateChange,
  mode3dSpeed = 30,
  onMode3dSpeedChange,
  mode3dTilt = 35,
  onMode3dTiltChange,
}: PhysicsPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { width: panelWidth, handleMouseDown } = useResizablePanel({
    storageKey: 'ot_physics_panel_width',
    defaultWidth: 240,
    minWidth: 220,
    maxWidth: 420,
    side: 'left',
    panelRef,
  });
  const { height: panelHeight, handleMouseDown: onHeightDrag } =
    useResizablePanelHeight({
      storageKey: 'ot_physics_panel_height',
      minHeight: 240,
      maxHeight: 900,
      side: 'top',
      panelRef,
    });

  // Debounce repulsion slider changes (200ms). Keep a local controlled value
  // so the thumb tracks the drag immediately, while still reflecting external
  // changes to the `repulsion` prop (e.g. a reset).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [localRepulsion, setLocalRepulsion] = useState(repulsion);

  useEffect(() => {
    setLocalRepulsion(repulsion);
  }, [repulsion]);

  const handleRepulsionInput = useCallback(
    (e: React.FormEvent<HTMLInputElement>) => {
      const value = Number(e.currentTarget.value);
      setLocalRepulsion(value);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onRepulsionChange(value);
      }, 200);
    },
    [onRepulsionChange],
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div
      ref={panelRef}
      className="physics-panel"
      style={
        {
          '--physics-panel-width': `${panelWidth}px`,
          ...(panelHeight != null
            ? { '--physics-panel-height': `${panelHeight}px` }
            : {}),
        } as React.CSSProperties
      }
    >
      <PanelResizeHandle side="left" onMouseDown={handleMouseDown} />
      <PanelResizeHandle side="top" onMouseDown={onHeightDrag} />
      <PanelResizeHandle
        side="top-left"
        onMouseDown={(e) => {
          handleMouseDown(e, 'nwse-resize');
          onHeightDrag(e, 'nwse-resize');
        }}
      />
      <div className="physics-panel-scroll">
        <h4 className="physics-panel-title">Display</h4>

        {/* Master switch — when off, Louvain doesn't run and the
            community-derived controls below become no-ops. Mounted only
            when the consumer supplied a handler so older callers keep
            their existing controls. */}
        {onCommunitiesEnabledChange && (
          <div
            className="physics-toggle-row"
            onClick={() => onCommunitiesEnabledChange(!communitiesEnabled)}
          >
            <span className="physics-toggle-label">Communities</span>
            <div
              className={`physics-toggle-track${communitiesEnabled ? ' on' : ''}`}
            >
              <div className="physics-toggle-thumb" />
            </div>
          </div>
        )}

        <div
          className="physics-toggle-row"
          onClick={() => {
            if (!communitiesEnabled) return;
            onColorModeChange(colorMode === 'type' ? 'community' : 'type');
          }}
          style={
            communitiesEnabled
              ? undefined
              : { opacity: 0.4, cursor: 'not-allowed' }
          }
        >
          <span className="physics-toggle-label">Community colors</span>
          <div
            className={`physics-toggle-track${colorMode === 'community' && communitiesEnabled ? ' on' : ''}`}
          >
            <div className="physics-toggle-thumb" />
          </div>
        </div>

        {/* Community wayfinder labels — show/hide only, no layout
            reflow (Fix #52). Adjacent to "Community colors" since
            both are visual-only community controls. The compact ↔
            spread layout toggle lives separately in the bottom
            controls bar. */}
        {pixiMode && onCommunityLabelsVisibleChange && (
          <div
            className="physics-toggle-row"
            onClick={() => {
              if (!communitiesEnabled) return;
              onCommunityLabelsVisibleChange(!communityLabelsVisible);
            }}
            style={
              communitiesEnabled
                ? undefined
                : { opacity: 0.4, cursor: 'not-allowed' }
            }
          >
            <span className="physics-toggle-label">Community labels</span>
            <div
              className={`physics-toggle-track${communityLabelsVisible && communitiesEnabled ? ' on' : ''}`}
            >
              <div className="physics-toggle-thumb" />
            </div>
          </div>
        )}

        <div
          className="physics-toggle-row"
          onClick={() => onLabelsVisibleChange(!labelsVisible)}
        >
          <span className="physics-toggle-label">Show labels</span>
          <div className={`physics-toggle-track${labelsVisible ? ' on' : ''}`}>
            <div className="physics-toggle-thumb" />
          </div>
        </div>

        {/* Pixi: edges visibility toggle (Fix #7). Hides the edge
            layer at the renderer level — node positions are preserved
            and edges reappear on re-enable without a relayout. Useful
            on hub-heavy graphs where the edge draw dominates each
            frame (>3000 edges around a single node) and the canvas
            becomes unresponsive. */}
        {pixiMode && onEdgesEnabledChange && (
          <div
            className="physics-toggle-row"
            onClick={() => onEdgesEnabledChange(!edgesEnabled)}
          >
            <span className="physics-toggle-label">Show edges</span>
            <div className={`physics-toggle-track${edgesEnabled ? ' on' : ''}`}>
              <div className="physics-toggle-thumb" />
            </div>
          </div>
        )}

        {/* Layout mode is controlled via the bottom-right "Switch
            to compact/spread layout" button (Fix #52) — keeping it
            here as well used to share a single toggle with the
            community-clusters label visibility, which conflated two
            different concerns. */}

        {/* Pixi: 3D rotation toggle + controls */}
        {pixiMode && onMode3dChange && (
          <>
            <div
              className="physics-toggle-row"
              onClick={() => onMode3dChange(!mode3d)}
            >
              <span className="physics-toggle-label">3D rotation</span>
              <div className={`physics-toggle-track${mode3d ? ' on' : ''}`}>
                <div className="physics-toggle-thumb" />
              </div>
            </div>
            {mode3d && onMode3dAutoRotateChange && (
              <div
                className="physics-toggle-row"
                onClick={() => onMode3dAutoRotateChange(!mode3dAutoRotate)}
                style={{ paddingLeft: 8 }}
              >
                <span className="physics-toggle-label">Auto-rotate</span>
                <div
                  className={`physics-toggle-track${mode3dAutoRotate ? ' on' : ''}`}
                >
                  <div className="physics-toggle-thumb" />
                </div>
              </div>
            )}
            {mode3d && onMode3dSpeedChange && (
              <div className="physics-slider-row">
                <div className="physics-slider-label">
                  <span>Rotation speed</span>
                  <span className="physics-slider-value">{mode3dSpeed}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={mode3dSpeed}
                  onInput={(e) =>
                    onMode3dSpeedChange(Number(e.currentTarget.value))
                  }
                />
              </div>
            )}
            {mode3d && onMode3dTiltChange && (
              <div className="physics-slider-row">
                <div className="physics-slider-label">
                  <span>Camera tilt</span>
                  <span className="physics-slider-value">{mode3dTilt}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={mode3dTilt}
                  onInput={(e) =>
                    onMode3dTiltChange(Number(e.currentTarget.value))
                  }
                />
              </div>
            )}
          </>
        )}

        <div className="physics-divider" />

        <h4 className="physics-panel-title">Physics</h4>

        <div className="physics-slider-row">
          <div className="physics-slider-label">
            <span>Repulsion</span>
            <span className="physics-slider-value">{localRepulsion}</span>
          </div>
          <input
            type="range"
            min={10}
            max={500}
            step={10}
            value={localRepulsion}
            onInput={handleRepulsionInput}
          />
        </div>

        {/* Link distance — both modes */}
        {pixiMode && onLinkDistanceChange && (
          <div className="physics-slider-row">
            <div className="physics-slider-label">
              <span>Link distance</span>
              <span className="physics-slider-value">{linkDistance}</span>
            </div>
            <input
              type="range"
              min={5}
              max={500}
              value={linkDistance}
              onInput={(e) =>
                onLinkDistanceChange(Number(e.currentTarget.value))
              }
            />
          </div>
        )}

        {/* Spread-only: center pull */}
        {pixiMode && layoutMode === 'spread' && onCenterStrengthChange && (
          <div className="physics-slider-row">
            <div className="physics-slider-label">
              <span>Center pull</span>
              <span className="physics-slider-value">
                {Math.round(centerStrength * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={100}
              value={Math.round(centerStrength * 100)}
              onInput={(e) =>
                onCenterStrengthChange(Number(e.currentTarget.value) / 100)
              }
            />
          </div>
        )}

        {/* Compact-only: radial pull */}
        {pixiMode && layoutMode === 'compact' && onRadialStrengthChange && (
          <div className="physics-slider-row">
            <div className="physics-slider-label">
              <span>Radial pull</span>
              <span className="physics-slider-value">{radialStrength}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={50}
              value={radialStrength}
              onInput={(e) =>
                onRadialStrengthChange(Number(e.currentTarget.value))
              }
            />
          </div>
        )}

        {/* Compact-only: community pull. Disabled when communities are
            off — the underlying force needs community assignments which
            Louvain produces. */}
        {pixiMode && layoutMode === 'compact' && onCommunityPullChange && (
          <div
            className="physics-slider-row"
            style={
              communitiesEnabled
                ? undefined
                : { opacity: 0.4, pointerEvents: 'none' }
            }
          >
            <div className="physics-slider-label">
              <span>Community pull</span>
              <span className="physics-slider-value">{communityPull}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={50}
              value={communityPull}
              disabled={!communitiesEnabled}
              onInput={(e) =>
                onCommunityPullChange(Number(e.currentTarget.value))
              }
            />
          </div>
        )}

        {/* Compact-only: circle radius */}
        {pixiMode && layoutMode === 'compact' && onCircleRadiusChange && (
          <div className="physics-slider-row">
            <div className="physics-slider-label">
              <span>Circle size</span>
              <span className="physics-slider-value">{circleRadius}</span>
            </div>
            <input
              type="range"
              min={8}
              max={80}
              value={circleRadius}
              onInput={(e) =>
                onCircleRadiusChange(Number(e.currentTarget.value))
              }
            />
          </div>
        )}

        {/* Compact-only: centering strength */}
        {pixiMode && layoutMode === 'compact' && onCenteringStrengthChange && (
          <div className="physics-slider-row">
            <div className="physics-slider-label">
              <span>Centering</span>
              <span className="physics-slider-value">{centeringStrength}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={30}
              value={centeringStrength}
              onInput={(e) =>
                onCenteringStrengthChange(Number(e.currentTarget.value))
              }
            />
          </div>
        )}

        {/* Pixi: zoom-size exponent slider */}
        {pixiMode && onZoomSizeExponentChange && (
          <div className="physics-slider-row">
            <div className="physics-slider-label">
              <span>Zoom scaling</span>
              <span className="physics-slider-value">
                {Math.round(zoomSizeExponent * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(zoomSizeExponent * 100)}
              onInput={(e) =>
                onZoomSizeExponentChange(Number(e.currentTarget.value) / 100)
              }
            />
          </div>
        )}

        {/* Label scale — independent of node size */}
        {pixiMode && onLabelScaleChange && (
          <div className="physics-slider-row">
            <div className="physics-slider-label">
              <span>Label size</span>
              <span className="physics-slider-value">{labelScale}%</span>
            </div>
            <input
              type="range"
              min={10}
              max={300}
              value={labelScale}
              onInput={(e) => onLabelScaleChange(Number(e.currentTarget.value))}
            />
          </div>
        )}

        <div className="physics-divider" />

        {/* Pixi: reheat + fit buttons */}
        {pixiMode && onReheat && onFitToScreen && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
            <button
              className="physics-action-btn"
              style={{ flex: 1 }}
              onClick={onReheat}
            >
              Reheat
            </button>
            <button
              className="physics-action-btn"
              style={{ flex: 1 }}
              onClick={onFitToScreen}
            >
              Fit to screen
            </button>
          </div>
        )}

        <button
          className="physics-action-btn"
          onClick={isPhysicsRunning ? onStopPhysics : onStartPhysics}
        >
          {isPhysicsRunning ? (
            <>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
              Stop Physics
            </>
          ) : (
            <>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <polygon points="5,3 19,12 5,21" />
              </svg>
              Start Physics
            </>
          )}
        </button>
      </div>
    </div>
  );
}
