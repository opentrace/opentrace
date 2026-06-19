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

import type { GraphCanvasHandle } from '@opentrace/components';
import { type Dispatch, type RefObject, type SetStateAction } from 'react';

type LayoutMode = 'spread' | 'compact';

const FullscreenEnterIcon = () => (
  <>
    <polyline points="3 8 3 3 8 3" />
    <polyline points="16 3 21 3 21 8" />
    <polyline points="21 16 21 21 16 21" />
    <polyline points="8 21 3 21 3 16" />
  </>
);

const FullscreenExitIcon = () => (
  <>
    <polyline points="4 14 4 20 10 20" />
    <polyline points="20 10 20 4 14 4" />
  </>
);

const SearchIcon = ({ withCross }: { withCross: boolean }) => (
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
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
    {withCross && (
      <>
        <line x1="11" y1="8" x2="11" y2="14" />
        <line x1="8" y1="11" x2="14" y2="11" />
      </>
    )}
  </svg>
);

const PlusIcon = () => (
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
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const MinusIcon = () => (
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
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const ZoomToFitIcon = () => (
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
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </svg>
);

const PhysicsIcon = () => (
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
    <line x1="4" y1="21" x2="4" y2="14" />
    <line x1="4" y1="10" x2="4" y2="3" />
    <line x1="12" y1="21" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12" y2="3" />
    <line x1="20" y1="21" x2="20" y2="16" />
    <line x1="20" y1="12" x2="20" y2="3" />
    <line x1="1" y1="14" x2="7" y2="14" />
    <line x1="9" y1="8" x2="15" y2="8" />
    <line x1="17" y1="16" x2="23" y2="16" />
  </svg>
);

const LayoutIcon = ({ compact }: { compact: boolean }) => (
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
    {compact ? (
      // Three tight clusters — visually distinct from Zoom-to-fit's
      // outward arrows (Fix #40).
      <>
        <circle cx="7" cy="7" r="2.2" />
        <circle cx="17" cy="7" r="2.2" />
        <circle cx="12" cy="17" r="2.2" />
      </>
    ) : (
      // Spread mode: ring of scattered points
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="6" r="1" fill="currentColor" />
        <circle cx="6" cy="14" r="1" fill="currentColor" />
        <circle cx="18" cy="14" r="1" fill="currentColor" />
      </>
    )}
  </svg>
);

const ResetIcon = () => (
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
    {/* Circular refresh arrow — universally legible "reset" symbol. */}
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <polyline points="21 3 21 9 15 9" />
  </svg>
);

const DimensionIcon = ({ is3d }: { is3d: boolean }) => (
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
    {is3d ? (
      <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />
    ) : (
      <path d="M12 2l9 5v10l-9 5-9-5V7z M12 12l9-5 M12 12v10 M12 12L3 7" />
    )}
  </svg>
);

interface GraphControlsBarProps {
  canvasRef: RefObject<GraphCanvasHandle | null>;

  graphFullscreen?: boolean;
  onToggleGraphFullscreen?: () => void;

  zoomOnSelect: boolean;
  setZoomOnSelect: Dispatch<SetStateAction<boolean>>;

  showPhysicsPanel: boolean;
  setShowPhysicsPanel: Dispatch<SetStateAction<boolean>>;
  /** Optional ref attached to the physics-tuner button — paired with the
   *  panel ref by callers that close the panel on outside clicks. */
  physicsTriggerRef?: RefObject<HTMLButtonElement | null>;

  layoutMode: LayoutMode;
  setLayoutMode: Dispatch<SetStateAction<LayoutMode>>;

  mode3d: boolean;
  setMode3d: Dispatch<SetStateAction<boolean>>;

  /** Override for the "Reset graph" button click. When provided, replaces
   *  the default behaviour (reheat physics + reset camera) with a full
   *  settings-and-state reset — used by callers that wire it to
   *  `settings.resetSettings`. */
  onResetGraph?: () => void;
}

/** Bottom-right control bar with mobile toggle and zoom/layout/3D buttons. */
export const GraphControlsBar = ({
  canvasRef,
  graphFullscreen,
  onToggleGraphFullscreen,
  zoomOnSelect,
  setZoomOnSelect,
  showPhysicsPanel,
  setShowPhysicsPanel,
  physicsTriggerRef,
  layoutMode,
  setLayoutMode,
  mode3d,
  setMode3d,
  onResetGraph,
}: GraphControlsBarProps) => {
  return (
    <div className="graph-controls">
      {onToggleGraphFullscreen && (
        <button
          className={`graph-control-btn graph-controls-fullscreen${graphFullscreen ? ' graph-control-btn--active' : ''}`}
          onClick={onToggleGraphFullscreen}
          title={graphFullscreen ? 'Exit fullscreen' : 'Fullscreen graph'}
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
            {graphFullscreen ? <FullscreenExitIcon /> : <FullscreenEnterIcon />}
          </svg>
        </button>
      )}

      <div className="graph-controls-items graph-controls-items--open">
        <button
          className={`graph-control-btn${zoomOnSelect ? ' graph-control-btn--active' : ''}`}
          onClick={() => setZoomOnSelect((z) => !z)}
          title={
            zoomOnSelect
              ? 'Zoom to node on click (on)'
              : 'Zoom to node on click (off)'
          }
        >
          <SearchIcon withCross={zoomOnSelect} />
        </button>

        <button
          className="graph-control-btn"
          onClick={() => canvasRef.current?.zoomIn()}
          title="Zoom in"
        >
          <PlusIcon />
        </button>

        <button
          className="graph-control-btn"
          onClick={() => canvasRef.current?.zoomOut()}
          title="Zoom out"
        >
          <MinusIcon />
        </button>

        <button
          className="graph-control-btn"
          onClick={() => canvasRef.current?.resetCamera()}
          title="Zoom to fit"
        >
          <ZoomToFitIcon />
        </button>

        <button
          className="graph-control-btn"
          onClick={() => {
            if (onResetGraph) {
              onResetGraph();
            } else {
              // Default: reheat physics so the layout reflows from current
              // positions, then re-fit the view.
              canvasRef.current?.reheat?.();
              canvasRef.current?.resetCamera();
            }
          }}
          title="Reset graph"
        >
          <ResetIcon />
        </button>

        <button
          ref={physicsTriggerRef}
          className={`graph-control-btn${showPhysicsPanel ? ' graph-control-btn--active' : ''}`}
          onClick={() => setShowPhysicsPanel((v) => !v)}
          title="Physics tuner"
        >
          <PhysicsIcon />
        </button>

        <button
          className={`graph-control-btn${layoutMode === 'compact' ? ' graph-control-btn--active' : ''}`}
          onClick={() => {
            const next = layoutMode === 'spread' ? 'compact' : 'spread';
            setLayoutMode(next);
            canvasRef.current?.setLayoutMode?.(next);
          }}
          title={
            layoutMode === 'compact'
              ? 'Switch to spread layout'
              : 'Switch to compact layout'
          }
        >
          <LayoutIcon compact={layoutMode === 'compact'} />
        </button>

        <button
          className={`graph-control-btn${mode3d ? ' graph-control-btn--active' : ''}`}
          onClick={() => {
            const next = !mode3d;
            setMode3d(next);
            canvasRef.current?.set3DMode?.(next);
          }}
          title={mode3d ? 'Switch to 2D' : 'Switch to 3D'}
        >
          <DimensionIcon is3d={mode3d} />
        </button>
      </div>
    </div>
  );
};
