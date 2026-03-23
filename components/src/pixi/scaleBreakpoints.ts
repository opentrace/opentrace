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
 * Performance breakpoints for the Pixi.js graph renderer.
 *
 * Each breakpoint defines rendering behavior at a given graph scale.
 * The renderer selects the first breakpoint whose `maxNodes` is >= the
 * actual node count (breakpoints are sorted ascending by maxNodes).
 *
 * This replaces scattered magic numbers with a single, readable configuration
 * that makes it easy to tune "what does rendering look like at 500 vs 5k vs 20k nodes?"
 */

// ─── Types ──────────────────────────────────────────────────────────────

export interface PixiScaleBreakpoint {
  /** Maximum node count for this tier (use Infinity for the catch-all). */
  maxNodes: number;

  // ── Edges ───────────────────────────────────────────────────────────

  /** Edge drawing style: 'curve' = quadratic bezier, 'line' = straight moveTo/lineTo. */
  edgeStyle: 'curve' | 'line';
  /** Minimum interval between full edge redraws during layout animation (ms). */
  edgeRedrawInterval: number;
  /** Skip edge redraws entirely when the simulation has settled. */
  edgeAlphaGate: boolean;
  /** Cull edges where both endpoints are outside the visible viewport. */
  edgeViewportCulling: boolean;

  // ── Interaction ─────────────────────────────────────────────────────

  /** Hide all edge Graphics layers during zoom/pan for instant response. */
  hideEdgesOnInteraction: boolean;
  /** Delay (ms) after the last zoom/pan event before edges are restored. */
  interactionSettleDelay: number;

  // ── Physics ─────────────────────────────────────────────────────────

  /** Barnes-Hut theta for the charge force (higher = faster, less accurate). */
  barnesHutTheta: number;
  /** Barnes-Hut theta override during node drag (higher for local-only accuracy). */
  dragTheta: number;

  // ── Labels ──────────────────────────────────────────────────────────

  /** Show node labels (degree-based auto-labeling). Disable at extreme scale for perf. */
  autoLabels: boolean;
}

// ─── Defaults ────────────────────────────────────────────────────────────
//
// The breakpoints are checked in order; the first one whose maxNodes >= the
// graph's node count is selected. So they must be sorted ascending.
//
//   Tier 0:     ≤1,000 nodes  — full fidelity (curves, labels, no culling)
//   Tier 1:  1,001–5,000      — curves still fine, start alpha-gating edges
//   Tier 2:  5,001–15,000     — switch to straight lines, hide edges on zoom
//   Tier 3: 15,001+           — all optimizations on, aggressive throttle

export const DEFAULT_BREAKPOINTS: PixiScaleBreakpoint[] = [
  {
    maxNodes: 1_000,
    edgeStyle: 'curve',
    edgeRedrawInterval: 100,
    edgeAlphaGate: false,
    edgeViewportCulling: false,
    hideEdgesOnInteraction: false,
    interactionSettleDelay: 800,
    barnesHutTheta: 0.9,
    dragTheta: 0.9,
    autoLabels: true,
  },
  {
    maxNodes: 5_000,
    edgeStyle: 'curve',
    edgeRedrawInterval: 100,
    edgeAlphaGate: true,
    edgeViewportCulling: false,
    hideEdgesOnInteraction: false,
    interactionSettleDelay: 1000,
    barnesHutTheta: 0.9,
    dragTheta: 1.2,
    autoLabels: true,
  },
  {
    maxNodes: 15_000,
    edgeStyle: 'line',
    edgeRedrawInterval: 150,
    edgeAlphaGate: true,
    edgeViewportCulling: true,
    hideEdgesOnInteraction: true,
    interactionSettleDelay: 1300,
    barnesHutTheta: 0.9,
    dragTheta: 1.5,
    autoLabels: true,
  },
  {
    maxNodes: Infinity,
    edgeStyle: 'line',
    edgeRedrawInterval: 200,
    edgeAlphaGate: true,
    edgeViewportCulling: true,
    hideEdgesOnInteraction: true,
    interactionSettleDelay: 1300,
    barnesHutTheta: 1.0,
    dragTheta: 1.5,
    autoLabels: false,
  },
];

/**
 * Select the breakpoint matching the given node count.
 * Returns the first breakpoint whose maxNodes >= nodeCount.
 */
export function selectBreakpoint(
  nodeCount: number,
  breakpoints: PixiScaleBreakpoint[] = DEFAULT_BREAKPOINTS,
): PixiScaleBreakpoint {
  for (const bp of breakpoints) {
    if (nodeCount <= bp.maxNodes) return bp;
  }
  // Fallback: last breakpoint (Infinity tier)
  return breakpoints[breakpoints.length - 1];
}
