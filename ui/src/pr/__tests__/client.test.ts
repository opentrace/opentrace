import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseRepoUrl, PRClient } from '../client';

// Mock the external dependencies
vi.mock('../githubPR', () => ({
  fetchGitHubPRs: vi.fn().mockResolvedValue([]),
  fetchGitHubPRDetail: vi.fn().mockResolvedValue({}),
  createGitHubReview: vi.fn().mockResolvedValue(undefined),
  postGitHubPRComment: vi.fn().mockResolvedValue(undefined),
  fetchGitHubFileContent: vi.fn().mockResolvedValue('content'),
}));

vi.mock('../gitlabPR', () => ({
  fetchGitLabMRs: vi.fn().mockResolvedValue([]),
  fetchGitLabMRDetail: vi.fn().mockResolvedValue({}),
  postGitLabMRComment: vi.fn().mockResolvedValue(undefined),
  fetchGitLabFileContent: vi.fn().mockResolvedValue('content'),
}));

vi.mock('../../runner/browser/loader/github', () => ({
  parseGitHubUrl: vi.fn((url: string) => {
    const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2] };
  }),
}));

vi.mock('../../runner/browser/loader/gitlab', () => ({
  parseGitLabUrl: vi.fn((url: string) => {
    const match = url.match(/gitlab\.com[/:]([^/]+)\/([^/.]+)/);
    if (!match) return null;
    return { namespace: match[1], project: match[2], host: 'gitlab.com' };
  }),
}));

describe('parseRepoUrl', () => {
  it('parses GitHub HTTPS URL', () => {
    const result = parseRepoUrl('https://github.com/owner/repo');
    expect(result).toEqual({
      provider: 'github',
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses GitLab URL', () => {
    const result = parseRepoUrl('https://gitlab.com/group/project');
    expect(result).toEqual({
      provider: 'gitlab',
      owner: 'group',
      repo: 'project',
      host: 'gitlab.com',
    });
  });

  it('returns null for unknown URL', () => {
    expect(parseRepoUrl('https://bitbucket.org/foo/bar')).toBeNull();
  });
});

describe('PRClient', () => {
  let ghMod: typeof import('../githubPR');
  let glMod: typeof import('../gitlabPR');

  beforeEach(async () => {
    ghMod = await import('../githubPR');
    glMod = await import('../gitlabPR');
    vi.clearAllMocks();
  });

  it('listPRs dispatches to GitHub for github provider', async () => {
    const client = new PRClient(
      { provider: 'github', owner: 'o', repo: 'r' },
      'token',
    );
    await client.listPRs();
    expect(ghMod.fetchGitHubPRs).toHaveBeenCalledWith('o', 'r', 'token');
  });

  it('listPRs dispatches to GitLab for gitlab provider', async () => {
    const client = new PRClient(
      { provider: 'gitlab', owner: 'ns', repo: 'proj', host: 'gl.example.com' },
      'token',
    );
    await client.listPRs();
    expect(glMod.fetchGitLabMRs).toHaveBeenCalledWith(
      'gl.example.com',
      'ns/proj',
      'token',
    );
  });

  it('createReview appends attribution footer', async () => {
    const client = new PRClient(
      { provider: 'github', owner: 'o', repo: 'r' },
      'token',
    );
    await client.createReview(1, 'LGTM', 'APPROVE');
    expect(ghMod.createGitHubReview).toHaveBeenCalledWith(
      'o',
      'r',
      1,
      'token',
      expect.stringContaining('OpenTrace'),
      'APPROVE',
      undefined,
      undefined,
    );
  });

  it('createReview throws without token', async () => {
    const client = new PRClient({ provider: 'github', owner: 'o', repo: 'r' });
    await expect(client.createReview(1, 'x', 'COMMENT')).rejects.toThrow(
      'Token required',
    );
  });

  it('getFileContent dispatches by provider', async () => {
    const ghClient = new PRClient(
      { provider: 'github', owner: 'o', repo: 'r' },
      'tok',
    );
    await ghClient.getFileContent('src/main.ts', 'main');
    expect(ghMod.fetchGitHubFileContent).toHaveBeenCalledWith(
      'o',
      'r',
      'src/main.ts',
      'main',
      'tok',
    );
  });

  it('postComment appends attribution footer', async () => {
    const client = new PRClient(
      { provider: 'github', owner: 'o', repo: 'r' },
      'tok',
    );
    await client.postComment(5, 'Nice');
    expect(ghMod.postGitHubPRComment).toHaveBeenCalledWith(
      'o',
      'r',
      5,
      'tok',
      expect.stringContaining('OpenTrace'),
    );
  });

  it('postComment throws without token', async () => {
    const client = new PRClient({ provider: 'github', owner: 'o', repo: 'r' });
    await expect(client.postComment(1, 'x')).rejects.toThrow('Token required');
  });
});
