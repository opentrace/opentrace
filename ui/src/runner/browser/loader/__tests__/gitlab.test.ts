import { describe, it, expect } from 'vitest';
import { parseGitLabUrl } from '../gitlab';

describe('parseGitLabUrl', () => {
  it('parses basic gitlab.com URL', () => {
    const result = parseGitLabUrl('https://gitlab.com/group/project');
    expect(result).toMatchObject({
      host: 'gitlab.com',
      namespace: 'group',
      project: 'project',
    });
  });

  it('handles subgroups', () => {
    const result = parseGitLabUrl('https://gitlab.com/group/subgroup/project');
    expect(result).toMatchObject({
      namespace: 'group/subgroup',
      project: 'project',
    });
  });

  it('handles self-hosted GitLab', () => {
    const result = parseGitLabUrl('https://gitlab.company.com/team/repo');
    expect(result).toMatchObject({
      host: 'gitlab.company.com',
      namespace: 'team',
      project: 'repo',
    });
  });

  it('encodes projectPath', () => {
    const result = parseGitLabUrl('https://gitlab.com/group/project');
    expect(result!.projectPath).toBe(encodeURIComponent('group/project'));
  });

  it('strips .git suffix', () => {
    const result = parseGitLabUrl('https://gitlab.com/group/project.git');
    expect(result!.project).toBe('project');
  });

  it('returns null for non-GitLab URL', () => {
    expect(parseGitLabUrl('https://github.com/foo/bar')).toBeNull();
  });
});
