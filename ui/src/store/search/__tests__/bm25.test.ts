import { describe, it, expect } from 'vitest';
import { BM25Index, tokenize } from '../bm25';

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

  it('handles camelCase by splitting on non-alpha', () => {
    // camelCase stays as one token since we only split on non-alphanumeric
    expect(tokenize('AuthMiddleware')).toEqual(['authmiddleware']);
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
