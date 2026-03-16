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

import { describe, it, expect } from 'vitest';
import { rrfFuse } from '../rrf';

describe('rrfFuse', () => {
  it('returns empty for empty input', () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([[]])).toEqual([]);
  });

  it('passes through a single list', () => {
    const results = rrfFuse([
      [
        { id: 'a', score: 10 },
        { id: 'b', score: 5 },
      ],
    ]);
    expect(results[0].id).toBe('a');
    expect(results[1].id).toBe('b');
  });

  it('boosts items appearing in multiple lists', () => {
    const bm25 = [
      { id: 'shared', score: 5 },
      { id: 'bm25only', score: 10 },
    ];
    const vector = [
      { id: 'shared', score: 0.9 },
      { id: 'vectoronly', score: 0.8 },
    ];

    const fused = rrfFuse([bm25, vector]);
    // "shared" appears in both lists so should be boosted to #1
    expect(fused[0].id).toBe('shared');
  });

  it('respects limit parameter', () => {
    const list = Array.from({ length: 20 }, (_, i) => ({
      id: `item${i}`,
      score: 20 - i,
    }));
    const results = rrfFuse([list], 5);
    expect(results.length).toBe(5);
  });

  it('uses rank-based scoring not score-based', () => {
    // Even though list2 has wildly different score magnitudes,
    // RRF should treat rank positions equally
    const list1 = [
      { id: 'a', score: 100 },
      { id: 'b', score: 99 },
    ];
    const list2 = [
      { id: 'b', score: 0.001 },
      { id: 'c', score: 0.0001 },
    ];

    const fused = rrfFuse([list1, list2]);
    // "b" appears in both lists (rank 2 and rank 1) so should be boosted
    expect(fused[0].id).toBe('b');
  });

  it('handles three lists', () => {
    const list1 = [
      { id: 'a', score: 1 },
      { id: 'b', score: 0.5 },
    ];
    const list2 = [
      { id: 'b', score: 1 },
      { id: 'c', score: 0.5 },
    ];
    const list3 = [
      { id: 'a', score: 1 },
      { id: 'c', score: 0.5 },
    ];

    const fused = rrfFuse([list1, list2, list3]);
    // "a" appears in 2 lists (ranks 1,1), "b" in 2 lists (ranks 2,1), "c" in 2 lists (ranks 2,2)
    // a: 1/61 + 1/61 = 2/61
    // b: 1/62 + 1/61 = ~0.0326 + 0.0164 = ~0.033
    // Wait: a is rank 0 in list1 and list3, so 1/61 + 1/61 = 2/61 ≈ 0.0328
    // b is rank 1 in list1 (1/62) and rank 0 in list2 (1/61) = 1/62 + 1/61 ≈ 0.0325
    // a and b are very close, but a should be slightly ahead
    expect(fused[0].id).toBe('a');
  });
});
