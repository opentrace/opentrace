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
import { parseAzureDevOpsUrl } from '../azuredevops';

describe('parseAzureDevOpsUrl', () => {
  it('parses dev.azure.com full format', () => {
    expect(
      parseAzureDevOpsUrl('https://dev.azure.com/org/project/_git/repo'),
    ).toEqual({
      org: 'org',
      project: 'project',
      repo: 'repo',
      host: 'dev.azure.com',
    });
  });

  it('keeps dots in repo names (full format)', () => {
    expect(
      parseAzureDevOpsUrl('https://dev.azure.com/org/project/_git/my.repo'),
    ).toMatchObject({ repo: 'my.repo' });
  });

  it('strips a trailing .git suffix', () => {
    expect(
      parseAzureDevOpsUrl('https://dev.azure.com/org/project/_git/my.repo.git'),
    ).toMatchObject({ repo: 'my.repo' });
  });

  it('parses dev.azure.com short format with dotted repo', () => {
    expect(
      parseAzureDevOpsUrl('https://dev.azure.com/org/_git/my.repo'),
    ).toEqual({
      org: 'org',
      project: 'my.repo',
      repo: 'my.repo',
      host: 'dev.azure.com',
    });
  });

  it('parses visualstudio.com full format with dotted repo', () => {
    expect(
      parseAzureDevOpsUrl('https://org.visualstudio.com/project/_git/my.repo'),
    ).toEqual({
      org: 'org',
      project: 'project',
      repo: 'my.repo',
      host: 'dev.azure.com',
    });
  });

  it('parses visualstudio.com short format with dotted repo', () => {
    expect(
      parseAzureDevOpsUrl('https://org.visualstudio.com/_git/my.repo'),
    ).toEqual({
      org: 'org',
      project: 'my.repo',
      repo: 'my.repo',
      host: 'dev.azure.com',
    });
  });

  it('parses vs-ssh format with dotted repo', () => {
    expect(
      parseAzureDevOpsUrl(
        'https://vs-ssh.visualstudio.com/v3/org/project/my.repo',
      ),
    ).toEqual({
      org: 'org',
      project: 'project',
      repo: 'my.repo',
      host: 'dev.azure.com',
    });
  });

  it('stops the repo at a path separator / query / fragment', () => {
    expect(
      parseAzureDevOpsUrl(
        'https://dev.azure.com/org/project/_git/repo?version=GBmain',
      ),
    ).toMatchObject({ repo: 'repo' });
    expect(
      parseAzureDevOpsUrl(
        'https://dev.azure.com/org/project/_git/repo/branches',
      ),
    ).toMatchObject({ repo: 'repo' });
  });

  it('returns null for non-Azure URLs', () => {
    expect(parseAzureDevOpsUrl('https://github.com/foo/bar')).toBeNull();
  });
});
