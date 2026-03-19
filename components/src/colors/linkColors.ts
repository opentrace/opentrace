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
 * Follows the same pattern as nodeColors.ts — fixed palette with
 * DJB2 hash fallback for unknown types.
 */

const PALETTE = [
  "#f472b6", // Pink
  "#60a5fa", // Blue
  "#34d399", // Emerald
  "#fbbf24", // Amber
  "#a78bfa", // Violet
  "#fb923c", // Orange
  "#2dd4bf", // Teal
  "#f87171", // Red
  "#38bdf8", // Sky
  "#a3e635", // Lime
  "#c084fc", // Purple
  "#22d3ee", // Cyan
];

/** Well-known relationship types → fixed colors */
const KNOWN: Record<string, string> = {
  CALLS: "#60a5fa", // Blue — invocation / dependency chains
  READS: "#fbbf24", // Amber — data access
  WRITES: "#fb923c", // Orange — data mutation
  DEFINED_IN: "#34d399", // Emerald — containment / location
  PART_OF: "#2dd4bf", // Teal — structural membership
  DEPENDS_ON: "#f472b6", // Pink — dependency edges
  EXTENDS: "#a78bfa", // Violet — inheritance
  HANDLES: "#38bdf8", // Sky — endpoint handling
  IMPORTS: "#c084fc", // Purple — module imports
  AUTHORED: "#f87171", // Red — authorship
  ASSIGNED: "#22d3ee", // Cyan — assignment
  PARTICIPATED: "#a3e635", // Lime — participation
};

function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function getLinkColor(type: string): string {
  const upper = type.toUpperCase();
  return KNOWN[upper] ?? PALETTE[djb2(upper) % PALETTE.length];
}
