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

import { describe, it, expect, vi } from 'vitest';
import { readDirectoryFiles } from '../directory';

/** Minimal File stand-in with the members readDirectoryFiles touches. */
function fakeFile(
  relPath: string,
  content: string,
  opts: { failRead?: boolean } = {},
): File {
  const bytes = new TextEncoder().encode(content);
  return {
    name: relPath.split('/').pop()!,
    webkitRelativePath: `root/${relPath}`,
    size: bytes.length,
    slice: (start: number, end: number) => ({
      arrayBuffer: async () => {
        if (opts.failRead) {
          throw new DOMException('read failed', 'NotReadableError');
        }
        return bytes.slice(start, end).buffer;
      },
    }),
    text: async () => {
      if (opts.failRead) {
        throw new DOMException('read failed', 'NotReadableError');
      }
      return content;
    },
  } as unknown as File;
}

function fakeFileList(files: File[]): FileList {
  const list = files as unknown as FileList & File[];
  return list;
}

describe('readDirectoryFiles', () => {
  it('reads all readable files', async () => {
    const tree = await readDirectoryFiles(
      fakeFileList([fakeFile('src/a.ts', 'aaa'), fakeFile('src/b.ts', 'bbb')]),
      'myrepo',
    );
    expect(tree.repo).toBe('myrepo');
    expect(tree.files.map((f) => f.path).sort()).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('skips unreadable files with a warning instead of failing the job', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tree = await readDirectoryFiles(
        fakeFileList([
          fakeFile('src/good1.ts', 'one'),
          fakeFile('src/broken.ts', 'x', { failRead: true }),
          fakeFile('src/good2.ts', 'two'),
        ]),
        'myrepo',
      );
      // The unreadable file is skipped; the rest of the tree loads.
      expect(tree.files.map((f) => f.path).sort()).toEqual([
        'src/good1.ts',
        'src/good2.ts',
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('skipping unreadable file "src/broken.ts"'),
        expect.anything(),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
