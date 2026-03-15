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

vi.mock('../bitbucketPR', () => ({
  fetchBitbucketPRs: vi.fn().mockResolvedValue([]),
  fetchBitbucketPRDetail: vi.fn().mockResolvedValue({}),
  postBitbucketPRComment: vi.fn().mockResolvedValue(undefined),
  fetchBitbucketFileContent: vi.fn().mockResolvedValue('content'),
}));

vi.mock('../azuredevopsPR', () => ({
  fetchAzureDevOpsPRs: vi.fn().mockResolvedValue([]),
  fetchAzureDevOpsPRDetail: vi.fn().mockResolvedValue({}),
  postAzureDevOpsPRComment: vi.fn().mockResolvedValue(undefined),
  fetchAzureDevOpsFileContent: vi.fn().mockResolvedValue('content'),
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

vi.mock('../../runner/browser/loader/bitbucket', () => ({
  parseBitbucketUrl: vi.fn((url: string) => {
    const match = url.match(/bitbucket\.org[/:]([^/]+)\/([^/.]+)/);
    if (!match) return null;
    return { workspace: match[1], repo: match[2] };
  }),
}));

vi.mock('../../runner/browser/loader/azuredevops', () => ({
  parseAzureDevOpsUrl: vi.fn((url: string) => {
    // Full: dev.azure.com/{org}/{project}/_git/{repo}
    const devFullMatch = url.match(
      /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/.?#]+)/,
    );
    if (devFullMatch) {
      return {
        org: devFullMatch[1],
        project: devFullMatch[2],
        repo: devFullMatch[3],
        host: 'dev.azure.com',
      };
    }
    // Short: dev.azure.com/{org}/_git/{repo} (project = repo)
    const devShortMatch = url.match(
      /dev\.azure\.com\/([^/]+)\/_git\/([^/.?#]+)/,
    );
    if (devShortMatch) {
      return {
        org: devShortMatch[1],
        project: devShortMatch[2],
        repo: devShortMatch[2],
        host: 'dev.azure.com',
      };
    }
    // Full: {org}.visualstudio.com/{project}/_git/{repo}
    const vsMatch = url.match(
      /([^/.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/.?#]+)/,
    );
    if (vsMatch) {
      return {
        org: vsMatch[1],
        project: vsMatch[2],
        repo: vsMatch[3],
        host: 'dev.azure.com',
      };
    }
    return null;
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

  it('parses Bitbucket URL', () => {
    const result = parseRepoUrl('https://bitbucket.org/workspace/myrepo');
    expect(result).toEqual({
      provider: 'bitbucket',
      owner: 'workspace',
      repo: 'myrepo',
    });
  });

  it('parses Azure DevOps dev.azure.com URL', () => {
    const result = parseRepoUrl(
      'https://dev.azure.com/myorg/myproject/_git/myrepo',
    );
    expect(result).toEqual({
      provider: 'azuredevops',
      owner: 'myorg/myproject',
      repo: 'myrepo',
      host: 'dev.azure.com',
      project: 'myproject',
    });
  });

  it('parses Azure DevOps short-form URL (no project segment)', () => {
    const result = parseRepoUrl(
      'https://dev.azure.com/opentrace/_git/test-project',
    );
    expect(result).toEqual({
      provider: 'azuredevops',
      owner: 'opentrace/test-project',
      repo: 'test-project',
      host: 'dev.azure.com',
      project: 'test-project',
    });
  });

  it('parses Azure DevOps visualstudio.com URL', () => {
    const result = parseRepoUrl(
      'https://myorg.visualstudio.com/myproject/_git/myrepo',
    );
    expect(result).toEqual({
      provider: 'azuredevops',
      owner: 'myorg/myproject',
      repo: 'myrepo',
      host: 'dev.azure.com',
      project: 'myproject',
    });
  });

  it('returns null for unknown URL', () => {
    expect(parseRepoUrl('https://example.com/foo/bar')).toBeNull();
  });
});

describe('PRClient', () => {
  let ghMod: typeof import('../githubPR');
  let glMod: typeof import('../gitlabPR');
  let bbMod: typeof import('../bitbucketPR');
  let adoMod: typeof import('../azuredevopsPR');

  beforeEach(async () => {
    ghMod = await import('../githubPR');
    glMod = await import('../gitlabPR');
    bbMod = await import('../bitbucketPR');
    adoMod = await import('../azuredevopsPR');
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

  it('listPRs dispatches to Bitbucket for bitbucket provider', async () => {
    const client = new PRClient(
      { provider: 'bitbucket', owner: 'ws', repo: 'myrepo' },
      'token',
    );
    await client.listPRs();
    expect(bbMod.fetchBitbucketPRs).toHaveBeenCalledWith(
      'ws',
      'myrepo',
      'token',
    );
  });

  it('listPRs dispatches to Azure DevOps for azuredevops provider', async () => {
    const client = new PRClient(
      { provider: 'azuredevops', owner: 'org/proj', repo: 'myrepo' },
      'token',
    );
    await client.listPRs();
    expect(adoMod.fetchAzureDevOpsPRs).toHaveBeenCalledWith(
      'org/proj',
      'myrepo',
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

  it('createReview falls back to comment for Bitbucket', async () => {
    const client = new PRClient(
      { provider: 'bitbucket', owner: 'ws', repo: 'r' },
      'token',
    );
    await client.createReview(1, 'LGTM', 'APPROVE');
    expect(bbMod.postBitbucketPRComment).toHaveBeenCalledWith(
      'ws',
      'r',
      1,
      'token',
      expect.stringContaining('OpenTrace'),
    );
  });

  it('createReview falls back to comment for Azure DevOps', async () => {
    const client = new PRClient(
      { provider: 'azuredevops', owner: 'org/proj', repo: 'r' },
      'token',
    );
    await client.createReview(1, 'LGTM', 'APPROVE');
    expect(adoMod.postAzureDevOpsPRComment).toHaveBeenCalledWith(
      'org/proj',
      'r',
      1,
      'token',
      expect.stringContaining('OpenTrace'),
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

  it('getFileContent dispatches to Bitbucket', async () => {
    const client = new PRClient(
      { provider: 'bitbucket', owner: 'ws', repo: 'r' },
      'tok',
    );
    await client.getFileContent('src/main.ts', 'main');
    expect(bbMod.fetchBitbucketFileContent).toHaveBeenCalledWith(
      'ws',
      'r',
      'src/main.ts',
      'main',
      'tok',
    );
  });

  it('getFileContent dispatches to Azure DevOps', async () => {
    const client = new PRClient(
      { provider: 'azuredevops', owner: 'org/proj', repo: 'r' },
      'tok',
    );
    await client.getFileContent('src/main.ts', 'main');
    expect(adoMod.fetchAzureDevOpsFileContent).toHaveBeenCalledWith(
      'org/proj',
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
