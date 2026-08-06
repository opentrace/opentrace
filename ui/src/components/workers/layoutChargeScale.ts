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
 * Mode-aware scaling of the user-facing "charge strength" setting — the single
 * source of truth shared by forceLayout3dWorker's buildSimulation and its
 * update-config handler, so a live slider change installs the SAME scaled
 * charge the active mode was built with (a raw forceManyBody would give onion
 * a charge force it deliberately lacks, and blast tree/nebula with several
 * times their built strength). Kept in its own module (no worker `self`
 * globals) so it's unit-testable.
 */

import type { LayoutMode } from './forceLayout3dWorker';

/** Tree-mode relax factor: the declutter forces must weaken as graphs grow —
 *  ~full strength below ~600 nodes, fading toward near-zero at 5k+ (the same
 *  charge/link strengths that polish a 400-node tree tear a large seeded tree
 *  apart into a lumpy blob). */
export function treeRelax(nodeCount: number): number {
  return Math.min(1, 600 / Math.max(1, nodeCount));
}

/** Effective forceManyBody strength for `mode`, or null when the mode runs NO
 *  charge force at all (onion — its Fibonacci shell placement is already
 *  collision-free, and any charge would degrade the even shells). */
export function modeChargeStrength(
  mode: LayoutMode,
  chargeStrength: number,
  nodeCount: number,
): number | null {
  switch (mode) {
    case 'onion':
      return null;
    case 'tree':
      // Gentle repulsion — just enough to separate overlapping siblings
      // without fighting the anchor and fanning the tree into a ball.
      return chargeStrength * 0.4 * treeRelax(nodeCount);
    case 'nebula':
      // Gentle charge for soft organic texture; the anchor holds the cloud.
      return chargeStrength * 0.12;
    default:
      // spread / compact use the configured strength directly.
      return chargeStrength;
  }
}
