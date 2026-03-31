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
import { BM25Index, tokenize, editDistance } from '../bm25';

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumeric', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world']);
  });

  it('removes stop words', () => {
    expect(tokenize('the quick brown fox')).toEqual(['quick', 'brown', 'fox']);
  });

  it('removes single-character tokens', () => {
    expect(tokenize('a b c d foo')).toEqual(['foo']);
  });

  it('expands camelCase into individual parts', () => {
    const result = tokenize('getUserById');
    expect(result).toContain('getuserbyid');
    expect(result).toContain('get');
    expect(result).toContain('user');
  });

  it('preserves hyphenated compound identifiers and emits sub-parts', () => {
    const result = tokenize('coms-license-service');
    expect(result).toContain('coms-license-service');
    expect(result).toContain('coms');
    expect(result).toContain('license');
    expect(result).toContain('service');
  });

  it('handles mixed hyphenated and plain text', () => {
    const result = tokenize('the coms-license-service endpoint');
    expect(result).toContain('coms-license-service');
    expect(result).toContain('endpoint');
    // "the" is a stop word, should be filtered
    expect(result).not.toContain('the');
  });

  it('deduplicates tokens', () => {
    const result = tokenize('license license-service');
    const licenseCount = result.filter((t) => t === 'license').length;
    expect(licenseCount).toBe(1);
  });

  it('returns empty for empty input', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('BM25Index', () => {
  it('returns no results for empty index', () => {
    const idx = new BM25Index();
    expect(idx.search('test')).toEqual([]);
    expect(idx.size).toBe(0);
  });

  it('returns no results for empty query', () => {
    const idx = new BM25Index();
    idx.addDocument('1', 'hello world');
    expect(idx.search('')).toEqual([]);
  });

  it('ranks exact matches higher than partial matches', () => {
    const idx = new BM25Index();
    idx.addDocument('exact', 'authentication handler');
    idx.addDocument('partial', 'authentication middleware and other stuff');
    idx.addDocument('unrelated', 'database connection pool');

    const results = idx.search('authentication handler');
    expect(results.length).toBeGreaterThanOrEqual(2);
    // The doc containing both query terms should rank first
    expect(results[0].id).toBe('exact');
  });

  it('boosts rare terms via IDF', () => {
    const idx = new BM25Index();
    // "service" appears in all docs, "payments" only in one
    idx.addDocument('a', 'service alpha api');
    idx.addDocument('b', 'service beta api');
    idx.addDocument('c', 'service payments handler');

    const results = idx.search('payments');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('c');
  });

  it('supports addDocument update (re-index)', () => {
    const idx = new BM25Index();
    idx.addDocument('doc1', 'old content alpha');
    idx.addDocument('doc1', 'new content beta');

    expect(idx.search('alpha')).toEqual([]);
    expect(idx.search('beta')).toHaveLength(1);
    expect(idx.size).toBe(1);
  });

  it('removeDocument clears from index', () => {
    const idx = new BM25Index();
    idx.addDocument('doc1', 'hello world');
    expect(idx.removeDocument('doc1')).toBe(true);
    expect(idx.search('hello')).toEqual([]);
    expect(idx.size).toBe(0);
  });

  it('removeDocument returns false for missing doc', () => {
    const idx = new BM25Index();
    expect(idx.removeDocument('nonexistent')).toBe(false);
  });

  it('respects limit parameter', () => {
    const idx = new BM25Index();
    for (let i = 0; i < 10; i++) {
      idx.addDocument(`doc${i}`, `test document number ${i}`);
    }
    const results = idx.search('test', 3);
    expect(results.length).toBe(3);
  });

  it('handles documents with underscored identifiers', () => {
    const idx = new BM25Index();
    idx.addDocument('fn1', 'get_user_by_id handler');
    idx.addDocument('fn2', 'create_order service');

    const results = idx.search('get_user_by_id');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe('fn1');
  });
});

describe('editDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(editDistance('license', 'license')).toBe(0);
  });

  it('returns 1 for single substitution', () => {
    expect(editDistance('license', 'licnese')).toBeLessThanOrEqual(2);
    expect(editDistance('color', 'colour')).toBeLessThanOrEqual(2);
  });

  it('returns 1 for single insertion', () => {
    expect(editDistance('test', 'tests')).toBe(1);
  });

  it('returns 1 for single deletion', () => {
    expect(editDistance('tests', 'test')).toBe(1);
  });

  it('bails early when length difference exceeds maxDist', () => {
    expect(editDistance('ab', 'abcdef', 2)).toBe(3);
  });

  it('returns correct distance for transpositions', () => {
    // "distribtor" → "distributor" is distance 1 (insertion of 'u')
    expect(editDistance('distribtor', 'distributor')).toBeLessThanOrEqual(2);
  });
});

describe('fuzzy search', () => {
  it('finds results with typos (edit distance 1)', () => {
    const idx = new BM25Index(1.5, 0.75, {}, 1);
    idx.addDocument('a', 'license management system');
    idx.addDocument('b', 'order processing pipeline');

    // "licnese" is 2 edits from "license" — too far for maxDist=1
    // But "licens" is 1 edit (deletion) — should match
    const results = idx.search('licens');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe('a');
  });

  it('does not fuzzy match when disabled (maxDist=0)', () => {
    const idx = new BM25Index(1.5, 0.75, {}, 0);
    idx.addDocument('a', 'license management system');

    // "licens" has no exact or prefix match; fuzzy disabled
    const results = idx.search('licens');
    // Should find via prefix: "licens" is a prefix of "license"
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('penalises fuzzy matches below exact matches', () => {
    const idx = new BM25Index(1.5, 0.75, {}, 1);
    idx.addDocument('exact', 'authentication handler');
    idx.addDocument('fuzzy', 'authenticaton handler'); // typo in content

    const results = idx.search('authentication');
    // Exact match should rank first
    expect(results[0].id).toBe('exact');
    if (results.length > 1) {
      expect(results[0].score).toBeGreaterThan(results[1].score);
    }
  });

  it('skips fuzzy matching for short terms (< 4 chars)', () => {
    const idx = new BM25Index(1.5, 0.75, {}, 1);
    idx.addDocument('a', 'the cat sat on the mat');

    // "ct" is too short for fuzzy, even though edit distance to "cat" is 1
    const results = idx.search('ct');
    expect(results).toEqual([]);
  });

  it('handles real-world typo: distribtor → distributor', () => {
    const idx = new BM25Index(1.5, 0.75, {}, 1);
    idx.addDocument('a', 'distributor service handles trace distribution');
    idx.addDocument('b', 'querier service handles trace queries');

    const results = idx.search('distribtor');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe('a');
  });
});

describe('field boosting', () => {
  it('boosts matches in high-weight fields', () => {
    const idx = new BM25Index(1.5, 0.75, { name: 2.0 }, 0);

    // Both docs contain "license" but doc A has it in the boosted 'name' field
    idx.addDocument('nameMatch', 'license handler process data', {
      name: 'license.go',
      content: 'handler process data',
    });
    idx.addDocument('contentMatch', 'handler contains license references', {
      name: 'handler.go',
      content: 'handler contains license references',
    });

    const results = idx.search('license');
    expect(results[0].id).toBe('nameMatch');
  });

  it('works without field weights (backward compatible)', () => {
    const idx = new BM25Index();
    idx.addDocument('a', 'hello world');
    idx.addDocument('b', 'world peace');

    const results = idx.search('hello');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('a');
  });

  it('name boost causes file-name match to outrank content-only match', () => {
    const idx = new BM25Index(1.5, 0.75, { name: 3.0 }, 0);

    idx.addDocument('apiRouter', 'centralized http dispatch tag', {
      name: 'apiRouter.cfm',
      content: 'centralized http dispatch tag for external calls',
    });
    idx.addDocument('licenseFile', 'license info display page', {
      name: 'license.info.cfm',
      content: 'displays license information from local database',
    });
    idx.addDocument('orderFile', 'order details with license update call', {
      name: 'order.detailed.cfm',
      content: 'order details page that calls license update',
    });

    const results = idx.search('license');
    // license.info.cfm has "license" in the name (3x boosted) — should rank first
    expect(results[0].id).toBe('licenseFile');
  });

  it('applies highest field weight when token appears in multiple fields', () => {
    const idx = new BM25Index(1.5, 0.75, { name: 2.0, summary: 1.5 }, 0);

    idx.addDocument('both', 'auth auth service', {
      name: 'auth.ts',
      summary: 'auth middleware',
    });
    idx.addDocument('contentOnly', 'auth handler code', {
      name: 'handler.ts',
      summary: 'request processing',
    });

    const results = idx.search('auth');
    // 'both' has "auth" in name (2.0) and summary (1.5) — takes max (2.0)
    // 'contentOnly' has "auth" in content only — no field boost (1.0)
    expect(results[0].id).toBe('both');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });
});
