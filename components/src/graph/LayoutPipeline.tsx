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

interface LayoutPipelineProps {
  layoutReady: boolean;
  layoutConfig: LayoutConfig;
  optimizeTick: number;
  /** Called with the current optimize status for UI display */
  onOptimizeStatus?: (status: OptimizeStatus | null) => void;
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
}: LayoutPipelineProps) {
  const sigma = useSigma();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  });

  // ─── Cleanup helpers ─────────────────────────────────────────────

  function cleanup() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    stop();
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
      timerRef.current = setTimeout(() => {
        stop();
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
