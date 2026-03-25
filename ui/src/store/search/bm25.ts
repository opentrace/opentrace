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
 * In-memory inverted index with BM25 scoring.
 *
 * BM25 (Best Matching 25) ranks documents by term relevance using:
 *   score(q, d) = Σ IDF(t) * (tf * (k1+1)) / (tf + k1 * (1 - b + b * |d|/avgdl))
 *
 * where tf = term frequency in document, |d| = document length,
 * avgdl = average document length, k1 = saturation parameter, b = length normalization.
 *
 * Supports prefix expansion: if "sqlite" has no exact posting, it expands to
 * tokens starting with "sqlite" (e.g. "sqlite3"), keeping queries on the fast
 * JS-side path instead of falling to expensive Cypher CONTAINS scans.
 */

// ---- Tokenization ----

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'if',
  'in',
  'into',
  'is',
  'it',
  'no',
  'not',
  'of',
  'on',
  'or',
  'such',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'will',
  'with',
]);

/** Split text into lowercase tokens, stripping punctuation and stop words. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

// ---- BM25 Index ----

interface DocEntry {
  /** Token frequencies for this document. */
  termFreqs: Map<string, number>;
  /** Total token count. */
  length: number;
}

export interface BM25Result {
  id: string;
  score: number;
}

/** Maximum number of prefix-expanded tokens to consider per query term. */
const MAX_PREFIX_EXPANSIONS = 20;

export class BM25Index {
  private docs = new Map<string, DocEntry>();
  /** token → set of doc IDs containing that token */
  private invertedIndex = new Map<string, Set<string>>();
  /** Sorted token list for efficient prefix scanning. Rebuilt lazily. */
  private sortedTokens: string[] = [];
  private sortedTokensDirty = true;
  private totalLength = 0;
  private k1: number;
  private b: number;

  constructor(k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
  }

  get size(): number {
    return this.docs.size;
  }

  /** Add or update a document in the index. */
  addDocument(id: string, text: string): void {
    // Remove old version if updating
    if (this.docs.has(id)) {
      this.removeDocument(id);
    }

    const tokens = tokenize(text);
    const termFreqs = new Map<string, number>();

    for (const token of tokens) {
      termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1);

      let posting = this.invertedIndex.get(token);
      if (!posting) {
        posting = new Set();
        this.invertedIndex.set(token, posting);
        this.sortedTokensDirty = true;
      }
      posting.add(id);
    }

    this.docs.set(id, { termFreqs, length: tokens.length });
    this.totalLength += tokens.length;
  }

  /** Remove a document from the index. */
  removeDocument(id: string): boolean {
    const doc = this.docs.get(id);
    if (!doc) return false;

    for (const token of doc.termFreqs.keys()) {
      const posting = this.invertedIndex.get(token);
      if (posting) {
        posting.delete(id);
        if (posting.size === 0) {
          this.invertedIndex.delete(token);
          this.sortedTokensDirty = true;
        }
      }
    }

    this.totalLength -= doc.length;
    this.docs.delete(id);
    return true;
  }

  /** Search the index, returning scored results sorted by relevance. */
  search(queryText: string, limit = 50): BM25Result[] {
    const queryTokens = tokenize(queryText);
    if (queryTokens.length === 0) return [];

    const N = this.docs.size;
    if (N === 0) return [];

    const avgdl = this.totalLength / N;
    const scores = new Map<string, number>();

    for (const term of queryTokens) {
      // Exact match first, then prefix expansion if no exact match
      const postings = this.getPostings(term);

      for (const [token, posting] of postings) {
        const df = posting.size;
        // IDF with smoothing to avoid negative scores
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        // Discount prefix matches slightly so exact matches rank higher
        const prefixPenalty = token === term ? 1.0 : 0.8;

        for (const docId of posting) {
          const doc = this.docs.get(docId)!;
          const tf = doc.termFreqs.get(token) ?? 0;
          const norm = 1 - this.b + this.b * (doc.length / avgdl);
          const tfScore = (tf * (this.k1 + 1)) / (tf + this.k1 * norm);

          scores.set(
            docId,
            (scores.get(docId) ?? 0) + idf * tfScore * prefixPenalty,
          );
        }
      }
    }

    return Array.from(scores.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Get posting lists for a term. Returns exact match if available,
   * otherwise expands to prefix matches (e.g. "sqlite" → "sqlite3").
   */
  private getPostings(term: string): Array<[string, Set<string>]> {
    // Exact match — fast path
    const exact = this.invertedIndex.get(term);
    if (exact) return [[term, exact]];

    // Prefix expansion — only for terms ≥ 3 chars to avoid overly broad matches
    if (term.length < 3) return [];

    this.ensureSortedTokens();
    const results: Array<[string, Set<string>]> = [];

    // Binary search to find the first token ≥ term
    let lo = 0;
    let hi = this.sortedTokens.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sortedTokens[mid] < term) lo = mid + 1;
      else hi = mid;
    }

    // Scan forward while tokens start with the prefix
    for (
      let i = lo;
      i < this.sortedTokens.length && results.length < MAX_PREFIX_EXPANSIONS;
      i++
    ) {
      const token = this.sortedTokens[i];
      if (!token.startsWith(term)) break;
      const posting = this.invertedIndex.get(token);
      if (posting) results.push([token, posting]);
    }

    return results;
  }

  /** Rebuild sorted token list if dirty. */
  private ensureSortedTokens(): void {
    if (!this.sortedTokensDirty) return;
    this.sortedTokens = Array.from(this.invertedIndex.keys()).sort();
    this.sortedTokensDirty = false;
  }
}
