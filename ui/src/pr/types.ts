/** PR/MR data types shared across GitHub and GitLab clients. */

export interface PRSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  url: string;
  created_at: string;
  updated_at: string;
  base_branch: string;
  head_branch: string;
  additions: number;
  deletions: number;
  draft?: boolean;
}

export interface PRFileDiff {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
  previous_path?: string;
}

export interface PRDetail extends PRSummary {
  body: string;
  files: PRFileDiff[];
  comments_count: number;
  review_comments_count: number;
  mergeable?: boolean;
}

export interface PRReviewComment {
  body: string;
  path?: string;
  line?: number;
  side?: 'LEFT' | 'RIGHT';
}

export interface RepoMeta {
  provider: 'github' | 'gitlab' | 'bitbucket' | 'azuredevops';
  owner: string;
  repo: string;
  host?: string;
  /** Azure DevOps project name (org/project/repo triple). */
  project?: string;
}
