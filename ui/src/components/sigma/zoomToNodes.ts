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

import type Sigma from 'sigma';

/**
 * Zoom the sigma camera to fit a set of node IDs with padding.
 *
 * Coordinates from `getNodeDisplayData` are in sigma's **framed graph space**
 * (normalized, pre-camera-transform). The camera also operates in this space.
 * To compute the correct zoom ratio we measure the visible framed-graph extent
 * at the current camera ratio via `viewportToFramedGraph`, then scale
 * proportionally so the bounding box fits with the requested padding.
 */
export function zoomToNodes(
  sigma: Sigma,
  nodeIds: Iterable<string>,
  duration = 600,
  padding = 0.2,
): void {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;

  for (const id of nodeIds) {
    const data = sigma.getNodeDisplayData(id);
    if (!data) continue;
    minX = Math.min(minX, data.x);
    maxX = Math.max(maxX, data.x);
    minY = Math.min(minY, data.y);
    maxY = Math.max(maxY, data.y);
    count++;
  }

  if (count === 0) return;

  const camera = sigma.getCamera();
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // Single node or near-coincident cluster — center and zoom in
  if (count === 1 || (maxX - minX < 0.001 && maxY - minY < 0.001)) {
    camera.animate({ x: cx, y: cy, ratio: 0.1 }, { duration });
    return;
  }

  // Measure visible framed-graph extent at the current camera ratio.
  // Since visible_extent ∝ camera.ratio, we can scale proportionally.
  const { width, height } = sigma.getDimensions();
  const topLeft = sigma.viewportToFramedGraph({ x: 0, y: 0 });
  const bottomRight = sigma.viewportToFramedGraph({ x: width, y: height });
  const visibleW = Math.abs(bottomRight.x - topLeft.x);
  const visibleH = Math.abs(topLeft.y - bottomRight.y);
  const currentRatio = camera.ratio;

  const bboxW = maxX - minX;
  const bboxH = maxY - minY;

  // How much of the current visible area the bbox would occupy (with padding)
  const scaleX = visibleW > 0 ? bboxW / (visibleW * (1 - 2 * padding)) : 1;
  const scaleY = visibleH > 0 ? bboxH / (visibleH * (1 - 2 * padding)) : 1;
  const ratio = Math.max(currentRatio * Math.max(scaleX, scaleY), 0.01);

  camera.animate({ x: cx, y: cy, ratio }, { duration });
}

/**
 * Zoom the camera to fit all nodes in the graph.
 *
 * Sigma normalizes all graph coordinates to [0,1] space internally.
 * Camera state {x: 0.5, y: 0.5, ratio: 1} centers on the full extent —
 * equivalent to a "reset" that shows everything.
 */
export function zoomToFit(sigma: Sigma, duration = 400): void {
  const camera = sigma.getCamera();
  camera.animate({ x: 0.5, y: 0.5, ratio: 1 }, { duration });
}
