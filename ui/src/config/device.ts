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
