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
 * Viewport math utilities for the Pixi.js graph renderer.
 *
 * The viewport maps between screen coordinates and world (graph) coordinates.
 * The world container's position and scale are controlled by these values:
 *   world.position = (vpX, vpY)   — screen position of world origin
 *   world.scale    = vpScale      — zoom level
 */

export interface Viewport {
  x: number; // screen X of world origin
  y: number; // screen Y of world origin
  scale: number; // zoom scale (1 = 1:1)
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Convert screen coordinates to world coordinates. */
export function screenToWorld(
  screenX: number,
  screenY: number,
  vp: Viewport,
): { x: number; y: number } {
  return {
    x: (screenX - vp.x) / vp.scale,
    y: (screenY - vp.y) / vp.scale,
  };
}

/** Convert world coordinates to screen coordinates. */
export function worldToScreen(
  worldX: number,
  worldY: number,
  vp: Viewport,
): { x: number; y: number } {
  return {
    x: worldX * vp.scale + vp.x,
    y: worldY * vp.scale + vp.y,
  };
}

/** Compute the bounding box of a set of positions. */
export function computeBounds(
  positions: Iterable<{ x: number; y: number }>,
): Bounds {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const p of positions) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

/** Compute viewport that fits the given bounds into a canvas of (w, h). */
export function fitBounds(
  bounds: Bounds,
  canvasWidth: number,
  canvasHeight: number,
  padding = 80,
): Viewport {
  const bw = bounds.maxX - bounds.minX || 1;
  const bh = bounds.maxY - bounds.minY || 1;
  const scale = Math.min(
    (canvasWidth - padding * 2) / bw,
    (canvasHeight - padding * 2) / bh,
  );
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return {
    x: canvasWidth / 2 - cx * scale,
    y: canvasHeight / 2 - cy * scale,
    scale,
  };
}

/** Smoothly animate from one viewport to another. Returns a cancel function. */
export function animateViewport(
  from: Viewport,
  to: Viewport,
  durationMs: number,
  onFrame: (vp: Viewport) => void,
  onComplete?: () => void,
): () => void {
  const startTime = performance.now();
  let cancelled = false;

  function step() {
    if (cancelled) return;
    const elapsed = performance.now() - startTime;
    const t = Math.min(elapsed / durationMs, 1);
    // Ease-out cubic
    const ease = 1 - Math.pow(1 - t, 3);
    const vp: Viewport = {
      x: from.x + (to.x - from.x) * ease,
      y: from.y + (to.y - from.y) * ease,
      scale: from.scale + (to.scale - from.scale) * ease,
    };
    onFrame(vp);
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      onComplete?.();
    }
  }

  requestAnimationFrame(step);
  return () => {
    cancelled = true;
  };
}
