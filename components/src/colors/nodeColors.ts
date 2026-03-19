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
 * Ported from insight-ui's getGroupColor — uses a fixed palette
 * with DJB2 hash fallback for unknown types.
 */

const PALETTE = [
  "#6366f1", // Indigo
  "#f59e0b", // Amber
  "#10b981", // Emerald
  "#8b5cf6", // Violet
  "#ef4444", // Red
  "#3b82f6", // Blue
  "#ec4899", // Pink
  "#14b8a6", // Teal
  "#f97316", // Orange
  "#84cc16", // Lime
  "#a855f7", // Purple
  "#06b6d4", // Cyan
];

/** Well-known node types → fixed colors for visual consistency */
const KNOWN: Record<string, string> = {
  Repository: "#10b981",
  Class: "#3b82f6",
  Function: "#a855f7",
  File: "#84cc16",
  Directory: "#22d3ee",
};

function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function getNodeColor(type: string): string {
  return KNOWN[type] ?? PALETTE[djb2(type) % PALETTE.length];
}
