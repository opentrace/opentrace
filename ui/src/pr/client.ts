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

/**
 * Unified PR/MR client that dispatches to GitHub, GitLab, Bitbucket, or Azure DevOps APIs.
 */

import type { PRSummary, PRDetail, PRReviewComment, RepoMeta } from './types';
import {
  fetchGitHubPRs,
  fetchGitHubPRDetail,
  createGitHubReview,
  postGitHubPRComment,
  fetchGitHubFileContent,
} from './githubPR';
import {
  fetchGitLabMRs,
  fetchGitLabMRDetail,
  postGitLabMRComment,
  fetchGitLabFileContent,
} from './gitlabPR';
import {
  fetchBitbucketPRs,
  fetchBitbucketPRDetail,
  postBitbucketPRComment,
  fetchBitbucketFileContent,
} from './bitbucketPR';
import {
  fetchAzureDevOpsPRs,
  fetchAzureDevOpsPRDetail,
  postAzureDevOpsPRComment,
  fetchAzureDevOpsFileContent,
} from './azuredevopsPR';
import { parseGitHubUrl } from '../runner/browser/loader/github';
import { parseGitLabUrl } from '../runner/browser/loader/gitlab';
import { parseBitbucketUrl } from '../runner/browser/loader/bitbucket';
import { parseAzureDevOpsUrl } from '../runner/browser/loader/azuredevops';

const ATTRIBUTION_FOOTER =
  '\n\n---\n*Generated via [OpenTrace](https://app.opentrace.ai)*';

export class PRClient {
  readonly meta: RepoMeta;
  private token?: string;
  /** For GitLab: namespace/project (unencoded) */
  private projectPath?: string;

  constructor(meta: RepoMeta, token?: string) {
    this.meta = meta;
    this.token = token;
    if (meta.provider === 'gitlab') {
      this.projectPath = `${meta.owner}/${meta.repo}`;
    }
  }

  async listPRs(): Promise<PRSummary[]> {
    switch (this.meta.provider) {
      case 'gitlab':
        return fetchGitLabMRs(
          this.meta.host ?? 'gitlab.com',
          this.projectPath!,
          this.token,
        );
      case 'bitbucket':
        return fetchBitbucketPRs(this.meta.owner, this.meta.repo, this.token);
      case 'azuredevops':
        return fetchAzureDevOpsPRs(this.meta.owner, this.meta.repo, this.token);
      default:
        return fetchGitHubPRs(this.meta.owner, this.meta.repo, this.token);
    }
  }

  async getPRDetail(number: number): Promise<PRDetail> {
    switch (this.meta.provider) {
      case 'gitlab':
        return fetchGitLabMRDetail(
          this.meta.host ?? 'gitlab.com',
          this.projectPath!,
          number,
          this.token,
        );
      case 'bitbucket':
        return fetchBitbucketPRDetail(
          this.meta.owner,
          this.meta.repo,
          number,
          this.token,
        );
      case 'azuredevops':
        return fetchAzureDevOpsPRDetail(
          this.meta.owner,
          this.meta.repo,
          number,
          this.token,
        );
      default:
        return fetchGitHubPRDetail(
          this.meta.owner,
          this.meta.repo,
          number,
          this.token,
        );
    }
  }

  async createReview(
    number: number,
    body: string,
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' = 'COMMENT',
    comments?: PRReviewComment[],
    /** Pass PR file diffs so GitHub comment line numbers can be validated against patches */
    fileDiffs?: import('./types').PRFileDiff[],
  ): Promise<void> {
    if (!this.token) throw new Error('Token required for creating reviews');
    const taggedBody = body + ATTRIBUTION_FOOTER;
    // GitLab, Bitbucket, and Azure DevOps don't have a review API — post as comment
    switch (this.meta.provider) {
      case 'gitlab':
        await postGitLabMRComment(
          this.meta.host ?? 'gitlab.com',
          this.projectPath!,
          number,
          this.token,
          taggedBody,
        );
        return;
      case 'bitbucket':
        await postBitbucketPRComment(
          this.meta.owner,
          this.meta.repo,
          number,
          this.token,
          taggedBody,
        );
        return;
      case 'azuredevops':
        await postAzureDevOpsPRComment(
          this.meta.owner,
          this.meta.repo,
          number,
          this.token,
          taggedBody,
        );
        return;
      default:
        await createGitHubReview(
          this.meta.owner,
          this.meta.repo,
          number,
          this.token,
          taggedBody,
          event,
          comments,
          fileDiffs,
        );
    }
  }

  /** Fetch a file's content at a given git ref (branch, tag, or SHA). */
  async getFileContent(path: string, ref: string): Promise<string | null> {
    switch (this.meta.provider) {
      case 'gitlab':
        return fetchGitLabFileContent(
          this.meta.host ?? 'gitlab.com',
          this.projectPath!,
          path,
          ref,
          this.token,
        );
      case 'bitbucket':
        return fetchBitbucketFileContent(
          this.meta.owner,
          this.meta.repo,
          path,
          ref,
          this.token,
        );
      case 'azuredevops':
        return fetchAzureDevOpsFileContent(
          this.meta.owner,
          this.meta.repo,
          path,
          ref,
          this.token,
        );
      default:
        return fetchGitHubFileContent(
          this.meta.owner,
          this.meta.repo,
          path,
          ref,
          this.token,
        );
    }
  }

  async postComment(number: number, body: string): Promise<void> {
    if (!this.token) throw new Error('Token required for posting comments');
    const taggedBody = body + ATTRIBUTION_FOOTER;
    switch (this.meta.provider) {
      case 'gitlab':
        await postGitLabMRComment(
          this.meta.host ?? 'gitlab.com',
          this.projectPath!,
          number,
          this.token,
          taggedBody,
        );
        return;
      case 'bitbucket':
        await postBitbucketPRComment(
          this.meta.owner,
          this.meta.repo,
          number,
          this.token,
          taggedBody,
        );
        return;
      case 'azuredevops':
        await postAzureDevOpsPRComment(
          this.meta.owner,
          this.meta.repo,
          number,
          this.token,
          taggedBody,
        );
        return;
      default:
        await postGitHubPRComment(
          this.meta.owner,
          this.meta.repo,
          number,
          this.token,
          taggedBody,
        );
    }
  }
}

/** Parse a repo URL into RepoMeta, or null if unrecognized. */
export function parseRepoUrl(url: string): RepoMeta | null {
  const gh = parseGitHubUrl(url);
  if (gh) return { provider: 'github', owner: gh.owner, repo: gh.repo };

  const gl = parseGitLabUrl(url);
  if (gl)
    return {
      provider: 'gitlab',
      owner: gl.namespace,
      repo: gl.project,
      host: gl.host,
    };

  const bb = parseBitbucketUrl(url);
  if (bb)
    return {
      provider: 'bitbucket',
      owner: bb.workspace,
      repo: bb.repo,
    };

  const ado = parseAzureDevOpsUrl(url);
  if (ado)
    return {
      provider: 'azuredevops',
      owner: `${ado.org}/${ado.project}`,
      repo: ado.repo,
      host: ado.host,
      project: ado.project,
    };

  return null;
}
