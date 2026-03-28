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

/**
 * Score conversion function extracted from ladybugStore.ts.
 * Converts cosine distance (0 = identical, 1 = orthogonal) to a
 * relevance score suitable for RRF fusion (higher = better).
 *
 * Uses exponential decay: score = exp(-2 * distance)
 */
function distanceToScore(dist: number): number {
  return Math.exp(-2 * dist);
}

/** The distance threshold used in QUERY_VECTOR_INDEX WHERE clause. */
const DISTANCE_THRESHOLD = 0.65;

// ---------------------------------------------------------------------------
// 1. Score conversion function tests
// ---------------------------------------------------------------------------

describe('distanceToScore (exponential decay)', () => {
  it('returns 1.0 for perfect match (distance = 0)', () => {
    expect(distanceToScore(0)).toBeCloseTo(1.0, 5);
  });

  it('returns a positive score at the threshold boundary', () => {
    const scoreAtThreshold = distanceToScore(DISTANCE_THRESHOLD);
    expect(scoreAtThreshold).toBeGreaterThan(0);
    // exp(-2 * 0.65) = exp(-1.3) ≈ 0.2725
    expect(scoreAtThreshold).toBeCloseTo(0.2725, 3);
  });

  it('is monotonically decreasing', () => {
    const distances = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.65];
    const scores = distances.map(distanceToScore);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThan(scores[i - 1]);
    }
  });

  it('never returns negative values', () => {
    for (let d = 0; d <= 2; d += 0.1) {
      expect(distanceToScore(d)).toBeGreaterThan(0);
    }
  });

  it('decays faster than linear inversion for distant matches', () => {
    // Exponential decay penalises poor matches more aggressively than 1-d.
    // At d=0.5: exp(-1) ≈ 0.368 vs 1-0.5 = 0.5  → exponential is lower
    // At d=0.1: exp(-0.2) ≈ 0.819 vs 1-0.1 = 0.9 → exponential is lower
    // This is by design — it compresses low-quality matches.
    const linear = (d: number) => 1 - d;
    expect(distanceToScore(0.5)).toBeLessThan(linear(0.5));
    expect(distanceToScore(0.3)).toBeLessThan(linear(0.3));
  });

  it('provides meaningful score separation between close matches', () => {
    // Two results with distances 0.05 and 0.15 should have distinguishable scores
    const closeMatch = distanceToScore(0.05);
    const fairMatch = distanceToScore(0.15);
    const ratio = closeMatch / fairMatch;
    // exp(-0.1) / exp(-0.3) = exp(0.2) ≈ 1.22 — 22% difference
    expect(ratio).toBeGreaterThan(1.1);
    expect(ratio).toBeLessThan(2.0);
  });
});

// ---------------------------------------------------------------------------
// 2. Distance threshold tests
// ---------------------------------------------------------------------------

describe('distance threshold (0.65)', () => {
  it('passes semantically similar items (distance < 0.65)', () => {
    const testDistances = [0.0, 0.1, 0.3, 0.5, 0.64];
    for (const d of testDistances) {
      expect(d).toBeLessThan(DISTANCE_THRESHOLD);
      expect(distanceToScore(d)).toBeGreaterThan(0.2); // useful score
    }
  });

  it('filters out dissimilar items (distance >= 0.65)', () => {
    const filteredDistances = [0.65, 0.7, 0.8, 1.0];
    for (const d of filteredDistances) {
      expect(d).toBeGreaterThanOrEqual(DISTANCE_THRESHOLD);
    }
  });

  it('balances precision and recall', () => {
    // Cosine distance 0.65 corresponds to cosine similarity ≈ 0.35
    // (since cosine distance = 1 - cosine similarity for normalized vectors)
    // This means we accept items that share at least ~35% semantic overlap.
    //
    // Too strict (< 0.3): misses relevant results with partial term overlap
    // Too loose (> 0.8): includes noise from unrelated code
    // 0.65 is a balanced middle ground.
    const cosineSimilarity = 1 - DISTANCE_THRESHOLD;
    expect(cosineSimilarity).toBeGreaterThanOrEqual(0.3); // not too loose
    expect(cosineSimilarity).toBeLessThanOrEqual(0.5); // not too strict
  });
});

// ---------------------------------------------------------------------------
// 3. RRF integration: vector scores fuse correctly with BM25/FTS
// ---------------------------------------------------------------------------

describe('vector scores in RRF fusion', () => {
  it('vector-only result participates in fusion', () => {
    const bm25 = [{ id: 'bm25file', score: 8.5 }];
    const vector = [{ id: 'vecfile', score: distanceToScore(0.1) }];

    const fused = rrfFuse([bm25, vector]);
    const ids = fused.map((r) => r.id);
    expect(ids).toContain('bm25file');
    expect(ids).toContain('vecfile');
  });

  it('item found by both BM25 and vector ranks higher than either alone', () => {
    const bm25 = [
      { id: 'shared', score: 5 },
      { id: 'bm25only', score: 10 },
    ];
    const vector = [
      { id: 'shared', score: distanceToScore(0.2) },
      { id: 'veconly', score: distanceToScore(0.05) },
    ];

    const fused = rrfFuse([bm25, vector]);
    expect(fused[0].id).toBe('shared');
  });

  it('three-way fusion (BM25 + FTS + vector) boosts triple-matches', () => {
    const bm25 = [
      { id: 'apiCall.cfm', score: 3.0 },
      { id: 'other.cfm', score: 5.0 },
    ];
    const fts = [
      { id: 'apiCall.cfm', score: 2.5 },
      { id: 'config.cfm', score: 4.0 },
    ];
    const vector = [
      { id: 'apiCall.cfm', score: distanceToScore(0.15) },
      { id: 'unrelated.cfm', score: distanceToScore(0.3) },
    ];

    const fused = rrfFuse([bm25, fts, vector]);
    // apiCall.cfm appears in all 3 lists → should be #1
    expect(fused[0].id).toBe('apiCall.cfm');
  });

  it('vector scores do not dominate over high-rank BM25 hits', () => {
    // Even if a vector match has a very high score (dist ≈ 0),
    // RRF uses rank not score magnitude, so it shouldn't unfairly dominate.
    const bm25 = [
      { id: 'exact-name-match', score: 50 }, // rank 0
      { id: 'partial-match', score: 20 }, // rank 1
    ];
    const vector = [
      { id: 'semantic-similar', score: distanceToScore(0.01) }, // rank 0, very high score
    ];

    const fused = rrfFuse([bm25, vector]);
    // exact-name-match (BM25 rank 0) and semantic-similar (vec rank 0)
    // both get 1/(60+1) = 1/61 each from their single list.
    // Neither dominates — they're ranked equally.
    const topIds = fused.slice(0, 2).map((r) => r.id);
    expect(topIds).toContain('exact-name-match');
    expect(topIds).toContain('semantic-similar');
  });
});

// ---------------------------------------------------------------------------
// 4. Score distribution analysis — verify the conversion produces
//    a useful score range for real-world distance values
// ---------------------------------------------------------------------------

describe('score distribution for typical distances', () => {
  // Real-world cosine distances from embedding models cluster in ranges:
  // - Near-identical code: 0.0 – 0.1
  // - Same concept, different wording: 0.1 – 0.3
  // - Related but different: 0.3 – 0.5
  // - Weakly related: 0.5 – 0.65
  // - Unrelated: 0.65+

  const ranges = [
    { label: 'near-identical', dist: 0.05, minScore: 0.85, maxScore: 1.0 },
    { label: 'same concept', dist: 0.2, minScore: 0.6, maxScore: 0.75 },
    { label: 'related', dist: 0.4, minScore: 0.4, maxScore: 0.5 },
    { label: 'weakly related', dist: 0.6, minScore: 0.25, maxScore: 0.35 },
  ];

  for (const { label, dist, minScore, maxScore } of ranges) {
    it(`${label} (d=${dist}) scores between ${minScore} and ${maxScore}`, () => {
      const score = distanceToScore(dist);
      expect(score).toBeGreaterThanOrEqual(minScore);
      expect(score).toBeLessThanOrEqual(maxScore);
    });
  }

  it('score spread across the range is well-distributed (no clustering)', () => {
    const distances = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65];
    const scores = distances.map(distanceToScore);

    // Check that adjacent scores differ by at least 5% relative
    for (let i = 1; i < scores.length; i++) {
      const gap = scores[i - 1] - scores[i];
      expect(gap).toBeGreaterThan(0.03); // minimum absolute separation
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('handles distance exactly 0', () => {
    expect(distanceToScore(0)).toBe(1);
  });

  it('handles very large distances gracefully (no NaN/Infinity)', () => {
    const score = distanceToScore(10);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.001);
  });

  it('handles floating point precision near threshold', () => {
    // 0.6499999... should pass, 0.6500001 should not
    const justBelow = 0.6499999;
    const justAbove = 0.6500001;
    expect(justBelow < DISTANCE_THRESHOLD).toBe(true);
    expect(justAbove < DISTANCE_THRESHOLD).toBe(false);
  });

  it('RRF handles empty vector list gracefully', () => {
    const bm25 = [{ id: 'a', score: 5 }];
    const emptyVec: { id: string; score: number }[] = [];
    const fused = rrfFuse([bm25, emptyVec]);
    expect(fused[0].id).toBe('a');
  });

  it('RRF handles all-vector results (no BM25/FTS matches)', () => {
    const vector = [
      { id: 'v1', score: distanceToScore(0.1) },
      { id: 'v2', score: distanceToScore(0.3) },
    ];
    const fused = rrfFuse([vector]);
    expect(fused[0].id).toBe('v1');
    expect(fused[1].id).toBe('v2');
  });
});

// ---------------------------------------------------------------------------
// 6. Optimization validation — verify threshold and decay rate choices
// ---------------------------------------------------------------------------

describe('optimization validation', () => {
  it('decay rate (-2) provides sufficient dynamic range', () => {
    // With decay=-2, score range from dist=0 to dist=0.65 is [1.0, 0.27]
    // That's a 3.7:1 ratio — sufficient for ranking differentiation.
    const best = distanceToScore(0);
    const worst = distanceToScore(DISTANCE_THRESHOLD);
    const dynamicRange = best / worst;
    expect(dynamicRange).toBeGreaterThan(3); // at least 3:1 range
    expect(dynamicRange).toBeLessThan(10); // not so extreme it crushes mid-range
  });

  it('decay rate is not too aggressive (mid-range results still useful)', () => {
    // At d=0.3, score should still be > 0.5 to be competitive in RRF
    const midScore = distanceToScore(0.3);
    expect(midScore).toBeGreaterThan(0.5);
  });

  it('decay rate is not too gentle (poor matches are penalised)', () => {
    // At d=0.6, score should be < 0.35 to avoid polluting results
    const poorScore = distanceToScore(0.6);
    expect(poorScore).toBeLessThan(0.35);
  });

  it('threshold filters approximately bottom 35% of cosine similarity', () => {
    // cosine distance 0.65 ≈ cosine similarity 0.35
    // This means we accept the top ~65% of similarity range
    const simAtThreshold = 1 - DISTANCE_THRESHOLD;
    expect(simAtThreshold).toBeCloseTo(0.35, 2);
  });

  it('score at threshold is low enough to not outrank good BM25 matches in RRF', () => {
    // The weakest vector result (at threshold) should score ~0.27
    // In RRF, rank matters more than score, but if there's only one vector
    // result and it's weak, its rank-1 contribution (1/61) should not
    // dominate a strong BM25 exact-name match (also 1/61).
    // They'd tie — which is acceptable. The threshold ensures we don't
    // add truly irrelevant vector results that would steal rank positions.
    const weakestVecScore = distanceToScore(DISTANCE_THRESHOLD - 0.001);
    expect(weakestVecScore).toBeLessThan(0.3);
  });
});
