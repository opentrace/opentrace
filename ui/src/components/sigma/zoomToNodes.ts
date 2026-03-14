import type Sigma from 'sigma';

/**
 * Zoom the sigma camera to fit a set of node IDs.
 * Replaces `fgRef.current.zoomToFit(duration, padding, predicate)`.
 */
export function zoomToNodes(
  sigma: Sigma,
  nodeIds: Iterable<string>,
  duration = 600,
  padding = 0.1,
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

  // Single node — just center on it
  if (count === 1 || (maxX - minX < 1 && maxY - minY < 1)) {
    camera.animate(
      { x: (minX + maxX) / 2, y: (minY + maxY) / 2, ratio: 0.1 },
      { duration },
    );
    return;
  }

  // Compute bounding box center and ratio
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // Get the container dimensions
  const { width, height } = sigma.getDimensions();
  const graphWidth = maxX - minX;
  const graphHeight = maxY - minY;

  // Calculate ratio to fit the bounding box with padding
  const ratioX = graphWidth / (width * (1 - padding * 2));
  const ratioY = graphHeight / (height * (1 - padding * 2));
  const ratio = Math.max(ratioX, ratioY, 0.01);

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
