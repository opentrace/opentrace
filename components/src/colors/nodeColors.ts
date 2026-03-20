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
 * Deterministic color assignment for node types.
 *
 * Reads from CSS variables (--graph-node-<type>, --graph-node-palette-N)
 * so themes can override graph colors. Falls back to hardcoded defaults
 * when CSS variables aren't available (e.g. tests, SSR, Node).
 */

const PALETTE_SIZE = 12;

const FALLBACK_PALETTE = [
  '#818cf8', // Indigo
  '#fbbf24', // Amber
  '#4ade80', // Green
  '#c084fc', // Violet
  '#fb7185', // Rose
  '#60a5fa', // Blue
  '#f472b6', // Pink
  '#2dd4bf', // Teal
  '#fb923c', // Orange
  '#a3e635', // Lime
  '#e879f9', // Fuchsia
  '#22d3ee', // Cyan
];

/** Well-known node types → fallback colors (used when no CSS variable set) */
const FALLBACK_KNOWN: Record<string, string> = {
  Repository: '#4ade80',
  Class: '#60a5fa',
  Function: '#c084fc',
  File: '#a3e635',
  Directory: '#22d3ee',
};

function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ─── Theme-aware color cache ────────────────────────────────────────────

interface ColorCache {
  themeKey: string;
  known: Map<string, string>;
  palette: string[];
}

let cache: ColorCache | null = null;

function resolveColors(): ColorCache {
  if (typeof document === 'undefined') {
    // Non-browser (tests, SSR) — use fallbacks
    return {
      themeKey: '__fallback__',
      known: new Map(Object.entries(FALLBACK_KNOWN)),
      palette: FALLBACK_PALETTE,
    };
  }

  const root = document.documentElement;
  const themeKey = `${root.dataset.theme ?? ''}_${root.dataset.mode ?? ''}`;
  if (cache && cache.themeKey === themeKey) return cache;

  const style = getComputedStyle(root);

  // Read known type colors
  const known = new Map<string, string>();
  for (const [type, fallback] of Object.entries(FALLBACK_KNOWN)) {
    const varName = `--graph-node-${type.toLowerCase()}`;
    const val = style.getPropertyValue(varName).trim();
    known.set(type, val || fallback);
  }

  // Read palette
  const palette: string[] = [];
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const val = style.getPropertyValue(`--graph-node-palette-${i}`).trim();
    palette.push(val || FALLBACK_PALETTE[i]);
  }

  cache = { themeKey, known, palette };
  return cache;
}

export function getNodeColor(type: string): string {
  const { known, palette } = resolveColors();
  return known.get(type) ?? palette[djb2(type) % palette.length];
}
