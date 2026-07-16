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
 * Memory-constrained-device detection (phones), used to trim the browser
 * indexing footprint so large repos don't OOM-crash the tab — e.g. a smaller
 * extract worker pool (fewer concurrent grammars + ASTs). Desktops are never
 * treated as constrained, so their behaviour is unchanged.
 */
export function isConstrainedDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  // Android / Chrome expose deviceMemory in GB (capped at 8). Phones report
  // 1–4; treat <=4 as constrained. (undefined on iOS Safari — handled below.)
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof mem === 'number' && mem > 0 && mem <= 4) return true;
  // iOS Safari has no deviceMemory — fall back to "coarse pointer on a
  // phone-sized screen". The short side separates phones (<=600) from iPads
  // (>=768) and desktops.
  const coarse =
    typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const shortSide =
    typeof window !== 'undefined'
      ? Math.min(window.innerWidth, window.innerHeight)
      : Number.POSITIVE_INFINITY;
  return coarse && shortSide <= 600;
}

/**
 * On a constrained device, skip the memory-heavy indexing stages — embedding
 * (onnxruntime model + inference arena) and the SourceText full-text index (full
 * source of every file, CSV-built + FTS-indexed) — when the repo has more than
 * this many files. On a big repo those stages overflow the mobile browser's
 * per-tab memory cap (iOS Safari/WebKit kills a tab at ~1–1.5 GB regardless of
 * device RAM) and the tab silently reloads. Below this the graph is small enough
 * that they still fit, so semantic + in-code search keep working on small/medium
 * repos. Search degrades to name/summary + grep when skipped. A conservative
 * starting estimate — tune against real-device testing.
 */
export const MOBILE_HEAVY_STAGE_MAX_FILES = 3000;
