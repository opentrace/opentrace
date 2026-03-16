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
