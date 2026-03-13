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
