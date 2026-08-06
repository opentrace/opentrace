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
 * Append-only array diffing for the live-indexing stream.
 *
 * During a live build graphData.nodes/links grow by `prev.concat(batch)`
 * (~100–150 batches for a 100k-node graph), so each new array's prefix is the
 * SAME elements (by identity) as the previous array. Re-scanning the whole
 * list per batch to find "what's new" is O(total) per batch — O(N²) across
 * the build. AppendTracker detects the append case cheaply so callers can
 * process just the suffix, and reports a full rescan whenever the array
 * didn't provably grow in place (reload, filter rebuild, shrink).
 */
export class AppendTracker<T> {
  private prevRef: readonly T[] | null = null;
  private prevLen = 0;

  /**
   * Record `next` as the new baseline and classify it against the previous
   * one. Returns the index where the not-yet-seen suffix starts when `next`
   * extends the previous array — i.e. `[0, prevLen)` is element-identical —
   * or -1 when that can't be established (caller must full-scan).
   *
   * The check is O(1): same-or-longer length with identical first and
   * (prevLen-1)-th elements. That is exact for the `concat`-grown arrays the
   * live stream produces (and for in-place pushes, where `next === prevRef`);
   * any transformation that replaces or reorders prefix elements changes
   * those element identities and fails the check.
   */
  suffixStart(next: readonly T[]): number {
    const prevRef = this.prevRef;
    const prevLen = this.prevLen;
    this.prevRef = next;
    this.prevLen = next.length;
    if (prevRef === null || next.length < prevLen) return -1;
    if (prevLen === 0) return 0;
    if (next[prevLen - 1] !== prevRef[prevLen - 1] || next[0] !== prevRef[0]) {
      return -1;
    }
    return prevLen;
  }

  /** Drop the baseline so the next call reports a full rescan (-1). Call
   *  whenever state derived from previously-processed elements is discarded
   *  (e.g. a sent-set reset). */
  reset(): void {
    this.prevRef = null;
    this.prevLen = 0;
  }
}
