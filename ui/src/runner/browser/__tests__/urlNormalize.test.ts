import { describe, it, expect } from 'vitest';
import { normalizeRepoUrl } from '../loader/urlNormalize';

describe('normalizeRepoUrl', () => {
  describe('HTTPS passthrough', () => {
    it('passes through a plain HTTPS GitHub URL', () => {
      expect(normalizeRepoUrl('https://github.com/owner/repo')).toBe(
        'https://github.com/owner/repo',
      );
    });

    it('passes through a plain HTTPS GitLab URL', () => {
      expect(normalizeRepoUrl('https://gitlab.com/group/project')).toBe(
        'https://gitlab.com/group/project',
      );
    });

    it('strips .git suffix from HTTPS URL', () => {
      expect(normalizeRepoUrl('https://github.com/owner/repo.git')).toBe(
        'https://github.com/owner/repo',
      );
    });
  });

  describe('SCP-style SSH URLs', () => {
    it('converts GitHub SCP URL', () => {
      expect(normalizeRepoUrl('git@github.com:owner/repo.git')).toBe(
        'https://github.com/owner/repo',
      );
    });

    it('converts GitHub SCP URL without .git', () => {
      expect(normalizeRepoUrl('git@github.com:owner/repo')).toBe(
        'https://github.com/owner/repo',
      );
    });

    it('converts GitLab SCP URL', () => {
      expect(normalizeRepoUrl('git@gitlab.com:group/project.git')).toBe(
        'https://gitlab.com/group/project',
      );
    });

    it('converts self-hosted GitLab SCP URL', () => {
      expect(normalizeRepoUrl('git@gitlab.example.com:team/app.git')).toBe(
        'https://gitlab.example.com/team/app',
      );
    });

    it('handles GitLab subgroups', () => {
      expect(
        normalizeRepoUrl('git@gitlab.com:group/subgroup/project.git'),
      ).toBe('https://gitlab.com/group/subgroup/project');
    });
  });

  describe('ssh:// protocol URLs', () => {
    it('converts ssh:// GitHub URL', () => {
      expect(normalizeRepoUrl('ssh://git@github.com/owner/repo.git')).toBe(
        'https://github.com/owner/repo',
      );
    });

    it('converts ssh:// GitLab URL', () => {
      expect(normalizeRepoUrl('ssh://git@gitlab.com/group/project.git')).toBe(
        'https://gitlab.com/group/project',
      );
    });

    it('converts ssh:// without .git suffix', () => {
      expect(normalizeRepoUrl('ssh://git@github.com/owner/repo')).toBe(
        'https://github.com/owner/repo',
      );
    });
  });

  describe('whitespace trimming', () => {
    it('trims leading and trailing whitespace', () => {
      expect(normalizeRepoUrl('  https://github.com/owner/repo  ')).toBe(
        'https://github.com/owner/repo',
      );
    });

    it('trims whitespace from SSH URL', () => {
      expect(normalizeRepoUrl('  git@github.com:owner/repo.git  ')).toBe(
        'https://github.com/owner/repo',
      );
    });
  });
});
