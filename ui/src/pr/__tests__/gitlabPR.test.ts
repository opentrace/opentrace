import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchGitLabMRs,
  fetchGitLabMRDetail,
  fetchGitLabFileContent,
  postGitLabMRComment,
} from '../gitlabPR';

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

describe('fetchGitLabMRs', () => {
  it('uses encoded project path and PRIVATE-TOKEN header', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        {
          iid: 1,
          title: 'MR 1',
          state: 'opened',
          draft: false,
          author: { username: 'dev' },
          web_url: 'https://gitlab.com/g/p/-/merge_requests/1',
          created_at: '2025-01-01',
          updated_at: '2025-01-02',
          target_branch: 'main',
          source_branch: 'feat',
        },
      ]),
    );

    const result = await fetchGitLabMRs('gitlab.com', 'group/project', 'tok');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent('group/project')),
      expect.objectContaining({
        headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'tok' }),
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].state).toBe('open'); // 'opened' → 'open'
  });

  it('maps draft state', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        {
          iid: 2,
          title: 'Draft MR',
          state: 'opened',
          draft: true,
          author: { username: 'a' },
          web_url: '',
          created_at: '',
          updated_at: '',
          target_branch: 'main',
          source_branch: 'f',
        },
      ]),
    );
    const result = await fetchGitLabMRs('gitlab.com', 'g/p');
    expect(result[0].state).toBe('draft');
  });
});

describe('fetchGitLabMRDetail', () => {
  it('maps diff flags correctly', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          iid: 1,
          title: 'MR',
          state: 'opened',
          draft: false,
          author: { username: 'a' },
          web_url: '',
          created_at: '',
          updated_at: '',
          target_branch: 'main',
          source_branch: 'f',
          description: 'desc',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          changes: [
            {
              new_path: 'new.ts',
              old_path: 'new.ts',
              new_file: true,
              deleted_file: false,
              renamed_file: false,
              diff: '+new',
            },
            {
              new_path: 'moved.ts',
              old_path: 'old.ts',
              new_file: false,
              deleted_file: false,
              renamed_file: true,
              diff: '',
            },
          ],
        }),
      );

    const detail = await fetchGitLabMRDetail('gitlab.com', 'g/p', 1, 'tok');
    expect(detail.files[0].status).toBe('added');
    expect(detail.files[1].status).toBe('renamed');
    expect(detail.files[1].previous_path).toBe('old.ts');
  });
});

describe('fetchGitLabFileContent', () => {
  it('decodes base64 content', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: btoa('hello') }));
    const content = await fetchGitLabFileContent(
      'gitlab.com',
      'g/p',
      'src/f.ts',
      'main',
      'tok',
    );
    expect(content).toBe('hello');
  });

  it('returns null on error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('fail'));
    const content = await fetchGitLabFileContent(
      'gitlab.com',
      'g/p',
      'x',
      'main',
    );
    expect(content).toBeNull();
  });
});

describe('postGitLabMRComment', () => {
  it('posts to notes endpoint', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await postGitLabMRComment('gitlab.com', 'g/p', 3, 'tok', 'comment');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/notes'),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
