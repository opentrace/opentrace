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
 * Deterministic color assignment for relationship (link) types.
 *
 * Reads from CSS variables (--graph-edge-<type>, --graph-edge-palette-N)
 * so themes can override graph colors. Falls back to hardcoded defaults
 * when CSS variables aren't available (e.g. tests, SSR, Node).
 */

const PALETTE_SIZE = 12;

const FALLBACK_PALETTE = [
  '#f9a8d4', // Pink
  '#93c5fd', // Blue
  '#6ee7b7', // Emerald
  '#fde68a', // Amber
  '#c4b5fd', // Violet
  '#fdba74', // Orange
  '#5eead4', // Teal
  '#fca5a5', // Red
  '#7dd3fc', // Sky
  '#bef264', // Lime
  '#d8b4fe', // Purple
  '#67e8f9', // Cyan
];

/** Well-known relationship types → CSS variable name suffix and fallback color.
 *  Keys are UPPER_CASE (canonical), var names use kebab-case. */
const FALLBACK_KNOWN: Record<string, { varSuffix: string; color: string }> = {
  CALLS: { varSuffix: 'calls', color: '#93c5fd' },
  READS: { varSuffix: 'reads', color: '#fde68a' },
  WRITES: { varSuffix: 'writes', color: '#fdba74' },
  DEFINED_IN: { varSuffix: 'defined-in', color: '#6ee7b7' },
  PART_OF: { varSuffix: 'part-of', color: '#5eead4' },
  DEPENDS_ON: { varSuffix: 'depends-on', color: '#f9a8d4' },
  EXTENDS: { varSuffix: 'extends', color: '#c4b5fd' },
  HANDLES: { varSuffix: 'handles', color: '#7dd3fc' },
  IMPORTS: { varSuffix: 'imports', color: '#d8b4fe' },
  AUTHORED: { varSuffix: 'authored', color: '#fca5a5' },
  ASSIGNED: { varSuffix: 'assigned', color: '#67e8f9' },
  PARTICIPATED: { varSuffix: 'participated', color: '#bef264' },
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
    const known = new Map<string, string>();
    for (const [key, { color }] of Object.entries(FALLBACK_KNOWN)) {
      known.set(key, color);
    }
    return { themeKey: '__fallback__', known, palette: FALLBACK_PALETTE };
  }

  const root = document.documentElement;
  const themeKey = `${root.dataset.theme ?? ''}_${root.dataset.mode ?? ''}`;
  if (cache && cache.themeKey === themeKey) return cache;

  const style = getComputedStyle(root);

  // Read known type colors
  const known = new Map<string, string>();
  for (const [key, { varSuffix, color }] of Object.entries(FALLBACK_KNOWN)) {
    const val = style.getPropertyValue(`--graph-edge-${varSuffix}`).trim();
    known.set(key, val || color);
  }

  // Read palette
  const palette: string[] = [];
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const val = style.getPropertyValue(`--graph-edge-palette-${i}`).trim();
    palette.push(val || FALLBACK_PALETTE[i]);
  }

  cache = { themeKey, known, palette };
  return cache;
}

export function getLinkColor(type: string): string {
  const upper = type.toUpperCase();
  const { known, palette } = resolveColors();
  return known.get(upper) ?? palette[djb2(upper) % palette.length];
}
