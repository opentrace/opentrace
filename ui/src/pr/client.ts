/**
 * Unified PR/MR client that dispatches to GitHub or GitLab APIs.
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
import { parseGitHubUrl } from '../runner/browser/loader/github';
import { parseGitLabUrl } from '../runner/browser/loader/gitlab';

const ATTRIBUTION_FOOTER =
  '\n\n---\n*Generated via [OpenTrace](https://oss.opentrace.ai)*';

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
    if (this.meta.provider === 'gitlab') {
      return fetchGitLabMRs(
        this.meta.host ?? 'gitlab.com',
        this.projectPath!,
        this.token,
      );
    }
    return fetchGitHubPRs(this.meta.owner, this.meta.repo, this.token);
  }

  async getPRDetail(number: number): Promise<PRDetail> {
    if (this.meta.provider === 'gitlab') {
      return fetchGitLabMRDetail(
        this.meta.host ?? 'gitlab.com',
        this.projectPath!,
        number,
        this.token,
      );
    }
    return fetchGitHubPRDetail(
      this.meta.owner,
      this.meta.repo,
      number,
      this.token,
    );
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
    if (this.meta.provider === 'gitlab') {
      // GitLab doesn't have a review API — post as a comment
      await postGitLabMRComment(
        this.meta.host ?? 'gitlab.com',
        this.projectPath!,
        number,
        this.token,
        taggedBody,
      );
      return;
    }
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

  /** Fetch a file's content at a given git ref (branch, tag, or SHA). */
  async getFileContent(path: string, ref: string): Promise<string | null> {
    if (this.meta.provider === 'gitlab') {
      return fetchGitLabFileContent(
        this.meta.host ?? 'gitlab.com',
        this.projectPath!,
        path,
        ref,
        this.token,
      );
    }
    return fetchGitHubFileContent(
      this.meta.owner,
      this.meta.repo,
      path,
      ref,
      this.token,
    );
  }

  async postComment(number: number, body: string): Promise<void> {
    if (!this.token) throw new Error('Token required for posting comments');
    const taggedBody = body + ATTRIBUTION_FOOTER;
    if (this.meta.provider === 'gitlab') {
      await postGitLabMRComment(
        this.meta.host ?? 'gitlab.com',
        this.projectPath!,
        number,
        this.token,
        taggedBody,
      );
      return;
    }
    await postGitHubPRComment(
      this.meta.owner,
      this.meta.repo,
      number,
      this.token,
      taggedBody,
    );
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

  return null;
}
