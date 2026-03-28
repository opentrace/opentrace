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

/**
 * Split text into lowercase tokens, preserving compound identifiers and
 * expanding camelCase. Filters punctuation and stop words.
 *
 * "coms-license-service" → ["coms-license-service", "coms", "license", "service"]
 * "getUserById"          → ["getuserbyid", "get", "user", "by", "id"]
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  // Pass 1: extract hyphenated compound identifiers (e.g. "coms-license-service")
  const compoundRe = /[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g;
  const compounds = lower.match(compoundRe) ?? [];
  const withoutCompounds = lower.replace(compoundRe, ' ');

  for (const compound of compounds) {
    tokens.push(compound); // whole compound
    for (const part of compound.split('-')) {
      if (part.length > 1) tokens.push(part); // sub-parts
    }
  }

  // Pass 2: expand camelCase in the original (pre-lowered) text
  // "getUserById" → ["getuserbyid", "get", "user", "by", "id"]
  const camelRe = /[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+/g;
  const camelMatches = text.match(camelRe) ?? [];
  for (const camel of camelMatches) {
    const whole = camel.toLowerCase();
    if (whole.length > 1) tokens.push(whole);
    // Split on uppercase boundaries
    const parts = camel.split(/(?=[A-Z])/).map((p) => p.toLowerCase());
    for (const part of parts) {
      if (part.length > 1) tokens.push(part);
    }
  }

  // Pass 3: standard tokenization on remaining text
  const standard = withoutCompounds
    .replace(/[^a-z0-9_]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  tokens.push(...standard);

  // Deduplicate while preserving order
  return [...new Set(tokens)];
}

// ---- Fuzzy matching ----

/**
 * Compute Levenshtein edit distance between two strings.
 * Bails out early if distance exceeds maxDist (avoids full matrix for distant pairs).
 */
export function editDistance(a: string, b: string, maxDist = 2): number {
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  if (a === b) return 0;

  // Single-row DP (space-optimized)
  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    // Early exit: if minimum in this row already exceeds maxDist, no point continuing
    if (rowMin > maxDist) return maxDist + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// ---- BM25 Index ----

interface DocEntry {
  /** Token frequencies for this document, per field. */
  termFreqs: Map<string, number>;
  /** Total token count. */
  length: number;
  /** Per-field token frequencies (for field boosting). */
  fieldFreqs?: Map<string, Map<string, number>>;
}

export interface BM25Result {
  id: string;
  score: number;
}

/** Field weight configuration. Keys are field names, values are boost multipliers. */
export interface FieldWeights {
  [field: string]: number;
}

/** Maximum number of prefix-expanded tokens to consider per query term. */
const MAX_PREFIX_EXPANSIONS = 20;

/** Maximum number of fuzzy-expanded tokens to consider per query term. */
const MAX_FUZZY_EXPANSIONS = 10;

/** Discount applied to fuzzy matches (edit distance > 0). */
const FUZZY_PENALTY = 0.6;

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
  /** Field weight multipliers (e.g. { name: 2.0, content: 1.0 }). */
  private fieldWeights: FieldWeights;
  /** Maximum edit distance for fuzzy matching. 0 = disabled. */
  private fuzzyMaxDist: number;

  constructor(k1 = 1.5, b = 0.75, fieldWeights?: FieldWeights, fuzzyMaxDist = 1) {
    this.k1 = k1;
    this.b = b;
    this.fieldWeights = fieldWeights ?? {};
    this.fuzzyMaxDist = fuzzyMaxDist;
  }

  get size(): number {
    return this.docs.size;
  }

  /**
   * Add or update a document in the index.
   *
   * @param id - Document identifier.
   * @param text - Full document text (used when no fields are provided).
   * @param fields - Optional field map (e.g. `{ name: "foo.ts", content: "import ..." }`).
   *                 When provided, tokens from each field are boosted according to `fieldWeights`.
   */
  addDocument(id: string, text: string, fields?: Record<string, string>): void {
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

    // Build per-field frequencies for field boosting
    let fieldFreqs: Map<string, Map<string, number>> | undefined;
    if (fields && Object.keys(this.fieldWeights).length > 0) {
      fieldFreqs = new Map();
      for (const [field, value] of Object.entries(fields)) {
        if (!value) continue;
        const fieldTokens = tokenize(value);
        const freqs = new Map<string, number>();
        for (const token of fieldTokens) {
          freqs.set(token, (freqs.get(token) ?? 0) + 1);
        }
        fieldFreqs.set(field, freqs);
      }
    }

    this.docs.set(id, { termFreqs, length: tokens.length, fieldFreqs });
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
    const hasFieldWeights = Object.keys(this.fieldWeights).length > 0;

    for (const term of queryTokens) {
      // Exact match first, then prefix expansion, then fuzzy expansion
      const postings = this.getPostings(term);

      for (const [token, posting, matchPenalty] of postings) {
        const df = posting.size;
        // IDF with smoothing to avoid negative scores
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

        for (const docId of posting) {
          const doc = this.docs.get(docId)!;
          const tf = doc.termFreqs.get(token) ?? 0;
          const norm = 1 - this.b + this.b * (doc.length / avgdl);
          const tfScore = (tf * (this.k1 + 1)) / (tf + this.k1 * norm);

          // Field boosting: if the token appears in a high-weight field, boost the score
          let fieldBoost = 1.0;
          if (hasFieldWeights && doc.fieldFreqs) {
            for (const [field, freqs] of doc.fieldFreqs) {
              if (freqs.has(token)) {
                const weight = this.fieldWeights[field] ?? 1.0;
                if (weight > fieldBoost) fieldBoost = weight;
              }
            }
          }

          scores.set(
            docId,
            (scores.get(docId) ?? 0) + idf * tfScore * matchPenalty * fieldBoost,
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
   * Get posting lists for a term. Returns [token, postings, penalty] tuples.
   *
   * Resolution order:
   * 1. Exact match (penalty 1.0)
   * 2. Prefix expansion (penalty 0.8) — "sqlite" → "sqlite3"
   * 3. Fuzzy expansion (penalty 0.6) — "licnese" → "license"
   */
  private getPostings(term: string): Array<[string, Set<string>, number]> {
    // Exact match — fast path
    const exact = this.invertedIndex.get(term);
    if (exact) return [[term, exact, 1.0]];

    // Prefix expansion — only for terms ≥ 3 chars to avoid overly broad matches
    if (term.length >= 3) {
      this.ensureSortedTokens();
      const prefixResults: Array<[string, Set<string>, number]> = [];

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
        i < this.sortedTokens.length &&
        prefixResults.length < MAX_PREFIX_EXPANSIONS;
        i++
      ) {
        const token = this.sortedTokens[i];
        if (!token.startsWith(term)) break;
        const posting = this.invertedIndex.get(token);
        if (posting) prefixResults.push([token, posting, 0.8]);
      }

      if (prefixResults.length > 0) return prefixResults;
    }

    // Fuzzy expansion — only for terms ≥ 4 chars (short terms produce too many false matches)
    if (this.fuzzyMaxDist > 0 && term.length >= 4) {
      this.ensureSortedTokens();
      const fuzzyResults: Array<[string, Set<string>, number]> = [];

      for (const token of this.sortedTokens) {
        if (fuzzyResults.length >= MAX_FUZZY_EXPANSIONS) break;
        // Skip tokens with large length difference (cheap pre-filter)
        if (Math.abs(token.length - term.length) > this.fuzzyMaxDist) continue;
        const dist = editDistance(term, token, this.fuzzyMaxDist);
        if (dist > 0 && dist <= this.fuzzyMaxDist) {
          const posting = this.invertedIndex.get(token);
          if (posting) fuzzyResults.push([token, posting, FUZZY_PENALTY]);
        }
      }

      if (fuzzyResults.length > 0) return fuzzyResults;
    }

    return [];
  }

  /** Rebuild sorted token list if dirty. */
  private ensureSortedTokens(): void {
    if (!this.sortedTokensDirty) return;
    this.sortedTokens = Array.from(this.invertedIndex.keys()).sort();
    this.sortedTokensDirty = false;
  }
}
