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

import { useEffect, useRef } from 'react';
import { useSigma } from '@react-sigma/core';
import { useWorkerLayoutForceAtlas2 } from '@react-sigma/layout-forceatlas2';
import { zoomToFit } from '../sigma/zoomToNodes';
import type { LayoutConfig } from './types';

/** Control handle exposed by LayoutPipeline for stop/start physics. */
export interface LayoutControl {
  stop: () => void;
  start: () => void;
  isRunning: () => boolean;
}

interface LayoutPipelineProps {
  layoutReady: boolean;
  layoutConfig: LayoutConfig;
  optimizeTick: number;
  /** Called with the current optimize status for UI display */
  onOptimizeStatus?: (status: OptimizeStatus | null) => void;
  /** Called once the FA2 worker is ready, exposing stop/start controls. */
  onLayoutControl?: (control: LayoutControl) => void;
}

export interface OptimizeStatus {
  phase: 'fa2' | 'done';
  iteration?: number;
  cleanRatio?: number;
  totalOverlaps?: number;
}

/**
 * Renderless component that orchestrates the layout pipeline inside a
 * `<SigmaContainer>`. Requires `useSigma()` context.
 *
 * Spacing + noverlap run pre-render in useGraphInstance.
 * This component only runs FA2 physics post-render.
 */
export default function LayoutPipeline({
  layoutReady,
  layoutConfig,
  optimizeTick,
  onOptimizeStatus,
  onLayoutControl,
}: LayoutPipelineProps) {
  const sigma = useSigma();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);

  // The outputReducer runs inside assignLayoutChanges after the worker's
  // x/y have already been written to attrs (in-place mutation).  For pinned
  // (dragged) nodes we restore the position from _pinnedX/_pinnedY — separate
  // attributes the worker never touches.  readGraphPositions then feeds the
  // corrected position back into the worker matrix so it converges around
  // the pinned location on subsequent iterations.
  const { start, stop } = useWorkerLayoutForceAtlas2({
    settings: {
      gravity: layoutConfig.fa2Gravity,
      scalingRatio: layoutConfig.fa2ScalingRatio,
      slowDown: layoutConfig.fa2SlowDown,
      barnesHutOptimize:
        sigma.getGraph().order > layoutConfig.fa2BarnesHutThreshold,
      barnesHutTheta: layoutConfig.fa2BarnesHutTheta,
      strongGravityMode: layoutConfig.fa2StrongGravity,
      linLogMode: layoutConfig.fa2LinLogMode,
      outboundAttractionDistribution: layoutConfig.fa2OutboundAttraction,
      adjustSizes: layoutConfig.fa2AdjustSizes,
    },
    outputReducer: (_key: string, attrs: Record<string, unknown>) => {
      if (attrs._pinnedX != null) {
        // Restore the drag position so the worker can't overwrite it.
        attrs.x = attrs._pinnedX;
        attrs.y = attrs._pinnedY;

        // Once the node is released (fixed → false), clear the pin.
        // readGraphPositions (called right after this) syncs the correct
        // position into the worker matrix, so subsequent iterations
        // compute forces from the right location.
        if (!attrs.fixed) {
          attrs._pinnedX = undefined;
          attrs._pinnedY = undefined;
        }
      }
      return attrs;
    },
  });

  // Expose layout control to parent
  useEffect(() => {
    onLayoutControl?.({
      stop: () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        stop();
        runningRef.current = false;
        onOptimizeStatus?.(null);
      },
      start: () => {
        start();
        runningRef.current = true;
        onOptimizeStatus?.({ phase: 'fa2' });
      },
      isRunning: () => runningRef.current,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, stop, onLayoutControl]);

  // ─── Cleanup helpers ─────────────────────────────────────────────

  function cleanup() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    stop();
    runningRef.current = false;
  }

  // ─── Main effect ─────────────────────────────────────────────────

  useEffect(() => {
    if (!layoutReady) return;

    cleanup();

    const sigmaInstance = sigma as unknown as import('sigma').Sigma;
    const graph = sigma.getGraph();

    // Spacing + noverlap already ran pre-render in useGraphInstance.
    // Post-render: just FA2 physics + zoom.
    zoomToFit(sigmaInstance, 0);

    if (layoutConfig.fa2Enabled && graph.order > 0) {
      onOptimizeStatus?.({ phase: 'fa2' });
      start();
      runningRef.current = true;
      timerRef.current = setTimeout(() => {
        stop();
        runningRef.current = false;
        onOptimizeStatus?.(null);
      }, layoutConfig.fa2Duration);
    } else {
      onOptimizeStatus?.(null);
    }

    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutReady, optimizeTick, layoutConfig, start, stop, sigma]);

  return null;
}
