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
 * Custom node hover/tooltip renderer for Sigma.
 *
 * Two-pass rendering to prevent node circles from overlapping tooltips:
 * Pass 1 (drawNodeHover): Draw node circles + buffer tooltip commands
 * Pass 2 (flushTooltips): Draw all buffered tooltips on top
 *
 * flushTooltips is called via sigma's afterRender event.
 */
import type { Attributes } from 'graphology-types';
import type { NodeDisplayData } from 'sigma/types';
import type { Settings } from 'sigma/settings';
import { overlapsExistingHover, pushHoverBox, resetHoverGrid } from './drawNodeLabel';

type PartialButFor<T, K extends keyof T> = Pick<T, K> & Partial<T>;

// ─── Hovered-node gate ──────────────────────────────────────────────

export let _hoveredNodeKey: string | null = null;
export function setHoveredNodeKey(key: string | null): void {
  _hoveredNodeKey = key;
}

// ─── Theme color cache ──────────────────────────────────────────────

interface ThemeColors {
  bg: string;
  fg: string;
  muted: string;
  key: string;
}

let cached: ThemeColors | null = null;

function resolveThemeColors(): ThemeColors {
  const root = document.documentElement;
  const key = `${root.dataset.theme ?? ''}_${root.dataset.mode ?? ''}`;
  if (cached && cached.key === key) return cached;

  const style = getComputedStyle(root);
  cached = {
    bg: style.getPropertyValue('--popover').trim() || '#1e293b',
    fg: style.getPropertyValue('--popover-foreground').trim() || '#e2e8f0',
    muted: style.getPropertyValue('--muted-foreground').trim() || '#94a3b8',
    key,
  };
  return cached;
}

// ─── Buffered tooltip commands ──────────────────────────────────────

interface TooltipCommand {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  subtitle: string;
  labelSize: number;
  smallSize: number;
  font: string;
  weight: string;
  lineHeight: number;
  color: string;
  isHovered: boolean;
}

let tooltipBuffer: TooltipCommand[] = [];
let tooltipContext: CanvasRenderingContext2D | null = null;
let flushScheduled = false;

/** Draw all buffered tooltips on top of node circles. */
export function flushTooltips(): void {
  const ctx = tooltipContext;
  if (!ctx || tooltipBuffer.length === 0) return;

  const colors = resolveThemeColors();

  for (const cmd of tooltipBuffer) {
    const radius = 4;

    // Tooltip background
    ctx.fillStyle = colors.bg;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;
    ctx.shadowBlur = 8;
    ctx.shadowColor = 'rgba(0,0,0,0.5)';

    ctx.beginPath();
    ctx.roundRect(cmd.x, cmd.y, cmd.w, cmd.h, radius);
    ctx.fill();

    // Hovered node: colored border
    if (cmd.isHovered) {
      ctx.shadowBlur = 0;
      ctx.strokeStyle = cmd.color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.shadowBlur = 0;

    // Label text
    const textX = cmd.x + 4;
    const centerY = cmd.y + cmd.h / 2;
    if (cmd.label) {
      ctx.fillStyle = colors.fg;
      ctx.font = `${cmd.weight} ${cmd.labelSize}px ${cmd.font}`;
      ctx.fillText(
        cmd.label,
        textX,
        centerY + (cmd.subtitle ? -cmd.lineHeight / 2 + cmd.labelSize * 0.35 : cmd.labelSize / 3),
      );
    }

    // Subtitle
    if (cmd.subtitle) {
      ctx.fillStyle = colors.muted;
      ctx.font = `${cmd.smallSize}px ${cmd.font}`;
      ctx.fillText(
        cmd.subtitle,
        textX,
        centerY + cmd.lineHeight / 2,
      );
    }
  }

  tooltipBuffer = [];
  tooltipContext = null;
}

// ─── Per-frame reset ────────────────────────────────────────────────
let lastHoverFrameTime = 0;

// ─── Tooltip renderer ───────────────────────────────────────────────

export function drawNodeHover<
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
  // Reset on first call each frame
  const now = performance.now();
  if (now - lastHoverFrameTime > 8) {
    resetHoverGrid();
    tooltipBuffer = [];
    lastHoverFrameTime = now;
  }
  tooltipContext = context;

  const extras = data as Record<string, unknown>;
  const key = extras.key as string | undefined;
  const isActuallyHovered =
    key != null && _hoveredNodeKey != null && key === _hoveredNodeKey;
  const isSelected =
    extras.borderSize != null && (extras.borderSize as number) > 0;

  const size = settings.labelSize;
  const font = settings.labelFont;
  const weight = settings.labelWeight;
  const PADDING = 4;

  const label =
    typeof data.label === 'string'
      ? data.label
      : typeof extras._originalLabel === 'string'
        ? (extras._originalLabel as string)
        : '';
  const nodeType = extras.nodeType as string | undefined;
  const communityName = extras._communityName as string | undefined;
  const subtitle = [nodeType, communityName].filter(Boolean).join(' · ');

  context.font = `${weight} ${size}px ${font}`;
  const labelWidth = label ? context.measureText(label).width : 0;

  let subtitleWidth = 0;
  const smallSize = Math.round(size * 0.8);
  if (subtitle) {
    context.font = `${smallSize}px ${font}`;
    subtitleWidth = context.measureText(subtitle).width;
  }

  const textWidth = Math.max(labelWidth, subtitleWidth);
  const boxWidth = Math.round(textWidth + 8);
  const lineHeight = size + 2;
  const lines = subtitle ? 2 : 1;
  const boxHeight = Math.round(lineHeight * lines + PADDING * 2);

  // Tooltip position: to the right of the node
  const tooltipGap = 4;
  const tx = data.x + data.size + tooltipGap;
  const ty = data.y - boxHeight / 2;

  // Density culling
  const hasTooltip = textWidth > 0 || subtitle;
  let drawTooltip: boolean = hasTooltip as boolean;

  const pad = 8;
  const cullX = data.x - data.size - pad;
  const cullY = data.y - Math.max(boxHeight / 2, data.size) - pad;
  const cullW = data.size * 2 + boxWidth + tooltipGap + pad * 2;
  const cullH = Math.max(boxHeight, data.size * 2) + pad * 2;

  if (hasTooltip && !isActuallyHovered && !isSelected) {
    if (overlapsExistingHover(cullX, cullY, cullW, cullH)) {
      drawTooltip = false;
    } else {
      pushHoverBox(cullX, cullY, cullW, cullH);
    }
  } else if (hasTooltip) {
    pushHoverBox(cullX, cullY, cullW, cullH);
  }

  // Pass 1: Draw node circle immediately
  context.beginPath();
  context.arc(data.x, data.y, data.size, 0, Math.PI * 2);
  context.closePath();
  context.fillStyle = data.color;
  context.fill();

  // Pass 2: Buffer tooltip for deferred drawing (after all circles)
  if (drawTooltip) {
    tooltipBuffer.push({
      x: tx,
      y: ty,
      w: boxWidth,
      h: boxHeight,
      label,
      subtitle,
      labelSize: size,
      smallSize,
      font,
      weight,
      lineHeight,
      color: data.color,
      isHovered: isActuallyHovered,
    });
  }

  // Schedule a microtask to flush tooltips after sigma finishes
  // calling drawNodeHover for all highlighted nodes in this frame.
  if (!flushScheduled) {
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      flushTooltips();
    });
  }
}
