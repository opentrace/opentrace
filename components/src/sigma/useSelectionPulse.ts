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
 * Selection highlight: one expanding ring on select, then a steady halo.
 *
 * - On selection: ring expands from 1x to 2x over 400ms, fading out
 * - After the ping: static halo ring at 1.2x node size, alpha 0.3
 *
 * Draws synchronously in sigma's afterRender to avoid flicker during
 * physics or drag (rAF would race with sigma's canvas clears).
 */

import { useEffect, useRef } from 'react';
import type Sigma from 'sigma';

const PING_DURATION = 400;
const PING_MAX_SCALE = 2.0;
const PING_ALPHA = 0.5;
const HALO_SCALE = 1.05;
const HALO_ALPHA = 0.35;
const HALO_LINE_WIDTH = 5;

export function useSelectionPulse(
  sigma: Sigma | null,
  selectedNodeId: string | null,
  enabled: boolean,
) {
  const startTimeRef = useRef<number>(0);
  const pingRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!sigma || !selectedNodeId || !enabled) {
      if (pingRafRef.current !== null) {
        cancelAnimationFrame(pingRafRef.current);
        pingRafRef.current = null;
      }
      return;
    }

    const graph = sigma.getGraph();
    if (!graph.hasNode(selectedNodeId)) return;

    startTimeRef.current = performance.now();

    // Ping animation: runs its own rAF loop for the first 400ms,
    // forcing sigma refreshes so the expanding ring is visible.
    function safeRefresh() {
      try {
        sigma?.refresh();
      } catch {
        // sigma may not be fully initialized (e.g. HMR reload)
      }
    }

    function pingLoop() {
      if (!sigma || !selectedNodeId) return;
      const elapsed = performance.now() - startTimeRef.current;
      if (elapsed < PING_DURATION) {
        safeRefresh();
        pingRafRef.current = requestAnimationFrame(pingLoop);
      } else {
        pingRafRef.current = null;
        safeRefresh();
      }
    }
    pingRafRef.current = requestAnimationFrame(pingLoop);

    // Draw synchronously in afterRender — no flicker.
    const handler = () => {
      if (!sigma || !selectedNodeId) return;

      const graph = sigma.getGraph();
      if (!graph.hasNode(selectedNodeId)) return;

      const attrs = graph.getNodeAttributes(selectedNodeId);
      const nodePosition = sigma.graphToViewport({
        x: attrs.x as number,
        y: attrs.y as number,
      });

      const camera = sigma.getCamera();
      const baseSize = (attrs.size as number) ?? 5;
      const screenSize = baseSize / camera.ratio;

      const container = sigma.getContainer();
      const canvas = container.querySelector(
        '.sigma-hovers',
      ) as HTMLCanvasElement | null;
      if (!canvas) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const color = (attrs.color as string) ?? '#ffffff';
      const elapsed = performance.now() - startTimeRef.current;

      if (elapsed < PING_DURATION) {
        // Expanding ping ring
        const t = elapsed / PING_DURATION;
        const scale = 1.0 + (PING_MAX_SCALE - 1.0) * t;
        const alpha = PING_ALPHA * (1 - t);

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(
          nodePosition.x,
          nodePosition.y,
          screenSize * scale,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
        ctx.restore();
      }

      // Steady halo (always drawn, even during ping)
      ctx.save();
      ctx.globalAlpha = HALO_ALPHA;
      ctx.strokeStyle = color;
      ctx.lineWidth = HALO_LINE_WIDTH;
      ctx.beginPath();
      ctx.arc(
        nodePosition.x,
        nodePosition.y,
        screenSize * HALO_SCALE,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      ctx.restore();
    };

    sigma.on('afterRender', handler);
    safeRefresh();

    return () => {
      sigma.off('afterRender', handler);
      if (pingRafRef.current !== null) {
        cancelAnimationFrame(pingRafRef.current);
        pingRafRef.current = null;
      }
    };
  }, [sigma, selectedNodeId, enabled]);
}
