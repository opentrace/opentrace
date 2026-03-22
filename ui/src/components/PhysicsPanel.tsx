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

import { useCallback, useRef, useEffect } from 'react';
import './PhysicsPanel.css';

interface PhysicsPanelProps {
  repulsion: number;
  onRepulsionChange: (value: number) => void;
  labelsVisible: boolean;
  onLabelsVisibleChange: (visible: boolean) => void;
  colorMode: 'type' | 'community';
  onColorModeChange: (mode: 'type' | 'community') => void;
  flatMode: boolean;
  onFlatModeChange: (flat: boolean) => void;
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
  communityGravityEnabled?: boolean;
  onCommunityGravityEnabledChange?: (enabled: boolean) => void;
  communityGravityStrength?: number;
  onCommunityGravityStrengthChange?: (value: number) => void;
  zoomSizeExponent?: number;
  onZoomSizeExponentChange?: (value: number) => void;
  onReheat?: () => void;
  onFitToScreen?: () => void;
}

export default function PhysicsPanel({
  repulsion,
  onRepulsionChange,
  labelsVisible,
  onLabelsVisibleChange,
  colorMode,
  onColorModeChange,
  flatMode,
  onFlatModeChange,
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
  communityGravityEnabled = false,
  onCommunityGravityEnabledChange,
  communityGravityStrength = 0.1,
  onCommunityGravityStrengthChange,
  zoomSizeExponent = 0.8,
  onZoomSizeExponentChange,
  onReheat,
  onFitToScreen,
}: PhysicsPanelProps) {
  // Debounce repulsion slider changes (200ms)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localRef = useRef(repulsion);

  useEffect(() => {
    localRef.current = repulsion;
  }, [repulsion]);

  const handleRepulsionInput = useCallback(
    (e: React.FormEvent<HTMLInputElement>) => {
      const value = Number(e.currentTarget.value);
      localRef.current = value;
      // Update the displayed value immediately via the input
      e.currentTarget.parentElement
        ?.querySelector('.physics-slider-value')
        ?.replaceChildren(String(value));

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
    <div className="physics-panel">
      <h4 className="physics-panel-title">Display</h4>

      <div
        className="physics-toggle-row"
        onClick={() =>
          onColorModeChange(colorMode === 'type' ? 'community' : 'type')
        }
      >
        <span className="physics-toggle-label">Community colors</span>
        <div
          className={`physics-toggle-track${colorMode === 'community' ? ' on' : ''}`}
        >
          <div className="physics-toggle-thumb" />
        </div>
      </div>

      <div
        className="physics-toggle-row"
        onClick={() => onFlatModeChange(!flatMode)}
      >
        <span className="physics-toggle-label">Flat layout</span>
        <div className={`physics-toggle-track${flatMode ? ' on' : ''}`}>
          <div className="physics-toggle-thumb" />
        </div>
      </div>

      <div
        className="physics-toggle-row"
        onClick={() => onLabelsVisibleChange(!labelsVisible)}
      >
        <span className="physics-toggle-label">Show labels</span>
        <div className={`physics-toggle-track${labelsVisible ? ' on' : ''}`}>
          <div className="physics-toggle-thumb" />
        </div>
      </div>

      {/* Pixi: show edges toggle */}
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

      {/* Pixi: community clusters toggle + gravity */}
      {pixiMode && onCommunityGravityEnabledChange && (
        <>
          <div
            className="physics-toggle-row"
            onClick={() =>
              onCommunityGravityEnabledChange(!communityGravityEnabled)
            }
          >
            <span className="physics-toggle-label">Community clusters</span>
            <div
              className={`physics-toggle-track${communityGravityEnabled ? ' on' : ''}`}
            >
              <div className="physics-toggle-thumb" />
            </div>
          </div>
          {communityGravityEnabled && onCommunityGravityStrengthChange && (
            <div className="physics-slider-row">
              <div className="physics-slider-label">
                <span>Cluster gravity</span>
                <span className="physics-slider-value">
                  {Math.round(communityGravityStrength * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={50}
                value={Math.round(communityGravityStrength * 100)}
                onInput={(e) =>
                  onCommunityGravityStrengthChange(
                    Number(e.currentTarget.value) / 100,
                  )
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
          <span className="physics-slider-value">{repulsion}</span>
        </div>
        <input
          type="range"
          min={10}
          max={500}
          step={10}
          defaultValue={repulsion}
          onInput={handleRepulsionInput}
        />
      </div>

      {/* Pixi: link distance slider */}
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
            onInput={(e) => onLinkDistanceChange(Number(e.currentTarget.value))}
          />
        </div>
      )}

      {/* Pixi: center strength slider */}
      {pixiMode && onCenterStrengthChange && (
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
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
            Stop Physics
          </>
        ) : (
          <>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5,3 19,12 5,21" />
            </svg>
            Start Physics
          </>
        )}
      </button>
    </div>
  );
}
