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
 * Custom node label renderer for Sigma.
 *
 * Labels = simple node name text, shown when no selection is active.
 * Rendered based on zoom level / node size threshold (sigma default behavior).
 * Theme-aware color, dark text stroke for readability, overlap culling.
 *
 * When a node is selected, labels are hidden — tooltips (drawNodeHover)
 * take over for highlighted nodes.
 */

import type { Attributes } from 'graphology-types';
import type { NodeDisplayData } from 'sigma/types';
import type { Settings } from 'sigma/settings';

type PartialButFor<T, K extends keyof T> = Pick<T, K> & Partial<T>;

// ─── Theme color cache ──────────────────────────────────────────────

interface LabelTheme {
  fg: string;
  key: string;
}

let cached: LabelTheme | null = null;

function resolveLabelColor(): string {
  const root = document.documentElement;
  const key = `${root.dataset.theme ?? ''}_${root.dataset.mode ?? ''}`;
  if (cached && cached.key === key) return cached.fg;

  const style = getComputedStyle(root);
  const fg = style.getPropertyValue('--foreground').trim() || '#e2e8f0';
  cached = { fg, key };
  return fg;
}

// ─── Label density tracking ─────────────────────────────────────────
// Note: module-level state is a singleton shared across all GraphCanvas
// instances. Fine for single-graph apps; if multi-graph support is needed,
// these would need to be per-instance (e.g. WeakMap keyed on sigma context).

interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

let renderedBoxes: LabelBox[] = [];
let hoverBoxes: LabelBox[] = [];

export function resetLabelGrid(): void {
  renderedBoxes = [];
}

export function resetHoverGrid(): void {
  hoverBoxes = [];
}

function overlaps(
  boxes: LabelBox[],
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  for (const box of boxes) {
    if (
      x < box.x + box.w &&
      x + w > box.x &&
      y < box.y + box.h &&
      y + h > box.y
    ) {
      return true;
    }
  }
  return false;
}

/** Check overlap against the hover layer's tooltip boxes. */
export function overlapsExistingHover(
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  return overlaps(hoverBoxes, x, y, w, h);
}

/** Register a tooltip box on the hover layer. */
export function pushHoverBox(
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  hoverBoxes.push({ x, y, w, h });
}

// ─── Label renderer ─────────────────────────────────────────────────

export function drawNodeLabel<
  N extends Attributes = Attributes,
  E extends Attributes = Attributes,
  G extends Attributes = Attributes,
>(
  context: CanvasRenderingContext2D,
  data: PartialButFor<
    NodeDisplayData,
    'x' | 'y' | 'size' | 'label' | 'color'
  >,
  settings: Settings<N, E, G>,
): void {
  if (!data.label) return;

  // Highlighted nodes are rendered on sigma's hover layer where
  // drawNodeHover draws tooltips. Skip plain labels for those.
  const extras = data as Record<string, unknown>;
  if (extras.highlighted) return;

  const size = settings.labelSize;
  const font = settings.labelFont;
  const weight = settings.labelWeight;
  const fg = resolveLabelColor();

  context.font = `${weight} ${size}px ${font}`;
  const textWidth = context.measureText(data.label).width;

  const x = data.x + data.size + 3;
  const y = data.y + size / 3;

  // Bounding box for overlap detection
  const boxX = x - 1;
  const boxY = y - size;
  const boxW = textWidth + 2;
  const boxH = size + 4;

  // Density check — skip if overlapping an already-rendered label
  if (overlaps(renderedBoxes, boxX, boxY, boxW, boxH)) {
    return;
  }
  renderedBoxes.push({ x: boxX, y: boxY, w: boxW, h: boxH });

  // Dark stroke behind text for readability on any background
  context.save();
  context.strokeStyle = 'rgba(0,0,0,0.7)';
  context.lineWidth = 3;
  context.lineJoin = 'round';
  context.strokeText(data.label, x, y);
  context.restore();

  // Re-apply font after restore() rolled it back
  context.font = `${weight} ${size}px ${font}`;
  context.fillStyle = fg;
  context.fillText(data.label, x, y);
}
