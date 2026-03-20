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
import type {
  SpacingNode,
  SpacingRequest,
  SpacingResponse,
} from './spacingWorker';

interface LayoutPipelineProps {
  layoutReady: boolean;
  layoutConfig: LayoutConfig;
  optimizeTick: number;
  /** Community assignments for size-aware community spacing */
  communityAssignments?: Record<string, number>;
  /** Called with the current optimize status for UI display */
  onOptimizeStatus?: (status: OptimizeStatus | null) => void;
}

export interface OptimizeStatus {
  phase: 'fa2' | 'noverlap' | 'spacing' | 'optimizing' | 'done';
  iteration?: number;
  cleanRatio?: number;
  totalOverlaps?: number;
}

/**
 * Renderless component that orchestrates the layout pipeline inside a
 * `<SigmaContainer>`. Requires `useSigma()` context.
 *
 * Pipeline: ForceAtlas2 → Noverlap → Optimize → Zoom-to-fit
 * Optimize button: re-runs FA2 → Noverlap → Optimize
 */
export default function LayoutPipeline({
  layoutReady,
  layoutConfig,
  optimizeTick,
  communityAssignments,
  onOptimizeStatus,
}: LayoutPipelineProps) {
  const sigma = useSigma();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spacingWorkerRef = useRef<Worker | null>(null);
  const perCommunityNoverlapCancel = useRef<(() => void) | null>(null);

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
    if (spacingWorkerRef.current) {
      spacingWorkerRef.current.terminate();
      spacingWorkerRef.current = null;
    }
    perCommunityNoverlapCancel.current?.();
    perCommunityNoverlapCancel.current = null;
    stop();
  }

  // ─── Community spacing step ───────────────────────────────────────
  // Runs in a Web Worker. Iteratively pushes community centroids apart
  // from each other. Posts position updates after each iteration so the
  // graph updates live. Runs BEFORE FA2.

  function runSpacing(onDone: () => void) {
    const graph = sigma.getGraph();
    if (graph.order === 0 || !communityAssignments) {
      onDone();
      return;
    }

    onOptimizeStatus?.({ phase: 'spacing' });

    const nodes: SpacingNode[] = [];
    graph.forEachNode((id, attrs) => {
      const cid = communityAssignments[id];
      if (cid === undefined) return;
      nodes.push({
        id,
        x: attrs.x as number,
        y: attrs.y as number,
        communityId: cid,
      });
    });

    const worker = new Worker(new URL('./spacingWorker.ts', import.meta.url), {
      type: 'module',
    });
    spacingWorkerRef.current = worker;

    worker.onmessage = (e: MessageEvent<SpacingResponse>) => {
      const msg = e.data;

      if (msg.type === 'progress') {
        if (msg.updates.length > 0) {
          const posMap = new Map<string, { x: number; y: number }>();
          for (const u of msg.updates) posMap.set(u.id, { x: u.x, y: u.y });
          graph.updateEachNodeAttributes((id, attrs) => {
            const pos = posMap.get(id);
            if (pos) {
              attrs.x = pos.x;
              attrs.y = pos.y;
            }
            return attrs;
          });
        }

        onOptimizeStatus?.({
          phase: 'spacing',
          iteration: msg.iteration,
          cleanRatio: 1 - msg.maxOverlap,
        });

        if (process.env.NODE_ENV === 'development') {
          console.log(
            `%c[spacing]%c iter ${msg.iteration}: overlap ${(msg.maxOverlap * 100).toFixed(0)}%, ${msg.updates.length} nodes moved`,
            'color: #fbbf24; font-weight: bold',
            'color: inherit',
          );
        }
      } else if (msg.type === 'done') {
        if (process.env.NODE_ENV === 'development') {
          console.log(
            `%c[spacing]%c done: ${msg.iterations} iters, ${(msg.maxOverlap * 100).toFixed(0)}% max overlap in ${msg.totalMs.toFixed(0)}ms`,
            'color: #fbbf24; font-weight: bold',
            'color: inherit',
          );
        }
        worker.terminate();
        spacingWorkerRef.current = null;
        onDone();
      }
    };

    worker.onerror = () => {
      worker.terminate();
      spacingWorkerRef.current = null;
      onDone();
    };

    worker.postMessage({
      nodes,
      radiusScale: 40,
      gap: 100,
      maxIterations: 50,
      overlapThreshold: 0.05,
    } satisfies SpacingRequest);
  }

  /** Compute scale factor to convert screen-pixel sizes to graph-coordinate sizes. */
  function getGraphScaleFactor(): number {
    const graph = sigma.getGraph();
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    graph.forEachNode((_, attrs) => {
      const x = attrs.x as number;
      const y = attrs.y as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    });
    return Math.max(maxX - minX, maxY - minY, 1) / 4000;
  }

  // ─── Per-community noverlap ─────────────────────────────────────
  // Runs noverlap within each community separately so nodes spread
  // out without drifting across community boundaries. Uses
  // requestIdleCallback to yield between communities.

  function runPerCommunityNoverlap(onDone: () => void) {
    const graph = sigma.getGraph();
    if (graph.order === 0 || !communityAssignments) {
      onDone();
      return;
    }

    const scale = getGraphScaleFactor();

    // Group node IDs by community
    const groups = new Map<number, string[]>();
    graph.forEachNode((id) => {
      const cid = communityAssignments[id];
      if (cid === undefined) return;
      let list = groups.get(cid);
      if (!list) {
        list = [];
        groups.set(cid, list);
      }
      list.push(id);
    });

    // Sort largest first for most visual impact early
    const sorted = [...groups.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    );

    // Max inline community size — larger communities are skipped (spacing handles them)
    const MAX_INLINE = 500;

    let idx = 0;
    let totalMoved = 0;
    let cancelled = false;
    let pendingCallbackId: number | ReturnType<typeof setTimeout> | null = null;
    perCommunityNoverlapCancel.current = () => {
      cancelled = true;
      if (pendingCallbackId !== null) {
        if (typeof cancelIdleCallback === 'function') {
          cancelIdleCallback(pendingCallbackId as number);
        } else {
          clearTimeout(pendingCallbackId);
        }
        pendingCallbackId = null;
      }
    };

    function processNext() {
      if (cancelled || idx >= sorted.length) {
        if (process.env.NODE_ENV === 'development') {
          console.log(
            `%c[noverlap]%c per-community done: ${sorted.length} communities, ${totalMoved} nodes moved${cancelled ? ' (cancelled)' : ''}`,
            'color: #4ade80; font-weight: bold',
            'color: inherit',
          );
        }
        perCommunityNoverlapCancel.current = null;
        if (!cancelled) onDone();
        return;
      }

      const [, nodeIds] = sorted[idx++];

      // Skip tiny or too-large communities
      if (nodeIds.length < 3 || nodeIds.length > MAX_INLINE) {
        scheduleNext();
        return;
      }

      // Build position map for this community's nodes
      const subGraph = new Map<
        string,
        { x: number; y: number; size: number }
      >();
      for (const nid of nodeIds) {
        const attrs = graph.getNodeAttributes(nid);
        subGraph.set(nid, {
          x: attrs.x as number,
          y: attrs.y as number,
          size: ((attrs.size as number) ?? 3) * scale,
        });
      }

      // Iterative push-apart within this community
      const margin = layoutConfig.noverlapMargin * scale;
      const iters = layoutConfig.noverlapCommunityIterations ?? 20;
      const nodeArr = [...subGraph.entries()];
      for (let iter = 0; iter < iters; iter++) {
        for (let i = 0; i < nodeArr.length; i++) {
          const [, a] = nodeArr[i];
          for (let j = i + 1; j < nodeArr.length; j++) {
            const [, b] = nodeArr[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const minDist = a.size + b.size + margin;
            if (dist < minDist && dist > 0.001) {
              const push = (minDist - dist) * 0.5;
              const nx = dx / dist;
              const ny = dy / dist;
              a.x -= nx * push;
              a.y -= ny * push;
              b.x += nx * push;
              b.y += ny * push;
            }
          }
        }
      }

      // Write back
      let moved = 0;
      for (const [nid, pos] of subGraph) {
        const attrs = graph.getNodeAttributes(nid);
        if (
          Math.abs(pos.x - (attrs.x as number)) > 0.1 ||
          Math.abs(pos.y - (attrs.y as number)) > 0.1
        ) {
          graph.mergeNodeAttributes(nid, { x: pos.x, y: pos.y });
          moved++;
        }
      }
      totalMoved += moved;

      scheduleNext();
    }

    function scheduleNext() {
      if (typeof requestIdleCallback === 'function') {
        pendingCallbackId = requestIdleCallback(processNext, { timeout: 50 });
      } else {
        pendingCallbackId = setTimeout(processNext, 0);
      }
    }

    processNext();
  }

  // ─── Main effect ─────────────────────────────────────────────────

  useEffect(() => {
    if (!layoutReady) return;

    cleanup();

    const sigmaInstance = sigma as unknown as import('sigma').Sigma;
    const graph = sigma.getGraph();

    // Pipeline: Spacing → FA2 → Per-community noverlap → Spacing → FA2 (soften) → Zoom
    runSpacing(() => {
      zoomToFit(sigmaInstance, 0);

      const runFA2 = (duration: number, onDone: () => void) => {
        if (layoutConfig.fa2Enabled && graph.order > 0) {
          onOptimizeStatus?.({ phase: 'fa2' });
          start();
          timerRef.current = setTimeout(() => {
            stop();
            onDone();
          }, duration);
        } else {
          onDone();
        }
      };

      // Step 2: Initial FA2 — establish edge-based structure
      runFA2(layoutConfig.fa2Duration, () => {
        // Step 3: Per-community noverlap — spread stacked nodes
        onOptimizeStatus?.({ phase: 'noverlap' });
        runPerCommunityNoverlap(() => {
          // Step 4: Re-space communities after noverlap expanded them
          runSpacing(() => {
            // Step 5: Short FA2 pass — soften edges after spacing/noverlap moved things
            runFA2(Math.min(layoutConfig.fa2Duration, 1500), () => {
              zoomToFit(sigmaInstance, 600);
              onOptimizeStatus?.(null);
            });
          });
        });
      });
    });

    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutReady, optimizeTick, layoutConfig, start, stop, sigma]);

  return null;
}
