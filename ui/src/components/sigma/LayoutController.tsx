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
import noverlap from 'graphology-layout-noverlap';
import { zoomToFit } from './zoomToNodes';
import {
  FA2_ENABLED,
  FA2_GRAVITY,
  FA2_SCALING_RATIO,
  FA2_SLOW_DOWN,
  FA2_BARNES_HUT_THRESHOLD,
  FA2_BARNES_HUT_THETA,
  FA2_STRONG_GRAVITY,
  FA2_LIN_LOG_MODE,
  FA2_OUTBOUND_ATTRACTION,
  FA2_ADJUST_SIZES,
  FA2_DURATION,
  NOVERLAP_MAX_ITERATIONS,
  NOVERLAP_RATIO,
  NOVERLAP_MARGIN,
  NOVERLAP_EXPANSION,
} from '../../config/graphLayout';

interface LayoutControllerProps {
  nodeCount: number;
  /** When true, d3-force positions are applied and FA2 can start */
  layoutReady: boolean;
}

export default function LayoutController({
  nodeCount,
  layoutReady,
}: LayoutControllerProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const sigma = useSigma();

  const { start, stop } = useWorkerLayoutForceAtlas2({
    settings: {
      gravity: FA2_GRAVITY,
      scalingRatio: FA2_SCALING_RATIO,
      slowDown: FA2_SLOW_DOWN,
      barnesHutOptimize: nodeCount > FA2_BARNES_HUT_THRESHOLD,
      barnesHutTheta: FA2_BARNES_HUT_THETA,
      strongGravityMode: FA2_STRONG_GRAVITY,
      linLogMode: FA2_LIN_LOG_MODE,
      outboundAttractionDistribution: FA2_OUTBOUND_ATTRACTION,
      adjustSizes: FA2_ADJUST_SIZES,
    },
  });

  useEffect(() => {
    // Don't start FA2 until d3-force worker has delivered positions
    if (!layoutReady) return;

    const sigmaInstance = sigma as unknown as import('sigma').Sigma;
    const graph = sigma.getGraph();

    if (FA2_ENABLED && graph.order > 0) {
      start();
      runningRef.current = true;

      timerRef.current = setTimeout(() => {
        stop();
        runningRef.current = false;

        // Noverlap cleanup — scale iterations down for large graphs to avoid freeze
        if (graph.order > 0) {
          const maxIter =
            graph.order > 5000
              ? Math.max(
                  5,
                  Math.round(NOVERLAP_MAX_ITERATIONS * (5000 / graph.order)),
                )
              : NOVERLAP_MAX_ITERATIONS;

          noverlap.assign(graph, {
            maxIterations: maxIter,
            settings: {
              ratio: NOVERLAP_RATIO,
              margin: NOVERLAP_MARGIN,
              expansion: NOVERLAP_EXPANSION,
            },
          });
        }

        zoomToFit(sigmaInstance, 600);
      }, FA2_DURATION);

      // Initial zoom to fit
      zoomToFit(sigmaInstance, 0);
    } else {
      // No FA2 — just noverlap + zoom
      if (graph.order > 0) {
        const maxIter =
          graph.order > 5000
            ? Math.max(
                5,
                Math.round(NOVERLAP_MAX_ITERATIONS * (5000 / graph.order)),
              )
            : NOVERLAP_MAX_ITERATIONS;

        noverlap.assign(graph, {
          maxIterations: maxIter,
          settings: {
            ratio: NOVERLAP_RATIO,
            margin: NOVERLAP_MARGIN,
            expansion: NOVERLAP_EXPANSION,
          },
        });
      }

      zoomToFit(sigmaInstance, 0);
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      // Always call stop — safe to call on an already-stopped worker
      stop();
      runningRef.current = false;
    };
  }, [layoutReady, nodeCount, start, stop, sigma]);

  return null;
}
