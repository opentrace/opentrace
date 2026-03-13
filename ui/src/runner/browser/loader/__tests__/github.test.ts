import { describe, it, expect } from 'vitest';
import { parseGitHubUrl } from '../github';

// Testing just the pure parseGitHubUrl and canHandle logic.
// The loader's load() requires fetch mocking which is covered by shared.test.ts.

describe('parseGitHubUrl', () => {
  it('parses HTTPS URL', () => {
    const result = parseGitHubUrl('https://github.com/owner/repo');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses SSH URL', () => {
    const result = parseGitHubUrl('git@github.com:owner/repo');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('handles .git suffix', () => {
    const result = parseGitHubUrl('https://github.com/owner/repo.git');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('returns null for non-GitHub URL', () => {
    expect(parseGitHubUrl('https://gitlab.com/owner/repo')).toBeNull();
    expect(parseGitHubUrl('not a url')).toBeNull();
  });
});
