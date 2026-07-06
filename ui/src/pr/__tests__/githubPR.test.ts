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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchGitHubPRs,
  fetchGitHubPRDetail,
  createGitHubReview,
  fetchGitHubFileContent,
  postGitHubPRComment,
} from '../githubPR';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('fetchGitHubPRs', () => {
  it('calls correct URL and maps results', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        {
          number: 1,
          title: 'Test PR',
          state: 'open',
          draft: false,
          user: { login: 'author' },
          html_url: 'https://github.com/o/r/pull/1',
          created_at: '2025-01-01',
          updated_at: '2025-01-02',
          base: { ref: 'main' },
          head: { ref: 'feat' },
        },
      ]),
    );

    const result = await fetchGitHubPRs('owner', 'repo', 'token');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/repos/owner/repo/pulls'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
    expect(result[0].state).toBe('open');
  });

  it('maps draft PRs to draft state', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        {
          number: 2,
          title: 'Draft',
          state: 'open',
          draft: true,
          user: { login: 'a' },
          html_url: '',
          created_at: '',
          updated_at: '',
          base: { ref: 'main' },
          head: { ref: 'f' },
        },
      ]),
    );
    const result = await fetchGitHubPRs('o', 'r');
    expect(result[0].state).toBe('draft');
  });
});

describe('fetchGitHubPRDetail', () => {
  it('fetches PR and files in parallel', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          number: 1,
          title: 'PR',
          state: 'open',
          draft: false,
          user: { login: 'a' },
          html_url: '',
          created_at: '',
          updated_at: '',
          base: { ref: 'main' },
          head: { ref: 'feat' },
          body: 'desc',
          comments: 2,
          review_comments: 1,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            filename: 'src/main.ts',
            status: 'added',
            additions: 10,
            deletions: 0,
            patch: '@@ +1,10 @@',
          },
        ]),
      );

    const detail = await fetchGitHubPRDetail('o', 'r', 1, 'tok');
    expect(detail.files).toHaveLength(1);
    expect(detail.files[0].status).toBe('added');
    expect(detail.body).toBe('desc');
  });

  it('captures base/head SHAs and fork head repo', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          number: 1,
          title: 'PR',
          state: 'open',
          user: { login: 'a' },
          html_url: '',
          created_at: '',
          updated_at: '',
          base: { ref: 'main', sha: 'base123', repo: { full_name: 'o/r' } },
          head: { ref: 'feat', sha: 'head456', repo: { full_name: 'fork/r' } },
          body: '',
        }),
      )
      .mockResolvedValueOnce(jsonResponse([]));

    const detail = await fetchGitHubPRDetail('o', 'r', 1, 'tok');
    expect(detail.base_sha).toBe('base123');
    expect(detail.head_sha).toBe('head456');
    expect(detail.head_repo).toBe('fork/r');
  });

  it('omits head_repo for same-repo PRs', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          number: 1,
          title: 'PR',
          state: 'open',
          user: { login: 'a' },
          html_url: '',
          created_at: '',
          updated_at: '',
          base: { ref: 'main', sha: 'b', repo: { full_name: 'o/r' } },
          head: { ref: 'feat', sha: 'h', repo: { full_name: 'o/r' } },
          body: '',
        }),
      )
      .mockResolvedValueOnce(jsonResponse([]));

    const detail = await fetchGitHubPRDetail('o', 'r', 1, 'tok');
    expect(detail.head_repo).toBeUndefined();
  });

  it('paginates the files listing past 100 entries', async () => {
    const fileEntry = (i: number) => ({
      filename: `src/f${i}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 1,
      patch: '@@',
    });
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          number: 1,
          title: 'PR',
          state: 'open',
          user: { login: 'a' },
          html_url: '',
          created_at: '',
          updated_at: '',
          base: { ref: 'main' },
          head: { ref: 'feat' },
          body: '',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(Array.from({ length: 100 }, (_, i) => fileEntry(i))),
      )
      .mockResolvedValueOnce(
        jsonResponse(Array.from({ length: 50 }, (_, i) => fileEntry(100 + i))),
      );

    const detail = await fetchGitHubPRDetail('o', 'r', 1, 'tok');
    expect(detail.files).toHaveLength(150);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('page=2'),
      expect.anything(),
    );
  });
});

describe('createGitHubReview', () => {
  it('posts review with body and event', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await createGitHubReview('o', 'r', 1, 'tok', 'LGTM', 'APPROVE');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/reviews'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  // "@@ -1,3 +5,4 @@" — right side covers lines 5-8
  const patch = '@@ -1,3 +5,4 @@\n line5\n+line6\n+line7\n line8';
  const fileDiffs = [
    {
      path: 'src/a.ts',
      status: 'modified' as const,
      additions: 2,
      deletions: 0,
      patch,
    },
  ];

  function sentPayload() {
    const [, init] = mockFetch.mock.calls[0];
    return JSON.parse(init.body);
  }

  it('keeps comments on exact diff lines', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await createGitHubReview(
      'o',
      'r',
      1,
      'tok',
      'body',
      'COMMENT',
      [{ body: 'exact', path: 'src/a.ts', line: 6 }],
      fileDiffs,
    );
    expect(sentPayload().comments).toEqual([
      { body: 'exact', path: 'src/a.ts', line: 6, side: 'RIGHT' },
    ]);
  });

  it('snaps comments within 3 lines of the diff', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await createGitHubReview(
      'o',
      'r',
      1,
      'tok',
      'body',
      'COMMENT',
      [
        { body: 'near', path: 'src/a.ts', line: 10 }, // 2 away from line 8
      ],
      fileDiffs,
    );
    const payload = sentPayload();
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].line).toBe(8);
    expect(payload.comments[0].body).toContain('(re: line 10)');
  });

  it('folds far-away comments into the review body instead of relocating', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await createGitHubReview(
      'o',
      'r',
      1,
      'tok',
      'body',
      'COMMENT',
      [{ body: 'way off', path: 'src/a.ts', line: 200 }],
      fileDiffs,
    );
    const payload = sentPayload();
    expect(payload.comments).toBeUndefined();
    expect(payload.body).toContain('Additional comments');
    expect(payload.body).toContain('`src/a.ts:200` — way off');
  });

  it('folds comments on files without patch data into the body', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await createGitHubReview(
      'o',
      'r',
      1,
      'tok',
      'body',
      'COMMENT',
      [{ body: 'binary file note', path: 'assets/logo.png', line: 1 }],
      fileDiffs,
    );
    const payload = sentPayload();
    expect(payload.comments).toBeUndefined();
    expect(payload.body).toContain('binary file note');
  });
});

describe('fetchGitHubFileContent', () => {
  it('decodes base64 content', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ type: 'file', content: btoa('hello world') }),
    );
    const content = await fetchGitHubFileContent('o', 'r', 'src/f.ts', 'main');
    expect(content).toBe('hello world');
  });

  it('returns null on error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('not found'));
    const content = await fetchGitHubFileContent('o', 'r', 'missing', 'main');
    expect(content).toBeNull();
  });

  it('returns null for non-file type', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ type: 'dir', content: null }),
    );
    const content = await fetchGitHubFileContent('o', 'r', 'src/', 'main');
    expect(content).toBeNull();
  });
});

describe('postGitHubPRComment', () => {
  it('posts to issues endpoint', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await postGitHubPRComment('o', 'r', 5, 'tok', 'Nice work');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/issues/5/comments'),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('error handling', () => {
  it('throws with status code on non-OK response', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse('Not Found', 404));
    await expect(fetchGitHubPRs('o', 'r', 'tok')).rejects.toThrow('404');
  });
});
