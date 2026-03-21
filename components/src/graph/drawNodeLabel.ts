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
 * Improvements over sigma's default:
 * 1. Theme-aware: reads --foreground CSS variable for label color
 * 2. Hovered labels get a glow backdrop so they stand out from neighbors
 * 3. Density-aware: limits labels rendered in dense regions to avoid overlap
 */

import type { Attributes } from 'graphology-types';
import type { NodeDisplayData } from 'sigma/types';
import type { Settings } from 'sigma/settings';
import { _hoveredNodeKey } from './drawNodeHover';

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
  const fg =
    style.getPropertyValue('--foreground').trim() || '#e2e8f0';
  cached = { fg, key };
  return fg;
}

// ─── Label density tracking ─────────────────────────────────────────
// Track bounding boxes of rendered labels per frame to avoid overlap.
// Reset each frame via resetLabelGrid().

interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

let renderedBoxes: LabelBox[] = [];

export function resetLabelGrid(): void {
  renderedBoxes = [];
}

function overlapsExisting(x: number, y: number, w: number, h: number): boolean {
  for (const box of renderedBoxes) {
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

  const size = settings.labelSize;
  const font = settings.labelFont;
  const weight = settings.labelWeight;
  const fg = resolveLabelColor();

  context.font = `${weight} ${size}px ${font}`;
  const textWidth = context.measureText(data.label).width;

  const x = data.x + data.size + 3;
  const y = data.y + size / 3;

  // Density check: skip if this label overlaps an already-rendered one.
  // forceLabel nodes (highlighted neighbors) bypass the check.
  const extras = data as Record<string, unknown>;
  const forced = extras.forceLabel === true;
  const boxX = x - 1;
  const boxY = y - size;
  const boxW = textWidth + 2;
  const boxH = size + 4;

  if (!forced && overlapsExisting(boxX, boxY, boxW, boxH)) {
    return;
  }
  renderedBoxes.push({ x: boxX, y: boxY, w: boxW, h: boxH });

  // If this is the hovered node, draw a glow backdrop behind the label
  const key = extras.key as string | undefined;
  const isHovered = key != null && key === _hoveredNodeKey;

  if (isHovered) {
    context.save();
    context.shadowColor = data.color;
    context.shadowBlur = 8;
    context.fillStyle = 'rgba(0,0,0,0.6)';
    const pad = 3;
    context.beginPath();
    context.roundRect(
      boxX - pad,
      boxY - pad,
      boxW + pad * 2,
      boxH + pad * 2,
      4,
    );
    context.fill();
    context.restore();
  }

  context.fillStyle = fg;
  context.fillText(data.label, x, y);
}
