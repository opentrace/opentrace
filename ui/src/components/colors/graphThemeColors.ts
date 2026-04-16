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
 * Reads graph-specific CSS variables for canvas background, label colors,
 * and dim-blend background. Falls back to dark-theme defaults when CSS
 * variables aren't available (tests, SSR).
 */

export interface GraphThemeColors {
  /** Canvas background hex, e.g. '#0d1117' */
  bg: string;
  /** Label text fill hex, e.g. '#e2e8f0' */
  labelColor: string;
  /** Label drop shadow hex, e.g. '#0d1117' */
  labelShadow: string;
  /** Background RGB for dimColor alpha blending */
  dimBg: { r: number; g: number; b: number };
}

const DEFAULTS: GraphThemeColors = {
  bg: '#0d1117',
  labelColor: '#e2e8f0',
  labelShadow: '#0d1117',
  dimBg: { r: 0x1a, g: 0x1b, b: 0x2e },
};

function parseHexRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

let cache: { themeKey: string; colors: GraphThemeColors } | null = null;

export function getGraphThemeColors(): GraphThemeColors {
  if (typeof document === 'undefined') return DEFAULTS;

  const root = document.documentElement;
  const themeKey = `${root.dataset.theme ?? ''}_${root.dataset.mode ?? ''}`;
  if (cache && cache.themeKey === themeKey) return cache.colors;

  const style = getComputedStyle(root);
  const bg = style.getPropertyValue('--graph-bg').trim() || DEFAULTS.bg;
  const labelColor =
    style.getPropertyValue('--graph-label-color').trim() || DEFAULTS.labelColor;
  const labelShadow =
    style.getPropertyValue('--graph-label-shadow').trim() ||
    DEFAULTS.labelShadow;
  const dimBgHex = style.getPropertyValue('--graph-dim-bg').trim() || '#1a1b2e';
  const dimBg = parseHexRgb(dimBgHex);

  const colors: GraphThemeColors = { bg, labelColor, labelShadow, dimBg };
  cache = { themeKey, colors };
  return colors;
}
