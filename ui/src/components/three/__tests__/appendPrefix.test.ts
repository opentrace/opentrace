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

import { describe, expect, it } from 'vitest';

import { AppendTracker } from '../appendPrefix';

const item = (id: string) => ({ id });

describe('AppendTracker', () => {
  it('reports a full rescan (-1) on the very first call', () => {
    const t = new AppendTracker<{ id: string }>();
    expect(t.suffixStart([item('a'), item('b')])).toBe(-1);
  });

  it('detects a concat-style append and returns the suffix start', () => {
    const t = new AppendTracker<{ id: string }>();
    const batch1 = [item('a'), item('b')];
    t.suffixStart(batch1);
    const batch2 = batch1.concat([item('c'), item('d')]);
    expect(t.suffixStart(batch2)).toBe(2);
  });

  it('chains across multiple appends', () => {
    const t = new AppendTracker<{ id: string }>();
    const b1 = [item('a')];
    const b2 = b1.concat([item('b')]);
    const b3 = b2.concat([item('c'), item('d')]);
    t.suffixStart(b1);
    expect(t.suffixStart(b2)).toBe(1);
    expect(t.suffixStart(b3)).toBe(2);
  });

  it('treats an identical (unchanged) array as an empty suffix', () => {
    const t = new AppendTracker<{ id: string }>();
    const arr = [item('a'), item('b')];
    t.suffixStart(arr);
    expect(t.suffixStart(arr)).toBe(2);
  });

  it('handles in-place growth of the same array reference', () => {
    const t = new AppendTracker<{ id: string }>();
    const arr = [item('a'), item('b')];
    t.suffixStart(arr);
    arr.push(item('c'));
    expect(t.suffixStart(arr)).toBe(2);
  });

  it('reports a full rescan when the array shrinks', () => {
    const t = new AppendTracker<{ id: string }>();
    const arr = [item('a'), item('b'), item('c')];
    t.suffixStart(arr);
    expect(t.suffixStart(arr.slice(0, 2))).toBe(-1);
  });

  it('reports a full rescan when the array is replaced (reload)', () => {
    const t = new AppendTracker<{ id: string }>();
    t.suffixStart([item('a'), item('b')]);
    // Fresh objects — same shape, different identities (a store reload).
    expect(t.suffixStart([item('a'), item('b'), item('c')])).toBe(-1);
  });

  it('reports a full rescan when the last prefix element identity breaks', () => {
    const t = new AppendTracker<{ id: string }>();
    const a = item('a');
    const b = item('b');
    t.suffixStart([a, b]);
    // Same first element, replaced second element (filter rebuild).
    expect(t.suffixStart([a, item('b'), item('c')])).toBe(-1);
  });

  it('reports a full rescan when the first element identity breaks', () => {
    const t = new AppendTracker<{ id: string }>();
    const a = item('a');
    const b = item('b');
    t.suffixStart([a, b]);
    expect(t.suffixStart([item('a'), b, item('c')])).toBe(-1);
  });

  it('grows from an empty baseline with suffix start 0', () => {
    const t = new AppendTracker<{ id: string }>();
    t.suffixStart([]);
    expect(t.suffixStart([item('a'), item('b')])).toBe(0);
  });

  it('recovers after a failed check: the failing array becomes the baseline', () => {
    const t = new AppendTracker<{ id: string }>();
    t.suffixStart([item('a')]);
    const replaced = [item('a'), item('b')];
    expect(t.suffixStart(replaced)).toBe(-1);
    expect(t.suffixStart(replaced.concat([item('c')]))).toBe(2);
  });

  it('reset() forces the next call to report a full rescan', () => {
    const t = new AppendTracker<{ id: string }>();
    const arr = [item('a'), item('b')];
    t.suffixStart(arr);
    t.reset();
    const grown = arr.concat([item('c')]);
    expect(t.suffixStart(grown)).toBe(-1);
    // ...and the post-reset call still records a fresh baseline.
    expect(t.suffixStart(grown.concat([item('d')]))).toBe(3);
  });
});
