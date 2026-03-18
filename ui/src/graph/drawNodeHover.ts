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
 * Custom node hover renderer for Sigma.
 *
 * Theme-aware: reads --popover / --popover-foreground CSS variables.
 * Shows the node label + community name in the tooltip.
 */
import type { Attributes } from 'graphology-types';
import type { NodeDisplayData, Settings } from 'sigma/types';

type PartialButFor<T, K extends keyof T> = Pick<T, K> & Partial<T>;

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

// ─── Hover renderer ─────────────────────────────────────────────────

export function drawNodeHover<
  N extends Attributes = Attributes,
  E extends Attributes = Attributes,
  G extends Attributes = Attributes,
>(
  context: CanvasRenderingContext2D,
  data: PartialButFor<NodeDisplayData, 'x' | 'y' | 'size' | 'label' | 'color'>,
  settings: Settings<N, E, G>,
): void {
  const size = settings.labelSize;
  const font = settings.labelFont;
  const weight = settings.labelWeight;
  const colors = resolveThemeColors();
  const PADDING = 4;

  const label = typeof data.label === 'string' ? data.label : '';
  const extras = data as Record<string, unknown>;
  const nodeType = extras.nodeType as string | undefined;
  const communityName = extras._communityName as string | undefined;
  const subtitle = [nodeType, communityName].filter(Boolean).join(' · ');

  context.font = `${weight} ${size}px ${font}`;

  // Measure text
  const labelWidth = label ? context.measureText(label).width : 0;

  let subtitleWidth = 0;
  const smallSize = Math.round(size * 0.8);
  if (subtitle) {
    context.font = `${smallSize}px ${font}`;
    subtitleWidth = context.measureText(subtitle).width;
  }

  const textWidth = Math.max(labelWidth, subtitleWidth);

  if (textWidth === 0 && !subtitle) {
    // No label — just draw the node circle highlight
    context.beginPath();
    context.arc(data.x, data.y, data.size + PADDING, 0, Math.PI * 2);
    context.closePath();
    context.fillStyle = colors.bg;
    context.shadowBlur = 10;
    context.shadowColor = 'rgba(0,0,0,0.5)';
    context.fill();
    context.shadowBlur = 0;

    // Node circle
    context.beginPath();
    context.arc(data.x, data.y, data.size, 0, Math.PI * 2);
    context.closePath();
    context.fillStyle = data.color;
    context.fill();
    return;
  }

  // Box dimensions
  const boxWidth = Math.round(textWidth + 8);
  const lineHeight = size + 2;
  const lines = subtitle ? 2 : 1;
  const boxHeight = Math.round(lineHeight * lines + PADDING * 2);
  const nodeRadius = Math.max(data.size, size / 2) + PADDING;

  // Draw background box (capsule shape attached to node circle)
  const angleRadian = Math.asin(Math.min(1, boxHeight / 2 / nodeRadius));
  const xDelta = Math.sqrt(
    Math.abs(Math.pow(nodeRadius, 2) - Math.pow(boxHeight / 2, 2)),
  );

  context.fillStyle = colors.bg;
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 2;
  context.shadowBlur = 10;
  context.shadowColor = 'rgba(0,0,0,0.5)';

  context.beginPath();
  context.moveTo(data.x + xDelta, data.y + boxHeight / 2);
  context.lineTo(data.x + nodeRadius + boxWidth, data.y + boxHeight / 2);
  context.lineTo(data.x + nodeRadius + boxWidth, data.y - boxHeight / 2);
  context.lineTo(data.x + xDelta, data.y - boxHeight / 2);
  context.arc(data.x, data.y, nodeRadius, angleRadian, -angleRadian);
  context.closePath();
  context.fill();

  // Reset shadow
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 0;
  context.shadowBlur = 0;

  // Draw label text
  const textX = data.x + nodeRadius + 4;
  if (label) {
    context.fillStyle = colors.fg;
    context.font = `${weight} ${size}px ${font}`;
    context.fillText(label, textX, data.y + (subtitle ? -1 : size / 3));
  }

  // Draw subtitle (type · community, smaller, muted)
  if (subtitle) {
    context.fillStyle = colors.muted;
    context.font = `${smallSize}px ${font}`;
    context.fillText(subtitle, textX, data.y + lineHeight - 2);
  }

  // Draw node circle on top
  context.beginPath();
  context.arc(data.x, data.y, data.size, 0, Math.PI * 2);
  context.closePath();
  context.fillStyle = data.color;
  context.fill();
}
