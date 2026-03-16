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
  isExcludedDir,
  detectZipPrefix,
  isBinaryData,
  runWithConcurrency,
  extractFilesFromZip,
} from '../shared';

describe('isExcludedDir', () => {
  it('returns true when an excluded segment is not the last part', () => {
    expect(isExcludedDir(['node_modules', 'express', 'index.js'])).toBe(true);
    expect(isExcludedDir(['.git', 'config'])).toBe(true);
  });

  it('returns false for clean paths', () => {
    expect(isExcludedDir(['src', 'utils', 'format.ts'])).toBe(false);
  });

  it('does not exclude the last segment (it is the filename)', () => {
    expect(isExcludedDir(['src', 'node_modules'])).toBe(false);
  });
});

describe('detectZipPrefix', () => {
  it('extracts prefix from first entry', () => {
    const entries = {
      'owner-repo-abc123/src/main.ts': new Uint8Array(),
      'owner-repo-abc123/README.md': new Uint8Array(),
    };
    expect(detectZipPrefix(entries)).toBe('owner-repo-abc123/');
  });

  it('returns empty for no entries', () => {
    expect(detectZipPrefix({})).toBe('');
  });

  it('returns empty for flat entries', () => {
    expect(detectZipPrefix({ 'file.txt': new Uint8Array() })).toBe('');
  });
});

describe('isBinaryData', () => {
  it('returns true when null byte present in first 8192 bytes', () => {
    const data = new Uint8Array(100);
    data[50] = 0;
    // All zeros, so first byte is 0 already
    expect(isBinaryData(data)).toBe(true);
  });

  it('returns false for pure text data', () => {
    const text = new TextEncoder().encode('Hello world, this is text!');
    expect(isBinaryData(text)).toBe(false);
  });

  it('only checks first 8192 bytes', () => {
    const data = new Uint8Array(10000).fill(65); // 'A'
    data[9000] = 0; // null byte beyond 8192
    expect(isBinaryData(data)).toBe(false);
  });
});

describe('runWithConcurrency', () => {
  it('processes all items', async () => {
    const results: number[] = [];
    await runWithConcurrency([1, 2, 3], 2, async (item) => {
      results.push(item);
    });
    expect(results).toEqual([1, 2, 3]);
  });

  it('respects concurrency limit', async () => {
    let maxActive = 0;
    let active = 0;
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('handles empty array', async () => {
    await runWithConcurrency([], 5, async () => {
      throw new Error('should not be called');
    });
  });
});

describe('extractFilesFromZip', () => {
  it('strips prefix dir and skips directory entries', () => {
    const entries: Record<string, Uint8Array> = {
      'prefix/': new Uint8Array(),
      'prefix/src/': new Uint8Array(),
      'prefix/src/main.ts': new TextEncoder().encode('console.log("hi")'),
    };
    const files = extractFilesFromZip(entries);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/main.ts');
  });

  it('skips excluded dirs', () => {
    const entries: Record<string, Uint8Array> = {
      'p/src/main.ts': new TextEncoder().encode('ok'),
      'p/node_modules/lib/index.js': new TextEncoder().encode('skip'),
    };
    const files = extractFilesFromZip(entries);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/main.ts');
  });

  it('base64-encodes images', () => {
    const entries: Record<string, Uint8Array> = {
      'p/logo.png': new Uint8Array([137, 80, 78, 71]), // PNG header
    };
    const files = extractFilesFromZip(entries);
    expect(files).toHaveLength(1);
    expect(files[0].binary).toBe(true);
    expect(typeof files[0].content).toBe('string');
  });

  it('skips non-image binary files', () => {
    const entries: Record<string, Uint8Array> = {
      'p/app.exe': new Uint8Array([0, 0, 0, 0]),
    };
    const files = extractFilesFromZip(entries);
    expect(files).toHaveLength(0);
  });

  it('calls onProgress', () => {
    const entries: Record<string, Uint8Array> = {
      'p/a.ts': new TextEncoder().encode('a'),
      'p/b.ts': new TextEncoder().encode('b'),
    };
    const calls: number[] = [];
    extractFilesFromZip(entries, (prog) => calls.push(prog.current));
    expect(calls).toEqual([1, 2]);
  });
});
