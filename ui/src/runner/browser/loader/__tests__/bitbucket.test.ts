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
import { parseBitbucketUrl } from '../bitbucket';

describe('parseBitbucketUrl', () => {
  it('parses basic bitbucket.org URL', () => {
    expect(parseBitbucketUrl('https://bitbucket.org/workspace/repo')).toEqual({
      workspace: 'workspace',
      repo: 'repo',
    });
  });

  it('keeps dots in repo names', () => {
    expect(parseBitbucketUrl('https://bitbucket.org/team/my.repo')).toEqual({
      workspace: 'team',
      repo: 'my.repo',
    });
  });

  it('strips a trailing .git suffix', () => {
    expect(parseBitbucketUrl('https://bitbucket.org/team/my.repo.git')).toEqual(
      {
        workspace: 'team',
        repo: 'my.repo',
      },
    );
  });

  it('stops at a path separator', () => {
    expect(
      parseBitbucketUrl('https://bitbucket.org/team/my.repo/src/main/'),
    ).toEqual({
      workspace: 'team',
      repo: 'my.repo',
    });
  });

  it('stops at query and fragment', () => {
    expect(
      parseBitbucketUrl('https://bitbucket.org/team/repo?at=main'),
    ).toEqual({ workspace: 'team', repo: 'repo' });
    expect(parseBitbucketUrl('https://bitbucket.org/team/repo#readme')).toEqual(
      { workspace: 'team', repo: 'repo' },
    );
  });

  it('returns null for non-Bitbucket URLs', () => {
    expect(parseBitbucketUrl('https://github.com/foo/bar')).toBeNull();
  });
});
