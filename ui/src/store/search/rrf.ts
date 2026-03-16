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
 * Reciprocal Rank Fusion (RRF) — combines multiple ranked result lists
 * into a single fused ranking.
 *
 * For each result, the fused score is: Σ 1 / (k + rank_i)
 * where rank_i is the 1-based position in each list and k is a constant
 * (default 60) that dampens the influence of high-ranking positions.
 *
 * RRF is simple yet surprisingly effective — it outperforms many learned
 * fusion methods because it's rank-based (not score-based), making it
 * robust to different scoring scales between BM25 and cosine similarity.
 */

export interface RankedItem {
  id: string;
  score: number;
}

export interface FusedResult {
  id: string;
  score: number;
}

/**
 * Fuse multiple ranked lists using Reciprocal Rank Fusion.
 *
 * @param rankedLists - Arrays of results, each sorted by descending score.
 * @param limit - Maximum number of fused results to return.
 * @param k - RRF constant (default 60). Higher k = less emphasis on top ranks.
 */
export function rrfFuse(
  rankedLists: RankedItem[][],
  limit = 50,
  k = 60,
): FusedResult[] {
  const scores = new Map<string, number>();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + rank + 1));
    }
  }

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
