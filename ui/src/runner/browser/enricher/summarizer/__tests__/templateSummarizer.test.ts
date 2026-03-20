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
import {
  splitIdentifier,
  extractKeywords,
  summarizeFunction,
  summarizeClass,
  summarizeFile,
  summarizeDirectory,
  summarizeFromMetadata,
} from '@opentrace/components/pipeline';

describe('splitIdentifier', () => {
  it('splits camelCase', () => {
    expect(splitIdentifier('camelCase')).toEqual(['camel', 'Case']);
  });

  it('splits PascalCase', () => {
    expect(splitIdentifier('PascalCase')).toEqual(['Pascal', 'Case']);
  });

  it('splits snake_case', () => {
    expect(splitIdentifier('snake_case')).toEqual(['snake', 'case']);
  });

  it('splits SCREAMING_SNAKE', () => {
    expect(splitIdentifier('SCREAMING_SNAKE')).toEqual(['SCREAMING', 'SNAKE']);
  });

  it('handles acronyms like parseHTTPResponse', () => {
    expect(splitIdentifier('parseHTTPResponse')).toEqual([
      'parse',
      'HTTP',
      'Response',
    ]);
  });

  it('handles digit boundaries', () => {
    expect(splitIdentifier('base64Encode')).toEqual(['base', '64', 'Encode']);
  });

  it('strips leading underscores', () => {
    const result = splitIdentifier('__private');
    expect(result).toEqual(['private']);
  });
});

describe('extractKeywords', () => {
  it('detects database keywords', () => {
    const keywords = extractKeywords(
      'const result = db.query("SELECT * FROM users")',
    );
    expect(keywords).toContain('database');
  });

  it('detects auth keywords', () => {
    const keywords = extractKeywords('function validateJWT(token) { }');
    expect(keywords).toContain('auth');
  });

  it('detects HTTP keywords', () => {
    const keywords = extractKeywords('const res = await fetch(url)');
    expect(keywords).toContain('http');
  });

  it('detects crypto keywords', () => {
    const keywords = extractKeywords(
      'import crypto from "crypto"; encrypt(data)',
    );
    expect(keywords).toContain('crypto');
  });

  it('returns max 4 keywords', () => {
    // Source with many domain signals
    const source =
      'db.query(sql); jwt.verify(token); fetch(url); crypto.hash(data); redis.get(key)';
    expect(extractKeywords(source).length).toBeLessThanOrEqual(4);
  });

  it('returns empty for non-matching source', () => {
    expect(extractKeywords('const x = 1 + 2')).toEqual([]);
  });
});

describe('summarizeFunction', () => {
  it('summarizes constructors', () => {
    expect(summarizeFunction('__init__')).toBe('Initializes instance');
    expect(
      summarizeFunction(
        'constructor',
        undefined,
        undefined,
        undefined,
        'UserService',
      ),
    ).toBe('Initializes UserService');
  });

  it('summarizes test functions', () => {
    const result = summarizeFunction('test_user_creation');
    expect(result).toMatch(/^Tests/);
  });

  it('uses known verb map', () => {
    expect(summarizeFunction('getUserById')).toBe('Retrieves user by id');
    expect(summarizeFunction('validateEmail')).toBe('Validates email');
    expect(summarizeFunction('createOrder')).toBe('Creates order');
  });

  it('returns generic for non-descriptive names', () => {
    expect(summarizeFunction('fn')).toBe('Function fn');
    expect(summarizeFunction('x')).toBe('Function x');
  });

  it('includes receiver type for Go methods', () => {
    const result = summarizeFunction(
      'getUsers',
      undefined,
      undefined,
      undefined,
      'UserRepo',
    );
    expect(result).toContain('UserRepo method');
  });
});

describe('summarizeClass', () => {
  it('detects CRUD pattern with >= 3 CRUD methods', () => {
    const result = summarizeClass('UserRepository', [
      'create',
      'findById',
      'update',
      'delete',
    ]);
    expect(result).toContain('CRUD');
  });

  it('lists methods (up to 5 + more)', () => {
    const methods = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const result = summarizeClass('MyClass', methods);
    expect(result).toContain('a, b, c, d, e');
    expect(result).toContain('and 2 more');
  });

  it('includes keyword tags from source', () => {
    const result = summarizeClass('AuthManager', [], 'jwt.verify(token)');
    expect(result).toContain('[auth');
  });
});

describe('summarizeFile', () => {
  it('detects test files', () => {
    expect(summarizeFile('user.test.ts')).toMatch(/^Tests for/);
    expect(summarizeFile('test_user.py')).toMatch(/^Tests for/);
  });

  it('detects index files', () => {
    expect(summarizeFile('index.ts')).toContain('Barrel exports for');
  });

  it('detects config files', () => {
    expect(summarizeFile('vite.config.ts')).toMatch(/^Configuration for/);
  });

  it('generic file with symbols', () => {
    // 'helpers.go' matches the helpers? pattern → "Helper functions" (known file pattern wins)
    const result = summarizeFile('utils.go', [
      'parseURL',
      'buildQuery',
      'formatDate',
      'validate',
    ]);
    // utils.go matches utils? pattern → "Utility functions"
    expect(result).toBe('Utility functions');

    // A truly generic file lists symbols
    const result2 = summarizeFile('converter.go', [
      'parseURL',
      'buildQuery',
      'formatDate',
      'validate',
    ]);
    expect(result2).toContain('parseURL');
    expect(result2).toContain('and 1 more');
  });
});

describe('summarizeDirectory', () => {
  it('returns known purpose for recognized dirs', () => {
    expect(summarizeDirectory('api', ['server.ts'])).toContain('API layer');
  });

  it('lists children for known dirs', () => {
    const result = summarizeDirectory('utils', ['format.ts', 'parse.ts']);
    expect(result).toContain('containing format.ts, parse.ts');
  });

  it('handles unknown dirs with children', () => {
    const result = summarizeDirectory('mydir', ['file1.ts']);
    expect(result).toContain('Directory containing file1.ts');
  });

  it('handles unknown dirs without children', () => {
    expect(summarizeDirectory('mydir', [])).toBe('Directory mydir');
  });
});

describe('summarizeFromMetadata', () => {
  it('prefers doc comment first sentence over heuristic', () => {
    const result = summarizeFromMetadata({
      name: 'foo',
      kind: 'function',
      docs: 'Computes the fibonacci sequence. This is a detailed explanation.',
    });
    expect(result).toBe('Computes the fibonacci sequence');
  });

  it('falls back to heuristic when no docs', () => {
    const result = summarizeFromMetadata({
      name: 'getUserById',
      kind: 'function',
    });
    expect(result).toBe('Retrieves user by id');
  });

  it('handles class kind', () => {
    const result = summarizeFromMetadata({
      name: 'UserService',
      kind: 'class',
      childNames: ['create', 'find'],
    });
    expect(result).toContain('User service');
  });

  it('handles file kind', () => {
    const result = summarizeFromMetadata({
      name: 'utils.ts',
      kind: 'file',
      fileName: 'utils.ts',
    });
    expect(result).toMatch(/Utility functions|Source file/);
  });

  it('handles directory kind', () => {
    const result = summarizeFromMetadata({
      name: 'components',
      kind: 'directory',
      childNames: ['Button.tsx'],
    });
    expect(result).toContain('UI components');
  });
});
